# telegram-idea-bridge

A personal Telegram bot that acts as a bridge between quick ideas and useful
output: it captures notes into a vault, drafts documents, checks Indonesian
tax/finance regulations, and relays broadcasts to WhatsApp — all from chat
commands.

## Commands

| Command | What it does |
| --- | --- |
| `/start` | Show what this bot does |
| `/list` | List your most recent vault entries |
| `/search <query>` | Search your vault |
| `/get <n>` | Open a result by number |
| `/pdf <link or title>` | Capture a PDF |
| `/calc <expr or word problem>` | Calculate (text or a photo of the problem) |
| `/summarize <text \| note n>` | Summarize text or a vault note |
| `/news <topic>` | News digest |
| `/schedule <freeform event text>` | Add an event to your calendar (Radicale/CalDAV) and send a `.ics` file |
| `/doc <template or "default"> \| <brief>` | Draft a Word document |
| `/excel <template or "default"> \| <brief>` | Draft an Excel table |
| `/templates` | List your `.docx`/`.xlsx` templates and their placeholders |
| `/regcheck` | Check now for new Kemenkeu/DJP regulations |
| `/banner <keyword>` | Sample stock images for a banner/design idea |
| `/grammar <text>` | Fix grammar |
| `/promptgen <goal>` | Generate a prompt |
| `/broadcast <brief>` | Draft a WhatsApp broadcast |
| `/send` | Send the last `/broadcast` draft to your WhatsApp group |
| `/todo <item>` / `/todo list` / `/todo done <n>` | Manage a to-do list |
| `/models` | List available models for overrides |
| `/help` | Show available commands |

Regulation checks also run automatically every day at 07:00 WIB.

## Setup

```bash
npm install
```

Create a `.env` file in the project root with:

```
TELEGRAM_BOT_TOKEN=
TELEGRAM_ALLOWED_CHAT_ID=
WHATSAPP_GROUP_ID=

GEMINI_API_KEY=
GROQ_API_KEY=
OLLAMA_CLOUD_API_KEY=
OPENROUTER_API_KEY=
PEXELS_API_KEY=

RADICALE_URL=
RADICALE_USER=
RADICALE_PASSWORD=
RADICALE_CALENDAR=
```

`TELEGRAM_ALLOWED_CHAT_ID` restricts the bot to a single chat.

`/schedule` pushes events to a local [Radicale](https://radicale.org/)
CalDAV server rather than Google Calendar — no OAuth, no 7-day token
expiry. Radicale itself lives outside this repo (`~/radicale`, a Python
venv + config, autostarted via a Startup-folder script) and is treated as
a cross-project dependency, the same way `lib/whatsapp.js` talks to the
separate hermes WhatsApp bridge process. If `/schedule` fails to add to
the calendar, that process needs restarting; the `.ics` file it also
sends still works standalone in any calendar app.

## Running

```bash
node bridge.js
```

On Windows, `run-bridge.vbs` / `run-bridge.cmd` run the bot without a
console window and are wired up as the `TelegramIdeaBridge` Scheduled Task,
which restarts it automatically if it exits.

## Project layout

- `bridge.js` — Telegram polling loop, command routing, scheduled jobs
- `lib/` — model providers, document generation, regulation monitor,
  to-do list, vault sync, Telegram API wrapper
- `check.js` — regulation-check fetch/parse logic
- `test-menu-args.js` — self-check for the command-menu prompt flow
