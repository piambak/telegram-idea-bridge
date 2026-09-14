# telegram-idea-bridge

Single-user Telegram bot, "second brain" front-end into an OpenKnowledge vault.
See `docs/ANALYSIS.md` (bug list, current-state audit) and `docs/V2-SPEC.md`
(target design for this branch) before making non-trivial changes.

## Runtime constraints

- Plain Node, CommonJS (`require`/`module.exports`). No TypeScript, no build
  step. Keep dependencies minimal — check before adding a package.
- Deploys to a Windows 10/11 office PC, started by a Scheduled Task named
  `TelegramIdeaBridge`. Test process-spawning code with that in mind.
- **Windows caps a process command line at 32,767 chars.** Never pass a
  document/prompt body as an `argv` element (`execFile`/`spawn`). Always
  write it to stdin. `lib/claude.js` currently violates this for long
  prompts — a known bug, don't reintroduce it elsewhere.

## Security / single-user model

- Every handler must stay locked to `TELEGRAM_ALLOWED_CHAT_ID`
  (`lib/config.js` → `allowedChatId`); `handleMessage` in `bridge.js` checks
  this first — any new entry point must go through it or replicate the check.
- Secrets live in `.env` (gitignored). Never commit secrets or log them.
- Runtime state lives in `.state/` (gitignored) — offsets, dedup sets,
  pending-action state, reminders, etc. Nothing under it is ever committed.
  (`seen-regulations.json` at repo root is a leftover to fix, not a pattern.)

## Telegram output

- All replies use `parse_mode: 'HTML'`. Model/user-derived text going into
  `sendMessage`/captions must be HTML-escaped first (`escapeHtml` in
  `bridge.js`). `check.js` lints `sendMessage(` call sites for stray tags —
  run `node check.js` after touching reply text.
- Messages cap at 4096 chars. Long replies must go through a paragraph-aware
  splitter — never truncate silently, never let an oversized message throw
  inside a `try` that reports a misleading "failed" error instead. (No
  splitter exists yet; see `docs/ANALYSIS.md` §4.3.)

## External services (office-PC only)

Radicale CalDAV, the hermes WhatsApp bridge (`localhost:3000`), OneDrive
folders (`Bot Templates`/`Bot Output`), and the openknowledge vault + its git
remote only exist on the deployment PC. Code touching them must degrade
gracefully (catch, log, tell the user, don't crash the poll loop) when
unreachable, and unit tests must never require any of them to be up.

## Prompts

Per the v2 design, prompts live only in `.claude/skills/<name>/SKILL.md`,
read at runtime by a skills loader — never inline prompt strings in `lib/`.
`lib/jobs.js` still has v1 inline prompt constants; migrate, don't extend.

## Tests

`npm test` must pass fully offline — no network calls, no reliance on the
external services above. `check.js` is a plain-assert self-check (registry
shape, HTML lint, retry classification); extend it or add `node --test`
files under the same offline constraint.
