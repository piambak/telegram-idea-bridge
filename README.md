# telegram-idea-bridge

A personal Telegram bot that acts as a bridge between quick ideas and useful
output: it captures notes into a vault, drafts documents, checks Indonesian
tax/finance regulations, tracks spending, reminds you of recurring bills,
digests your inbox, and relays broadcasts to WhatsApp — all from chat
commands. Single-user, plain Node, no build step (see `CLAUDE.md`).

## Commands

| Command | What it does |
| --- | --- |
| `/start` | Show what this bot does |
| `?<question>` or `/ask <question>` | Answer only, never saved — remembers the last 3 turns |
| `/list` | List your most recent vault entries |
| `/search <query>` | Search your vault |
| `/get <n>` | Open a result by number (from `/list` or `/search`) |
| `/pdf <link or title>` | Capture a PDF into the vault (or just send the PDF file) |
| `/calc <expr or word problem>` | Calculate (text, or send a photo of the problem) |
| `/summarize <text \| note n>` | Summarize pasted text or a vault note |
| `/news <topic>` | Recent news digest |
| `/schedule <freeform event text>` | Add an event to your calendar (Radicale/CalDAV) and send a `.ics` file |
| `/confirm` | Confirm the last `/schedule` event when its date/time was uncertain |
| `/doc <template or "default"> \| <brief>` | Draft a Word document into OneDrive |
| `/excel <template or "default"> \| <brief>` | Draft an Excel table into OneDrive |
| `/templates` | List your `.docx`/`.xlsx` templates and their placeholders |
| `/regcheck` | Check now for new Kemenkeu/DJP regulations (also runs automatically, see below) |
| `/banner <keyword>` | Sample stock images for a banner/design idea |
| `/grammar <text>` | Fix grammar and clarity |
| `/promptgen <goal>` | Generate a ready-to-use AI prompt |
| `/broadcast <brief>` | Draft a WhatsApp broadcast, then use the buttons to send or redraft |
| `/todo <item>` / `/todo list` / `/todo done <n>` | Quick to-do list, with ✅ buttons |
| `/spend <description + amount>` | Log a transaction (or send a receipt photo captioned `/spend`) — confirm card + category keypad, unless `SPEND_CONFIRM=0` |
| `/report` / `/report YYYY-MM` | Income/expense/net, category breakdown, top merchants, delta vs. previous month (also sent automatically, see below) |
| `/remind <text>` | Add a recurring reminder (e.g. "bayar listrik setiap tanggal 20, ingatkan 3 hari sebelumnya") |
| `/remind list` / `done <n>` / `del <n>` / `check` | Manage reminders; `check` runs the daily tick on demand |
| `/status` | Which services are actually reachable right now (see below) |
| `/models` | List available models and how to override them per message |
| `/help` | Show the full command list |

Sending an idea with no leading `/` is enhanced and saved to the vault
directly (a low-confidence "is this really worth saving?" idea gets
`[💾 Simpan] [💬 Jawab saja] [🗑 Buang]` buttons instead). Documents, voice
notes, and photos are handled too — a photo with no caption asks whether
it's a receipt or a calculation.

## Scheduled jobs (WIB, all serialised against one shared mutex — see below)

| Time | Job |
| --- | --- |
| 07:00 | Regulation check (JDIH) |
| 07:15 | Reminder tick → Google Tasks + Telegram |
| 07:30 | Inbox digest (quiet if nothing new) |
| every `INBOX_EVERY_HOURS` h | Optional extra inbox digests |
| 08:00 on the 1st | Monthly finance report for the previous month |

Every scheduled job runs through the same mutex `lib/vaultsync.js` uses for
its own git commands (`vaultsync.serialized`), so an unattended job can
never race a vault sync — or another scheduled job — over the same working
tree or `.state/` files. Each job also catches its own errors and reports
them to Telegram rather than dying silently; nothing here can crash the
polling loop.

## `/status`

Run `/status` to see, for each of Groq, OpenRouter, Ollama Cloud, Gemini,
the Claude CLI, the Google token, the Microsoft token, IMAP, Radicale,
hermes (the WhatsApp bridge), and the vault mirror: reachable or not, and
the reason if not. These are real live checks (a minimal chat call, a
forced token refresh, an actual connection attempt) — not just "is the env
var set" — so a revoked token or a dead office-PC service shows up here.
This is the one command to run on the PC to see what's actually configured.

## Setup

```bash
npm install
```

Create a `.env` file in the project root. Only `TELEGRAM_BOT_TOKEN` and
`TELEGRAM_ALLOWED_CHAT_ID` are required — everything else is optional, and
each feature degrades to a clear "not configured" message (surfaced in
`/status`) instead of crashing when its keys are missing.

```
# Required
TELEGRAM_BOT_TOKEN=
TELEGRAM_ALLOWED_CHAT_ID=

# AI providers (fast tier tries Groq, then OpenRouter, then Ollama Cloud;
# Gemini is used separately for vision/receipts)
GROQ_API_KEY=
OPENROUTER_API_KEY=
OLLAMA_CLOUD_API_KEY=
GEMINI_API_KEY=
GROQ_WHISPER_MODEL=whisper-large-v3-turbo   # voice notes; this is the default

# Claude Code CLI (deep tier: /doc, long summaries/PDFs, calc-photo fallback)
CLAUDE_BIN=claude
CLAUDE_SHELL=0        # if `claude` is an npm .cmd shim on Windows: CLAUDE_BIN=<path>\claude.cmd CLAUDE_SHELL=1

# Google (Gmail readonly + Sheets + Tasks — one OAuth client, one refresh
# token; run `node setup-google.js`). See docs/SETUP-GOOGLE.md.
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# Microsoft (Outlook mail via Graph; run `node setup-outlook.js`). See
# docs/SETUP-OUTLOOK.md.
MS_CLIENT_ID=
MS_TENANT=organizations

# IMAP fallback mail provider (optional; needs `npm install imapflow mailparser`)
IMAP_HOST=
IMAP_PORT=993
IMAP_USER=
IMAP_PASSWORD=
IMAP_MAILBOX=INBOX

# Which mail providers the inbox digest pulls from
MAIL_PROVIDERS=gmail,outlook

# Finance ledger (Google Sheets — one spreadsheet, one tab per month)
FINANCE_SHEET_ID=
FINANCE_AUTO_LOG=1     # auto-log recognized bank/e-wallet emails during the digest
SPEND_CONFIRM=1        # 0 = skip the confirm card, save /spend and receipts immediately

# Reminders (Google Tasks)
GOOGLE_TASKS_LIST=Idea Bridge

# Inbox digest extras
DIGEST_AUTO_CALENDAR=1  # auto-push .ics meeting invites to Radicale
INBOX_EVERY_HOURS=0     # >0 adds an extra digest run every N hours, on top of 07:30

# Radicale (local CalDAV, replaces Google Calendar for /schedule)
RADICALE_URL=
RADICALE_USER=
RADICALE_PASSWORD=
RADICALE_CALENDAR=schedule

# WhatsApp broadcast (via the separate hermes bridge, localhost:3000)
WHATSAPP_GROUP_ID=

# Stock photos for /banner
PEXELS_API_KEY=
```

Runtime state (Telegram offset, dedup sets, pending button payloads,
reminders, mail cursors) lives in `.state/` (gitignored) — nothing under it
is ever committed. `OPENKNOWLEDGE_DIR`, `OBSIDIAN_VAULT_DIR`, `STATE_DIR`,
`GOOGLE_TOKEN_PATH`, and `MS_TOKEN_PATH` are path overrides most people
won't need to touch; they exist mainly so the test suite never points at
real data.

`/schedule` pushes events to a local [Radicale](https://radicale.org/)
CalDAV server rather than Google Calendar — no OAuth, no 7-day token
expiry. Radicale itself lives outside this repo (`~/radicale`, a Python
venv + config, autostarted via a Startup-folder script) and is treated as
a cross-project dependency, the same way `lib/whatsapp.js` talks to the
separate hermes WhatsApp bridge process. Both are office-PC-only; `/status`
is how you tell whether either is actually up.

## Running

```bash
node bridge.js
```

On Windows, `run-bridge.vbs` / `run-bridge.cmd` run the bot without a
console window and are wired up as the `TelegramIdeaBridge` Scheduled Task,
which restarts it automatically if it exits.

## Testing

```bash
npm test          # node --test + check.js + test-menu-args.js + test-smoke.js
node check.js      # registry shape, retry policy, HTML-safety lint
node test-menu-args.js   # self-check for the command-menu prompt flow
node test-smoke.js       # drives messages/buttons through the real bridge.js with stubbed Telegram/models
```

Everything above runs fully offline — no network calls, no dependency on
the external services (Google/Microsoft/Radicale/hermes/IMAP) being up.

## Project layout

- `bridge.js` — Telegram polling loop, command routing, scheduled jobs
- `lib/` — model providers, finance/reminders/digest logic, Google/Microsoft
  mail and OAuth clients, document generation, regulation monitor, to-do
  list, vault sync, Telegram API wrapper, `/status` checks
- `.claude/skills/` — every model prompt, read at runtime (`lib/skills.js`)
- `docs/` — `ANALYSIS.md` (bug list/audit), `V2-SPEC.md` (target design),
  `SETUP-GOOGLE.md` / `SETUP-OUTLOOK.md` (OAuth setup walkthroughs)
- `check.js` — regulation-check fetch/parse logic plus the offline self-check
- `test-menu-args.js` — self-check for the command-menu prompt flow
- `test-smoke.js` — end-to-end smoke test against the real `bridge.js`
