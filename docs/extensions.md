# Host-command extensions

A lightweight plugin system that lets a separate private repo add Telegram slash commands without touching the fork.

## How it works

At startup, `src/index.ts` scans `src/extensions/` for `.js` files (`.ts` in dev mode). Each file is dynamically imported and expected to call `registerTelegramExtension()` from `src/channels/telegram.ts`. The Telegram adapter collects all registered commands before opening the bot connection.

`src/extensions/` is listed in `.gitignore` — it is never tracked in the fork. A companion private repo owns the actual command files and copies them in via a deploy script before building.

## Extension API

```typescript
// src/channels/telegram.ts

type CommandHandler = (token: string, platformId: string) => Promise<void>;

type TelegramExtension = {
  commands: (groupFolder: string) => Array<[string, CommandHandler]>;
  botCommands?: () => Array<{ command: string; description: string }>;
};

function registerTelegramExtension(ext: TelegramExtension): void;
function sendTelegramMessage(token: string, platformId: string, text: string): Promise<void>;

// Re-exported from src/chart-api.ts:
function sendChart(token: string, platformId: string, spec: TopLevelSpec, caption?: string): Promise<void>;
```

`groupFolder` is the agent-group directory name under `groups/` (e.g. `dm-with-moty`). Extensions use it to locate their per-group SQLite databases.

## Chart API

`src/chart-api.ts` is a generic chart pipeline available to any extension:

```typescript
import { specToPng, sendChart } from '../chart-api.js';
// or via the telegram re-export:
import { sendChart } from '../channels/telegram.js';
```

- **`specToPng(spec: TopLevelSpec): Promise<Buffer>`** — compiles a Vega-Lite spec to a PNG buffer (800px wide). Handles font loading from system font dirs so axis labels and legends render correctly.
- **`sendChart(token, platformId, spec, caption?)`** — renders the spec and sends it as a Telegram photo message.

The chart pipeline uses `vega` + `vega-lite` for rendering and `@resvg/resvg-js` for SVG→PNG conversion. Font dirs are probed at startup (`/usr/share/fonts`, `~/.local/share/fonts`, etc.) — install `fonts-liberation` on the host if charts show no text.

## Standalone notifier pattern

For automated proactive messages (not triggered by a user command), the companion repo can ship a standalone `notifier.ts` alongside its extensions. `deploy.sh` copies it to `src/garmin-notifier.ts` (gitignored in the fork), which compiles to `dist/garmin-notifier.js` and is invoked by a systemd timer after each sync.

## Minimal example

```typescript
// src/extensions/mybot.ts  (in the private repo, deployed via deploy.sh)
import { registerTelegramExtension, sendTelegramMessage } from '../channels/telegram.js';

registerTelegramExtension({
  commands: (groupFolder) => [
    ['/hello', async (token, platformId) => {
      await sendTelegramMessage(token, platformId, 'Hello!');
    }],
  ],
  botCommands: () => [
    { command: 'hello', description: 'Say hello' },
  ],
});
```
