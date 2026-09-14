# Environment — this machine

Recorded 2026-09-14 on host `PC240737BGU15` by actually running the commands
below (not inferred). Re-run and update this file if the box is rebuilt or
any of these paths/services move.

## Node / npm

```
$ node --version
v24.11.1
$ npm --version
11.6.2
```

## Claude Code CLI

```
$ where claude
C:\Users\958634185\.local\bin\claude.exe
```

Native `.exe`, not an npm `.cmd` shim — `.env` does **not** need
`CLAUDE_BIN`/`CLAUDE_SHELL=1` on this machine; `execFile('claude', ...)` in
`lib/claude.js` resolves it via PATH as-is.

Stdin verified working:

```
$ echo "The quick brown fox jumps over the lazy dog near the riverbank at dawn." | claude -p "summarise this in 5 words" --output-format json
{... "result":"Fox jumps over lazy dog.", "is_error":false, "subtype":"success", ...}
```

`-p` reads the prompt from stdin and `--output-format json` returns a JSON
object with a `result` field — confirms the stdin-piping fix in
`docs/ANALYSIS.md` (bug #1) is viable on this install.

## Filesystem paths (all verified to exist)

| What | Path |
|---|---|
| Repo checkout | `C:\Users\958634185\telegram-idea-bridge` |
| OpenKnowledge vault | `C:\Users\958634185\openknowledge` (default; no `OPENKNOWLEDGE_DIR` override set in `.env`) |
| Obsidian vault | `C:\Users\958634185\obsidian-vault` (hardcoded in `lib/vaultsync.js`) |
| OneDrive "Bot Templates" | `C:\Users\958634185\OneDrive - Kemenkeu\Bot Templates` |
| OneDrive "Bot Output" | `C:\Users\958634185\OneDrive - Kemenkeu\Bot Output` |

(OneDrive paths are hardcoded in `lib/docgen.js`, not env-configurable.)

## External services (right now)

| Service | Result |
|---|---|
| Radicale (CalDAV, `RADICALE_URL` from `.env`) | HTTP 302 — up (redirect, expected for the root path) |
| hermes WhatsApp bridge (`http://127.0.0.1:3000`) | HTTP 404 on `/` — process is up; the real endpoint is `POST /send` (see `lib/whatsapp.js`), which has no GET/root route |

## Scheduled Task

```
$ schtasks /query /tn TelegramIdeaBridge /v /fo list
```

| Field | Value |
|---|---|
| TaskName | `\TelegramIdeaBridge` |
| Status | Running |
| Task To Run | `wscript.exe "C:\Users\958634185\telegram-idea-bridge\run-bridge.vbs"` |
| Start In | `C:\Users\958634185\telegram-idea-bridge` |
| Logon Mode | Interactive only |
| Schedule Type | At logon time |
| Run As User | `958634185` |
| Last Run Time | 11-Sep-26 5:16:39 PM |
| Last Result | 267009 (still running when queried) |

## `.env` keys currently set (names only — values withheld)

```
TELEGRAM_BOT_TOKEN
TELEGRAM_ALLOWED_CHAT_ID
OPENROUTER_API_KEY
GEMINI_API_KEY
OLLAMA_CLOUD_API_KEY
GROQ_API_KEY
PEXELS_API_KEY
WHATSAPP_GROUP_ID
RADICALE_URL
RADICALE_USER
RADICALE_PASSWORD
RADICALE_CALENDAR
```

Not yet set: any `GOOGLE_*`, `MS_*`, `IMAP_*`, `FINANCE_SHEET_ID`,
`GOOGLE_TASKS_LIST`, `DIGEST_AUTO_CALENDAR`, `INBOX_EVERY_HOURS`,
`GROQ_WHISPER_MODEL`, `CLAUDE_BIN`, `CLAUDE_SHELL` — all called for by
`docs/V2-SPEC.md` §7 but not yet configured on this box.
