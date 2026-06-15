/**
 * Telegram channel adapter (v2) — uses Chat SDK bridge, with a pairing
 * interceptor wrapped around onInbound to verify chat ownership before
 * registration. See telegram-pairing.ts for the why.
 *
 * Host-side commands can be registered via registerTelegramExtension().
 * Extensions are loaded by src/index.ts before initChannelAdapters() runs,
 * so the command map is fully populated before the factory is called.
 */
import { createTelegramAdapter } from '@chat-adapter/telegram';
import path from 'node:path';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { createMessagingGroup, getMessagingGroupByPlatform, updateMessagingGroup } from '../db/messaging-groups.js';
import { grantRole, hasAnyOwner } from '../modules/permissions/db/user-roles.js';
import { upsertUser } from '../modules/permissions/db/users.js';
import { createChatSdkBridge, type ReplyContext } from './chat-sdk-bridge.js';
import { sanitizeTelegramLegacyMarkdown } from './telegram-markdown-sanitize.js';
import { registerChannelAdapter } from './channel-registry.js';
import type { ChannelAdapter, ChannelSetup, InboundMessage } from './adapter.js';
import { tryConsume } from './telegram-pairing.js';

// ── Extension API ────────────────────────────────────────────────────────────

export type CommandHandler = (token: string, platformId: string) => Promise<void>;

export type TelegramExtension = {
  /** Return command Map entries given the resolved group folder (may be ''). */
  commands: (groupFolder: string) => Array<[string, CommandHandler]>;
  /** Optional commands to register with Telegram's / autocomplete. */
  botCommands?: () => Array<{ command: string; description: string }>;
};

const _extensions: TelegramExtension[] = [];

export function registerTelegramExtension(ext: TelegramExtension): void {
  _extensions.push(ext);
}

// ── Telegram send helper (exported for use by extensions) ────────────────────

/** Send a plain-text message to a Telegram chat. Best-effort. */
export async function sendTelegramMessage(token: string, platformId: string, text: string): Promise<void> {
  const chatId = platformId.split(':').slice(1).join(':');
  if (!chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch (err) {
    log.warn('Telegram send failed', { err });
  }
}

// ── Internal utilities ───────────────────────────────────────────────────────

async function withRetry<T>(fn: () => Promise<T>, label: string, maxAttempts = 5): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts) break;
      const delay = Math.min(16000, 1000 * 2 ** (attempt - 1));
      log.warn('Telegram setup failed, retrying', { label, attempt, delayMs: delay, err });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractReplyContext(raw: Record<string, any>): ReplyContext | null {
  if (!raw.reply_to_message) return null;
  const reply = raw.reply_to_message;
  return {
    text: reply.text || reply.caption || '',
    sender: reply.from?.first_name || reply.from?.username || 'Unknown',
  };
}

async function fetchBotUsername(token: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const json = (await res.json()) as { ok: boolean; result?: { username?: string } };
    return json.ok ? (json.result?.username ?? null) : null;
  } catch (err) {
    log.warn('Telegram getMe failed', { err });
    return null;
  }
}

function isGroupPlatformId(platformId: string): boolean {
  const id = platformId.split(':').pop() ?? '';
  return id.startsWith('-');
}

interface InboundFields {
  text: string;
  authorUserId: string | null;
}

function readInboundFields(message: InboundMessage): InboundFields {
  if (message.kind !== 'chat-sdk' || !message.content || typeof message.content !== 'object') {
    return { text: '', authorUserId: null };
  }
  const c = message.content as { text?: string; author?: { userId?: string } };
  return { text: c.text ?? '', authorUserId: c.author?.userId ?? null };
}

async function sendPairingConfirmation(token: string, platformId: string): Promise<void> {
  const chatId = platformId.split(':').slice(1).join(':');
  if (!chatId) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: 'Pairing success! Head back to the NanoClaw installer to finish setup.',
      }),
    });
    if (!res.ok) {
      log.warn('Telegram pairing confirmation non-OK', { status: res.status });
    }
  } catch (err) {
    log.warn('Telegram pairing confirmation failed', { err });
  }
}

function createPairingInterceptor(
  botUsernamePromise: Promise<string | null>,
  hostOnInbound: ChannelSetup['onInbound'],
  token: string,
): ChannelSetup['onInbound'] {
  return async (platformId, threadId, message) => {
    try {
      const botUsername = await botUsernamePromise;
      if (!botUsername) {
        hostOnInbound(platformId, threadId, message);
        return;
      }
      const { text, authorUserId } = readInboundFields(message);
      if (!text) {
        hostOnInbound(platformId, threadId, message);
        return;
      }
      const consumed = await tryConsume({
        text,
        botUsername,
        platformId,
        isGroup: isGroupPlatformId(platformId),
        adminUserId: authorUserId,
      });
      if (!consumed) {
        hostOnInbound(platformId, threadId, message);
        return;
      }
      const existing = getMessagingGroupByPlatform('telegram', platformId);
      if (existing) {
        updateMessagingGroup(existing.id, {
          is_group: consumed.consumed!.isGroup ? 1 : 0,
        });
      } else {
        createMessagingGroup({
          id: `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          channel_type: 'telegram',
          platform_id: platformId,
          name: consumed.consumed!.name,
          is_group: consumed.consumed!.isGroup ? 1 : 0,
          unknown_sender_policy: 'strict',
          created_at: new Date().toISOString(),
        });
      }

      const pairedUserId = `telegram:${consumed.consumed!.adminUserId}`;
      upsertUser({
        id: pairedUserId,
        kind: 'telegram',
        display_name: null,
        created_at: new Date().toISOString(),
      });

      let promotedToOwner = false;
      if (!hasAnyOwner()) {
        grantRole({
          user_id: pairedUserId,
          role: 'owner',
          agent_group_id: null,
          granted_by: null,
          granted_at: new Date().toISOString(),
        });
        promotedToOwner = true;
      }

      log.info('Telegram pairing accepted — chat registered', {
        platformId,
        pairedUser: pairedUserId,
        promotedToOwner,
        intent: consumed.intent,
      });

      await sendPairingConfirmation(token, platformId);
    } catch (err) {
      log.error('Telegram pairing interceptor error', { err });
      hostOnInbound(platformId, threadId, message);
    }
  };
}

async function registerBotCommands(
  token: string,
  commands: Array<{ command: string; description: string }>,
): Promise<void> {
  if (!commands.length) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commands }),
    });
  } catch (err) {
    log.warn('Telegram setMyCommands failed', { err });
  }
}

function createHostCommandInterceptor(
  hostOnInbound: ChannelSetup['onInbound'],
  token: string,
  commands: Map<string, CommandHandler>,
): ChannelSetup['onInbound'] {
  return async (platformId, threadId, message) => {
    const { text } = readInboundFields(message);
    const cmd = text.trim().split(/\s+/)[0]?.toLowerCase().split('@')[0];
    if (!cmd || !commands.has(cmd) || !getMessagingGroupByPlatform('telegram', platformId)) {
      hostOnInbound(platformId, threadId, message);
      return;
    }
    await commands.get(cmd)!(token, platformId);
  };
}

// ── Adapter registration ─────────────────────────────────────────────────────

registerChannelAdapter('telegram', {
  factory: () => {
    const env = readEnvFile(['TELEGRAM_BOT_TOKEN', 'NANOCLAW_GROUP_FOLDER']);
    if (!env.TELEGRAM_BOT_TOKEN) return null;
    const token = env.TELEGRAM_BOT_TOKEN;
    const groupFolder = env.NANOCLAW_GROUP_FOLDER ?? '';

    const telegramAdapter = createTelegramAdapter({
      botToken: token,
      mode: 'polling',
    });
    const bridge = createChatSdkBridge({
      adapter: telegramAdapter,
      concurrency: 'concurrent',
      extractReplyContext,
      supportsThreads: false,
      transformOutboundText: sanitizeTelegramLegacyMarkdown,
      maxTextLength: 4000,
    });

    const botUsernamePromise = fetchBotUsername(token);

    const wrapped: ChannelAdapter = {
      ...bridge,
      resolveChannelName: async (platformId: string) => {
        const chatId = platformId.split(':').slice(1).join(':');
        if (!chatId) return null;
        try {
          const res = await fetch(`https://api.telegram.org/bot${token}/getChat`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId }),
          });
          const data = (await res.json()) as { ok?: boolean; result?: { title?: string } };
          return data.ok ? (data.result?.title ?? null) : null;
        } catch {
          return null;
        }
      },
      async setup(hostConfig: ChannelSetup) {
        const extCommands = _extensions.flatMap((e) => e.commands(groupFolder));
        const commands = new Map<string, CommandHandler>(extCommands);

        const extBotCommands = _extensions.flatMap((e) => e.botCommands?.() ?? []);
        void registerBotCommands(token, extBotCommands);

        const withPairing = createPairingInterceptor(botUsernamePromise, hostConfig.onInbound, token);
        const intercepted: ChannelSetup = {
          ...hostConfig,
          onInbound: createHostCommandInterceptor(withPairing, token, commands),
        };
        return withRetry(() => bridge.setup(intercepted), 'bridge.setup');
      },
    };
    return wrapped;
  },
});
