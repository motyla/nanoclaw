# HealthBot — Garmin Integration for NanoClaw

This is a personal fork of NanoClaw (`myhealthbot` branch) that adds a
**HealthBot** Telegram agent with full access to Garmin Connect fitness data via
a local SQLite database. All health queries are answered from the local DB —
no external API calls, no Strava, no live Garmin Connect requests.

---

## What this fork adds

| Area | Change |
|------|--------|
| **Telegram adapter** | 14 host-side slash commands (instant, zero AI cost) |
| **Garmin sync** | Python venv + `garmin-health-data` package, `/sync` command |
| **Agent instructions** | `CLAUDE.local.md` — HealthBot persona + strict SQLite-only rule |
| **Query helper** | `query.js` — bun SQLite wrapper mounted inside the agent container |

All changes live under `setup/garmin/` and `src/channels/telegram.ts`. The
upstream codebase is otherwise untouched and can be rebased cleanly.

---

## Prerequisites

- NanoClaw v2 cloned from this fork (`myhealthbot` branch), built, and running
- Telegram bot token in `.env` (`TELEGRAM_BOT_TOKEN=...`)
- Garmin Connect account
- Python 3 available on the host (`python3 -m venv`)

---

## First-time setup

### 1. Build and start the service

```bash
pnpm install
pnpm run build
./container/build.sh          # builds nanoclaw-agent image (~5 min first time)

# Linux (systemd)
systemctl --user start nanoclaw
```

### 2. Add Garmin credentials to `.env`

Copy the example vars into your `.env` (which is gitignored):

```bash
cat setup/garmin/env.example
```

Add to `.env`:

```
GARMIN_EMAIL=you@example.com
GARMIN_PASSWORD=yourpassword
NANOCLAW_GROUP_FOLDER=dm-with-moty   # from: ncl groups list
NANOCLAW_GROUP_ID=ag-...             # from: ncl groups list (used to pin model)
MODEL=haiku
```

### 3. Bootstrap the Telegram agent

If you haven't already run `/init-first-agent`, do it now:

```
/init-first-agent
```

Follow the prompts — pick Telegram, enter your user ID and name. The agent will
send a welcome DM when it's ready.

### 4. Run the Garmin install script

```bash
bash setup/garmin/install.sh
```

This:
- Creates a Python venv at `setup/garmin/.venv`
- Installs `garmin-health-data` (via `requirements.txt`)
- Deploys `query.js` into the agent group folder
- Appends the Garmin instructions to `CLAUDE.local.md`
- Installs `~/.local/bin/garmin-sync`

### 5. Authenticate with Garmin (one-time)

```bash
source .env
setup/garmin/.venv/bin/garmin auth \
  --email "$GARMIN_EMAIL" \
  --password "$GARMIN_PASSWORD"
```

This triggers an MFA flow. Follow the prompts. Credentials are saved to the
venv's keyring and are not stored in plaintext.

### 6. First sync

```bash
garmin-sync
```

Or send `/sync` in Telegram. The DB (`groups/<folder>/garmin_data.db`) is
populated with historical activity, sleep, and health data.

---

## Telegram commands

All commands are intercepted on the **host** — they never reach the agent
container. Replies are instant.

### Running

| Command | What it shows |
|---------|---------------|
| `/lastrun` | Most recent run: date, distance, pace, avg HR |
| `/run7avg` | Average of last 7 runs: distance, pace, HR |
| `/run30avg` | Average of last 30 runs: distance, pace, HR |
| `/runweek` | Last 7 calendar days: total km, run count, avg pace |
| `/runstreak` | Current consecutive-day running streak |
| `/prs` | Personal records: 1 km, 1 mile, 5 km, 10 km |

### Sleep & recovery

| Command | What it shows |
|---------|---------------|
| `/lastsleep` | Last night: hours, score, deep/REM/light, HRV, RHR |
| `/sleepweek` | Last 7 nights: hours, score, HRV per night |
| `/readiness` | Training readiness score, sleep component, 7-day HRV avg |
| `/battery` | Latest body battery level with bar chart |

### Daily stats

| Command | What it shows |
|---------|---------------|
| `/steps` | Today's step count vs 10,000 goal |
| `/stress` | Today's avg and peak stress level |
| `/vo2max` | Current VO2 max estimate with trend arrow |
| `/sync` | Pulls latest Garmin data (~1 min) |

Commands appear in Telegram's autocomplete menu when you type `/` — the bot
registers them via `setMyCommands` on every startup.

---

## Asking the agent (natural language)

The agent reads the same SQLite DB for open-ended questions. Example queries:

- *"Show my last run"* → agent runs `query.js` against `activity` table
- *"Compare /lastrun with /run7avg"* → use both commands, paste into chat
- *"How did I sleep this week?"* → agent queries `sleep` table
- *"Should I do a hard run today?"* → agent combines `/readiness` + `/battery`
- *"What's my fitness trend over the last month?"* → agent queries `vo2_max` + `activity`

**Strict rule:** the agent is instructed to **only** use the local SQLite DB for
any health, fitness, sleep, or sports question. It will not attempt to connect to
Strava, Garmin Connect API, or any external service.

---

## Architecture

```
Telegram message
       │
       ▼
  telegram.ts (host)
       │
       ├─ /sync, /lastrun, … ──► query garmin_data.db directly
       │                          reply via Telegram API
       │
       └─ everything else ──────► NanoClaw router → agent container
                                   agent reads garmin_data.db via query.js
                                   agent replies via outbound.db
```

**Key files:**

| File | Purpose |
|------|---------|
| `src/channels/telegram.ts` | Host-side command interceptor + all command handlers |
| `setup/garmin/install.sh` | One-time setup: venv, query.js, CLAUDE.local.md, garmin-sync |
| `setup/garmin/garmin-sync` | Template for `~/.local/bin/garmin-sync` (paths filled by install.sh) |
| `setup/garmin/agent/query.js` | Bun SQLite wrapper — the agent runs this to query the DB |
| `setup/garmin/agent/garmin-instructions.md` | Template appended to `CLAUDE.local.md` |
| `groups/<folder>/garmin_data.db` | Live Garmin data (gitignored, ~180 MB) |
| `groups/<folder>/CLAUDE.local.md` | HealthBot persona + SQLite-only rule (gitignored) |

---

## Adding a new host command

1. Add a handler function in `src/channels/telegram.ts`:

```typescript
async function runMyCommand(token: string, platformId: string, garminDbPath: string): Promise<void> {
  const row = queryGarminDb<{ ... }>(garminDbPath, `SELECT ...`);
  await sendSyncMessage(token, platformId, `...`);
}
```

2. Add it to the `commands` Map in `setup()`:

```typescript
['/mycommand', (t, p) => runMyCommand(t, p, garminDbPath)],
```

3. Add it to the `registerBotCommands` list (for Telegram autocomplete):

```typescript
{ command: 'mycommand', description: 'What it does' },
```

4. Build and restart:

```bash
pnpm run build && systemctl --user restart nanoclaw
```

---

## Keeping the DB fresh

`/sync` re-fetches the last 3 days (plus today). Run it manually or wire a
cron job:

```bash
# add to crontab -e
0 6 * * * /home/youruser/.local/bin/garmin-sync >> /tmp/garmin-sync.log 2>&1
```

---

## Troubleshooting

### Agent ignores the SQLite instructions / tries Strava

This usually means the agent is resuming a stale session that pre-dates the
`CLAUDE.local.md` instructions. Fix:

```bash
# Find the session dir
ls data/v2-sessions/

# Clear the continuation (forces fresh session on next message)
pnpm exec tsx scripts/q.ts "data/v2-sessions/<ag-id>/<sess-id>/outbound.db" \
  "DELETE FROM session_state"

# Delete the transcript
rm -f "data/v2-sessions/<ag-id>/.claude-shared/projects/-workspace-agent/<uuid>.jsonl"
```

The next message will start a fresh session that loads `CLAUDE.local.md` from scratch.

### `/sync` reports auth error

Re-authenticate:

```bash
source .env
setup/garmin/.venv/bin/garmin auth \
  --email "$GARMIN_EMAIL" --password "$GARMIN_PASSWORD"
```

### Commands don't appear in Telegram autocomplete

The bot registers commands on startup. Restart the service:

```bash
systemctl --user restart nanoclaw
```

Then type `/` in the chat — it may take a few seconds for Telegram to refresh.

### Host commands return "No data — try /sync"

Either the DB hasn't been synced yet, or `NANOCLAW_GROUP_FOLDER` is missing
from `.env`. Check:

```bash
grep NANOCLAW_GROUP_FOLDER .env
ls groups/$(grep NANOCLAW_GROUP_FOLDER .env | cut -d= -f2)/garmin_data.db
```
