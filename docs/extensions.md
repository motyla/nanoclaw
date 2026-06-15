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
```

`groupFolder` is the agent-group directory name under `groups/` (e.g. `dm-with-moty`). Extensions use it to locate their per-group SQLite databases.

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
