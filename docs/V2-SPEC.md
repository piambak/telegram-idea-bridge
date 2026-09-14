# Idea Bridge v2 — Specification

Branch: `feature/v2-ux-email-finance-reminders`. Covers four requests: a visual
overhaul, email digest with calendar hand-off, automatic finance log + report,
and recurring reminders in Google Tasks. Everything below is implemented on the
branch; "Later" marks what is deliberately left out of this round.

## 1. Look & feel

Every reply is built by `lib/ui.js` so the bot has one visual language:

```
💡 Kios Pajak Digital                 ← icon + bold title
#pajak #layanan                       ← muted subtitle
┃ Ide bagus. …                        ← blockquote body (expandable when long)
┃ Risiko: adopsi.
Poin penting                          ← bold section label
▸ item                                ← ▸ bullets
💾 notes/kios-pajak-digital.md        ← muted footer
[💾 Simpan] [💬 Jawab saja] [🗑 Buang] ← inline buttons for the next action
```

Rules the implementation follows:

- **Progress in place.** Long jobs post `⏳ …` once and *edit* that message
  into the result (`ui.progress`). No more "Got it…" + separate result.
- **Buttons, not follow-up commands.** `/broadcast` → `[📤 Kirim] [🔁 Draft ulang]`
  (the old `/send` is gone). `/todo list` → one ✅ button per item. Low-confidence
  ideas, uncertain dates, receipts and inbox items all get buttons. Every button
  payload is stored in `.state/pending.json` with a 6 h TTL and a ≤64-byte
  callback id, so a restart never loses a draft.
- **Long replies split** at paragraph boundaries (`ui.send`), never truncated,
  never a "message too long" error.
- **Menu with emoji + Indonesian descriptions**, bot description/short
  description set via `setMyDescription`, grouped `/start` card.
- **Progress bars** (`▰▰▰▱▱`) for category shares in reports and inbox counts.
- **Quiet categories collapse** (newsletters, system notifications → expandable quote).
- **`?` prefix** = ask mode (no save). Plain text with `save_confidence < 0.5`
  asks before saving instead of committing chit-chat to the vault.
- **New inputs:** photo without caption → "Foto ini untuk apa? [💸 Catat struk] [🧮 Hitung]";
  PDF file → captured like `/pdf`; voice note → Groq Whisper → handled as text.

## 2. Email digest (`/inbox`, daily 07:30 WIB, optional every N hours)

```
mail/index.fetchNew()  →  digest.triage()  →  digest.autoActions()  →  cards
   gmail / outlook / imap      rules + email-triage skill      Sheets / Radicale
```

- **Providers** (`lib/mail/*`): Gmail REST (`after:` query, full payload,
  `.ics` attachments fetched), Microsoft Graph (`/me/mailFolders/inbox/messages`
  with `receivedDateTime ge`, meeting requests' `.ics` fetched), IMAP fallback
  (optional `imapflow` + `mailparser`). All normalise to one message shape:
  `{ id, provider, from{name,email}, subject, date, text, snippet, labels, unread, attachments[], ics, link }`.
- **Cursor & dedup**: per-provider timestamp cursor + a 3,000-id seen set in
  `.state/`. `/inbox 72h` overrides the cursor. One provider failing does not
  hide the others; the header card lists the error.
- **Triage**: rules first, zero model cost —
  `.ics` → *meeting* (event parsed locally, TZID-aware);
  bank/e-wallet sender or "Rp + transaction words" → *finance* (amount, type,
  account extracted by regex); OTP/login → *system*; `CATEGORY_PROMOTIONS` or
  unsubscribe/promo words → *newsletter*. Everything else goes to the
  `email-triage` skill in batches of 8 → `{category, summary, action, due, priority, event}`.
- **Categories** (in display order): 🔴 Perlu tindakan · 📅 Undangan & jadwal ·
  💸 Transaksi & tagihan · 💼 Kantor — info · 👤 Pribadi · 📰 Newsletter & promo · 🔔 Notifikasi sistem.
- **Automatic**: transactions → Google Sheets (`FINANCE_AUTO_LOG=1`),
  `.ics` invites → Radicale (`DIGEST_AUTO_CALENDAR=1`). Both are reflected as
  "✅ dicatat / ✅ di kalender" on the item line.
- **Buttons**: `📌 Task` (action items → Google Task with due date and the
  email link in notes), `📅 Tambah` (model-inferred events → Radicale + .ics),
  `💸 Catat` (transactions when auto-log is off).
- Nothing is written back to the mailbox.

## 3. Finance (`/spend`, receipt photos, email transactions, `/report`, monthly auto-report)

- **Store**: Google Sheets, one tab per month `YYYY-MM`, copied from a
  `Template` tab if present. Columns
  `Tanggal | Deskripsi | Kategori | Jumlah | Tipe | Akun | Sumber | Ref | Catatan`.
  `Ref` = email id → re-running the digest never double-logs.
- **Inputs → one Transaction shape**
  `{ date, description, category, amount>0, type in|out, account, source email|text|photo, ref, note }`
  - `/spend makan siang 45rb`: regex hint (amount/type) + `txn-extract` skill
    refines merchant/category; hint survives a model failure.
  - Photo (caption `/spend`, or the button on an uncaptioned photo): Gemini Flash
    vision via the OpenAI-compatible `image_url` content part + `receipt-vision`
    skill → grand total, merchant, date, up to 3 line items.
  - Email: `finance.fromEmail` (regex) — 40 Indonesian bank/e-wallet/merchant
    sender domains, `Rp 1.250.000,00` / `45rb` / `1,5jt` amount parsing, in/out
    inference.
- **Confirm card** `[💾 Simpan] [🗑 Batal]` + a category keypad (11 categories:
  Makan, Transport, Belanja, Tagihan, Kesehatan, Hiburan, Pendidikan, Transfer,
  Pemasukan, Investasi, Lainnya). `SPEND_CONFIRM=0` saves immediately.
- **Report** (`/report`, `/report 2026-08`, and automatically on the 1st at 08:00
  for the previous month): income / expense / net, category bars with %,
  top-5 merchants, daily average, delta vs previous month, and 2–3 sentences
  of `finance-commentary`. Buttons: open the sheet, previous month.

## 4. Reminders (`/remind`, tick daily 07:15 WIB)

- `/remind bayar listrik setiap tanggal 20, ingatkan 3 hari sebelumnya`
  → `reminder-parse` skill → `{ title, rule, leadDays }`.
  Rules: `monthly{day}` (clamped to month length), `weekly{weekday}`,
  `yearly{month,day}`, `once{date}`.
- State in `.state/reminders.json`: `{ id, title, notes, rule, leadDays, nextDue, lastTaskId, lastTaskFor, active }`.
- **Tick**: when `nextDue − today ≤ leadDays` and no task exists for this
  cycle → create a Google Task (list "Idea Bridge", due = nextDue) and send a
  Telegram card with a `✅ Selesai` button. Due-day and overdue nudges repeat
  daily. If the task was completed on the phone, the tick detects it and
  rolls `nextDue` forward. `/remind done n` does the same from Telegram.
- `/remind list` · `/remind done n` · `/remind del n` · `/remind check`.

## 5. Model routing

| Tier | Where | Used for |
|---|---|---|
| Fast (Groq gpt-oss-120b → OpenRouter → Ollama Cloud), JSON mode, temperature per skill | `lib/skills.runFast` | idea-enhance, ask, grammar, promptgen, broadcast, calc, short summaries, news, event-parse, table-builder, reg-digest, image-query, **email-triage, txn-extract, reminder-parse, finance-commentary** |
| Vision (Gemini Flash, `image_url`) | `finance.extractFromImage` | receipt photos |
| Deep (Claude Code agents, stdin + `--json-schema`) | `lib/claude.runSkill` | `/doc` (office-doc-drafter), long summaries & `/pdf` (long-doc-summarizer), calc photo fallback |
| Groq Whisper | `lib/voice` | voice notes |

Prompts live only in `.claude/skills/*/SKILL.md`; Node reads the same body as
the system prompt (`lib/skills.js`), so there is one place to edit a prompt.

## 6. Scheduled jobs (WIB)

| Time | Job |
|---|---|
| 07:00 | Regulation check (JDIH) |
| 07:15 | Reminder tick → Google Tasks + Telegram |
| 07:30 | Inbox digest (quiet if nothing new) |
| every `INBOX_EVERY_HOURS` h | Optional extra inbox digests |
| 08:00 on the 1st | Monthly finance report for the previous month |

## 7. Configuration (`.env`, all optional beyond the existing keys)

```
GOOGLE_CLIENT_ID=            GOOGLE_CLIENT_SECRET=          # docs/SETUP-GOOGLE.md
MS_CLIENT_ID=                MS_TENANT=organizations        # docs/SETUP-OUTLOOK.md
IMAP_HOST= IMAP_PORT=993 IMAP_USER= IMAP_PASSWORD= IMAP_MAILBOX=INBOX
MAIL_PROVIDERS=gmail,outlook
FINANCE_SHEET_ID=            FINANCE_AUTO_LOG=1   SPEND_CONFIRM=1
GOOGLE_TASKS_LIST=Idea Bridge
DIGEST_AUTO_CALENDAR=1       INBOX_EVERY_HOURS=0
GROQ_WHISPER_MODEL=whisper-large-v3-turbo
CLAUDE_BIN=claude            CLAUDE_SHELL=0                  # if `claude` is an npm .cmd shim on Windows: CLAUDE_BIN=<path>\claude.cmd CLAUDE_SHELL=1
```

Runtime state moved to `.state/` (gitignored); `seen-regulations.json` is no
longer tracked.

## 8. Tests

`npm test` = 35 unit tests (`node --test`: amount parsing, categorisation,
bank-email extraction, ICS parsing, triage merge, reminder date maths and tick
lifecycle, message splitting, callback encoding, cell typing, placeholder fill,
skill loading) + `check.js` (registry, retry policy, HTML safety lint) +
`test-menu-args.js` + `test-smoke.js` (drives 16 messages and 3 button presses
through the real `bridge.js` with stubbed Telegram/model and checks the rendered
HTML). Network calls are not exercised; first real run is the checklist below.

## 9. First-run checklist on the PC

1. `git checkout feature/v2-ux-email-finance-reminders && npm install`
2. `.env`: add `GOOGLE_*`, `FINANCE_SHEET_ID`; optionally `MS_CLIENT_ID`.
3. `node setup-google.js` (+ `node setup-outlook.js`).
4. `node bridge.js`, then in Telegram: `/status` → all green; `/inbox 48h`;
   `/spend kopi 25rb`; send a receipt photo; `/remind bayar listrik setiap tanggal 20`; `/report`.
5. Restart the `TelegramIdeaBridge` scheduled task.

## Later (not in this round)

DJP (pajak.go.id) regulation source; JDIH title search for `/pdf`; `/search`
ranking; per-command follow-ups via `--resume`; reading `.docx` uploads;
weekly review migrated from Hermes to the `vault-curator` agent (agent file is
ready, cron hook not wired).
