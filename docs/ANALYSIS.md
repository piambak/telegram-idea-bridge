# telegram-idea-bridge — Bot Analysis & Upgrade Plan

Analyzed: `piambak/telegram-idea-bridge` @ `f88de72` (main), 12 Sep 2026.
Scope: every file in the repo (bridge.js + 21 lib modules, ~4,200 lines), plus live checks of the external endpoints the bot depends on.

---

## 1. What the bot is

A single-user Telegram bot (locked to one `TELEGRAM_ALLOWED_CHAT_ID`) that runs on a Windows office PC at Kemenkeu/DJP, restarted by a Scheduled Task. It is a "second brain" front-end: anything you type becomes a note in an OpenKnowledge vault (`~/openknowledge`), mirrored to an Obsidian vault and pushed to a private GitHub repo. Around that core it bolts on 20 utility commands (documents, calendar, news, regulation watch, WhatsApp broadcast, to-do, calculator, stock images).

It talks to five external systems that live outside the repo: the Claude Code CLI (headless `claude -p`), a hermes-agent WhatsApp bridge on `localhost:3000`, a Radicale CalDAV server, OneDrive (`Bot Templates` / `Bot Output` folders), and the Obsidian vault git repo.

## 2. What it can do — command by command

| Command | What happens | Engine used today | Latency |
|---|---|---|---|
| *(plain text)* | Idea → enhanced (title/tags/body) → `notes/<slug>.md` → git push to Obsidian repo | Groq gpt-oss-120b (fallback chain) | ~1–2 s + git push |
| `/list`, `/search`, `/get n` | Walk vault `.md` files; substring search; show a note (truncated at 3,800 chars) | none | instant |
| `/summarize <text \| note n>` | Overview + bullets + next action. <20k chars → cloud model; >20k → Claude CLI (capped at 60k chars) | Groq **or** Claude CLI | 2 s / 1–5 min |
| `/pdf <url or title>` | Resolve title via Semantic Scholar → download → `pdf-parse` → summarize → save `external-sources/*.md` (first 6,000 chars only) | Groq or Claude CLI | 5 s – 5 min |
| `/calc <expr>` / photo | mathjs evaluates; word problems → LLM writes expression → mathjs evaluates; photo → Claude CLI reads image | Groq / Claude CLI | 1 s / ~30–90 s |
| `/news <topic>` | Google News RSS (id/ID, 8 items) → 3–5 sentence digest + links | Groq | ~3 s |
| `/schedule <text>` | LLM → JSON event → `.ics` → PUT to Radicale → send `.ics` file | Groq | ~2 s |
| `/doc <tpl> \| <brief>` | Claude CLI drafts TITLE + body → fill docxtemplater `{title}{content}{date}{author}` or build a plain docx → OneDrive | Claude CLI | 1–3 min |
| `/excel <tpl> \| <brief>` | Claude CLI returns JSON table → ExcelJS → OneDrive | Claude CLI | 1–3 min |
| `/templates` | Lists templates and their `{placeholders}` | none | instant |
| `/regcheck` + daily 07:00 WIB | Scrape JDIH Kemenkeu "Peraturan Menteri" list, diff vs `seen-regulations.json`, overview in Indonesian | Ollama Cloud gpt-oss:20b | ~5 s |
| `/banner <kw>` | LLM refines to English query → Pexels → 6-photo album | Groq | ~3 s |
| `/grammar`, `/promptgen` | Single-turn system prompt | Groq | ~1 s |
| `/broadcast` → `/send` | Draft Indonesian WA message → POST to hermes bridge | Groq | ~1 s |
| `/todo` add/list/done | `notes/todo.md` checklist; synced to vault | none | instant |
| `/models`, `/help` | Registry listing / help | none | instant |
| *(weekly, external)* | Hermes agent reviews notes → `weekly-review-<date>.md` → `notify-review.js` pings Telegram | Hermes (outside repo) | — |

Nice engineering already present: retry with backoff on 429/5xx, a provider fallback chain, a `ScrapeError` that distinguishes "markup changed" from "no news", a wipe-out guard on vault sync, force-reply prompts when a menu command is tapped without arguments, and a positional-drift guard for `/todo done`.

## 3. Which models are used

| Alias | Provider / model | Role |
|---|---|---|
| `groq` ⭐ default | Groq `openai/gpt-oss-120b` → falls back to OpenRouter `nex-agi/nex-n2.5-pro:free` → Ollama Cloud `gpt-oss:20b` | Every interactive command |
| `ollamacloud` | Ollama Cloud `gpt-oss:20b` | Daily regulation digest (single steady provider) |
| `openrouter` | OpenRouter `nex-agi/nex-n2.5-pro:free` | Manual override |
| `gemini` | Gemini `gemini-flash-latest` via OpenAI-compat endpoint | Manual override (slow, 503s) |
| `qwen` | Local Ollama `qwen3:4b` | Effectively unusable (no GPU; 33 s for one word) |
| *(not in registry)* | **Claude Code CLI** `claude -p`, model unspecified (account default) | `/doc`, `/excel`, calc-from-photo, summaries >20k chars |

Verified live today: the OpenRouter slug `nex-agi/nex-n2.5-pro:free` exists; JDIH's search page is server-rendered (so the scraper is viable).

Every cloud call sends only `{model, messages}` — no `temperature`, `max_tokens`, `response_format`, or `reasoning_effort`. The Claude CLI is invoked with no `--model`, no `--output-format`, and no `--json-schema`. Override syntax is `"<alias>: text"` per message.

## 4. What is broken or under-performing

Ordered by impact. File and line references are to the current `main`.

### Confirmed bugs

1. **Long summaries fail on Windows (`lib/claude.js:8`, `lib/summarize.js:16-18`).** Anything over 20,000 chars is routed to the Claude CLI, and the whole document (up to 60,000 chars) is passed *as a command-line argument*. Windows caps a process command line at 32,767 chars, so a document in the 32k–60k range — exactly the regulation PDFs this routing exists for — dies with a spawn error. `claude -p` reads stdin; pipe the document instead.

2. **Excel templates are never filled (`lib/docgen.js:170-174` vs `bridge.js:457`).** `/templates` tells you an `.xlsx` "fills: {title}, {date}…", but `generateExcelDoc` only appends rows after the last row; placeholder replacement exists for `.docx` only. Users see promised behaviour that silently doesn't happen. Also, every cell value stays a string, so numbers land in Excel as text.

3. **Messages over 4,096 chars are dropped with a misleading error.** No helper splits long replies. An enhanced idea, a `/news` digest with 8 links, a long `/summarize`, or `/grammar` on a long paragraph throws `message is too long` inside the `try`, so the user is told "Enhancement failed" even though the note was already saved (`bridge.js:93-98`). Only `/get` truncates.

4. **`/pdf` says "full text still saved" but saves 6,000 chars (`bridge.js:541, 550`).** The capture note keeps an excerpt, not the source. For a 40-page PMK that is the cover page.

5. **Vault sync blocks the reply and races itself.** `handleIdea` `await`s a git add/commit/push before answering (`bridge.js:92`), so a slow push delays every idea. Jobs now run with no concurrency cap (`bridge.js:645`), so an idea and a `/todo add` arriving together run two `git commit`s in the same repo → `index.lock` failure, swallowed by `syncVaultQuietly`, leaving the mirror silently stale.

6. **`/banner` errors when Pexels returns one photo.** `sendMediaGroup` needs 2–10 items (`lib/telegram.js:58` even says so); `bridge.js:489-497` sends whatever count comes back.

7. **`seen-regulations.json` is committed and rewritten daily** — it is not in `.gitignore`, so the working tree is permanently dirty and any `git pull` will conflict.

8. **`lib/whatsapp.js:16`** parses `res.json()` before checking `res.ok`; a 502 HTML page from the bridge becomes an unhelpful "Unexpected token <" error instead of "bridge is down".

### Features that work but give weak results

9. **Everything you type becomes a permanent note and a git commit.** There is no "just ask" mode; "ok thanks" or a question to the bot is enhanced, saved, and pushed. Needs an ask/chat path (e.g. `?` prefix or `/ask`) and a "save?" confirmation for short inputs.

10. **No follow-up memory.** Every command is single-turn. "Make it shorter" after `/broadcast`, or "add a table" after `/doc`, cannot work. The Claude CLI supports `--resume <session_id>`; cloud calls could carry the last exchange per chat.

11. **`/regcheck` covers PMK only.** The command promises "Kemenkeu/DJP" but scrapes only `jdih.kemenkeu.go.id` "Peraturan Menteri". DJP's own PER-/SE-/KEP- Dirjen regulations (pajak.go.id/peraturan) — the ones a DJP officer actually needs daily — are not watched. The digest also sees only titles, never the regulation text, so the overview is shallow.

12. **`/doc` produces a plain body, not a Kemenkeu document.** Placeholders are limited to `{title}{content}{date}{author}`; `author` is never passed (`bridge.js:392`). Nota dinas / surat tugas / undangan have fixed fields (Nomor, Sifat, Lampiran, Hal, Yth., tembusan, tanda tangan) that the current prompt and template contract cannot fill. The output is also only saved to OneDrive — it is never sent back to Telegram even though `sendDocument` already exists.

13. **`/excel` uses a 1–3 minute Claude CLI call to produce a JSON table** that Groq with `response_format: json_object` would produce in ~2 s. No formulas, no column typing, no totals.

14. **Calc-from-photo waits ~30–90 s for the Claude CLI** while Gemini Flash (already in the registry) and Groq's vision models can read the image in 2–3 s via the same OpenAI-compatible `image_url` content block.

15. **`/schedule` guesses weekdays blind.** The prompt gives the model `2026-09-12 10:00 WIB` with no weekday, so "next Monday"/"Jumat depan" is a coin-flip on small models. The event is also pushed straight to the calendar without a confirm step, and the Radicale server is on the office PC — invisible from a phone unless a client syncs to it; the `.ics` file is the thing that actually works on mobile.

16. **`/pdf` title lookup is academic-only.** Semantic Scholar cannot find a PMK or a DJP circular; for this user's domain, JDIH search would be the right resolver. And a PDF *sent to the bot as a file* is ignored entirely (`bridge.js:676-686` handles photos and text only).

17. **Voice notes are ignored.** For an "idea bridge" used from a phone, dictation is the most natural input. Groq offers `whisper-large-v3-turbo` on the same free key.

18. **Prompts don't pin the language.** `enhance.js`, `summarize.js`, `jobs.js` are English prompts with no "reply in the language of the input" rule; Indonesian ideas often come back in English.

19. **`/search` is a case-insensitive substring scan** in filesystem order, no ranking, no tag/date filters, no fuzzy or semantic match. Fine at 50 notes, poor at 500.

20. **Structured outputs are parsed with regexes** (`/\{[\s\S]*\}/` in schedule/excel; bare `TITLE:` lines in enhance/docgen; no code-fence stripping in `calc.js`). One markdown fence from the fallback OpenRouter model breaks the command.

21. **Robustness gaps:** the poll `fetch` has no abort timeout (`lib/telegram.js:6`); `execFile('claude')` without `shell:true` only works on Windows if `claude` is a native `.exe`, not an npm `.cmd` shim — worth verifying on the box; `check.js`'s HTML-safety lint only inspects single-line `sendMessage(` calls, so multi-line calls are unchecked; there are no handler tests.

## 5. Improvement plan

### Quick wins (a day, no architecture change)

Pipe the Claude CLI prompt through stdin and pass `--output-format json --json-schema` for anything structured. Add a `sendLong()` helper that splits on paragraph boundaries under 4,000 chars and use it everywhere. Fire vault sync *after* replying and serialize it behind a promise mutex. Guard `sendMediaGroup` (1 photo → `sendPhoto`). Gitignore `seen-regulations.json` (move it to `%APPDATA%` or next to `.offset`). Send the generated `.docx`/`.xlsx` back with `sendDocument`. Add `temperature`, `max_tokens`, `response_format` and (Groq gpt-oss) `reasoning_effort: "low"` to the OpenAI-compat client. Put the weekday into the schedule prompt. Add "Reply in the same language as the input" to every prompt. Save the whole extracted PDF text (or a sidecar `.txt`).

### Medium (a week)

Accept `message.document` (PDF/DOCX → same pipeline as `/pdf`) and `message.voice` (Groq Whisper → transcript → idea/command). Add `/ask` (no save) and an inline-keyboard "💾 Save / 🗑 Discard" on ideas under ~80 chars. Add a per-chat "last result" so `/again shorter`, `/doc` follow-ups and `--resume` work. Move `/excel` and calc-photo off the Claude CLI to Groq JSON mode and Gemini vision. Add a DJP source to `regmonitor` and fetch each new regulation's abstract page before digesting. Replace Semantic Scholar with JDIH search for `/pdf` titles. Add a confirm step to `/schedule`. Add `/status` (which providers/keys/bridges are alive).

### Structural: agents + skills (what the rest of this doc and the attached files provide)

Split each command into a **skill** (a `SKILL.md` that holds the role, procedure, output contract and guardrails) and, for the heavy commands, an **agent** (a `.claude/agents/*.md` subagent with a fixed model, tool allowlist and permission mode). The bridge then has two execution paths:

* *Fast tier* — the Node bridge reads the skill's body as the system prompt and calls Groq (JSON mode where the contract is JSON). Sub-2-second commands stay sub-2-second, and prompts live in one versioned place instead of scattered string constants.
* *Deep tier* — the bridge runs `claude -p "/<skill> <args>" --agent <agent> --output-format json [--json-schema …]` with the document on stdin. The agent has only the tools the job needs (`Read` on the templates folder, `WebFetch` for JDIH, never `Bash`), a `maxTurns`, and `permissionMode: dontAsk` so nothing can block unattended.

Do **not** use `--bare` in the deep tier if the CLI is authenticated with a subscription login — bare mode requires an API key.

## 6. Agent and skill per command

Legend — *Tier F* = fast cloud model via SKILL.md prompt; *Tier D* = Claude Code agent + skill.

| Command | Tier | Skill | Agent | Model | Tools / guardrails |
|---|---|---|---|---|---|
| plain text idea | F | `idea-enhance` | — | Groq gpt-oss-120b, `reasoning_effort: low` | JSON `{title,tags[],body,language}`; mirror input language; if input < 80 chars ask Save/Discard |
| `/ask` (new) | F | `ask` | — | Groq | Answer only, never saves; carries last 3 turns |
| `/grammar` | F | `grammar-fix` | — | Groq, temp 0.2 | JSON `{corrected, changes[]}`; never changes meaning |
| `/promptgen` | F | `prompt-gen` | — | Groq | Returns one prompt block; asks for missing role/format only inside the prompt |
| `/broadcast` | F | `wa-broadcast` | — | Groq | Indonesian formal-friendly; ≤ 900 chars; no emoji unless brief has them; `/send` requires an explicit confirm |
| `/calc` text | F | `calc-expression` | — | Groq, temp 0 | JSON `{expression}` or `{none:true}`; mathjs evaluates; strips fences |
| `/calc` photo | F→D | `calc-vision` | `vision-math-reader` (fallback) | Gemini Flash vision → Claude `haiku` | Same contract; image via `image_url` |
| `/summarize` <20k | F | `summarize-short` | — | Groq | Overview/bullets/next-action; same language as text |
| `/summarize` >20k, `/pdf` | D | `summarize-long` | `long-doc-summarizer` | Claude `sonnet` | stdin doc; map-reduce in 25k-char chunks; `--json-schema`; tools: none |
| `/pdf` capture | D | `source-capture` | `research-capturer` | Claude `sonnet` | Adds tags, key claims, and links to related vault notes (Grep vault); write only under `external-sources/` |
| `/news` | F | `news-digest` | — | Groq | Trend digest; flags contradicting headlines; Indonesian unless topic is English |
| `/schedule` | F | `event-parse` | — | Groq, temp 0, JSON mode | Prompt includes weekday; JSON `{title,start,end,location,description,confidence}`; confirm if `confidence<0.8` |
| `/doc` | D | `office-doc` | `office-doc-drafter` | Claude `sonnet` (opus for formal letters) | Read templates dir; knows Kemenkeu naskah dinas structure; JSON fields matching template placeholders; tools: `Read` only |
| `/excel` | F (D optional) | `table-builder` | `spreadsheet-builder` for templates | Groq JSON mode; Claude `sonnet` when template has placeholders | Typed cells, totals row, formulas as strings starting with `=` |
| `/regcheck` | F + D | `reg-digest` / `reg-deep-dive` | `regulation-analyst` | Ollama Cloud for daily list; Claude `sonnet` for deep dive | `WebFetch` on jdih.kemenkeu.go.id + pajak.go.id only; output "who is affected / what changes / effective date" |
| `/banner` | F | `image-query` | — | Groq | 2–5 English words; sends photographer credit line |
| weekly review | D | `vault-review` | `vault-curator` | Claude `sonnet`, `memory: project` | Read/Glob/Grep on vault; `WebSearch`; may write only `weekly-review-*.md`; `maxTurns: 40` |
| `/todo`, `/list`, `/search`, `/get`, `/templates`, `/models`, `/help` | — | none (no model) | — | — | Keep as-is; add ranking to `/search` |

The attached bundle contains a ready-to-drop-in `.claude/agents/` (7 agents) and `.claude/skills/` (18 skills), plus a patched `lib/claude.js` (stdin + JSON schema + agent selection) and a `lib/skills.js` loader that lets the Node fast-tier read the same SKILL.md bodies.

## 7. Suggested order of work

Week 1: quick wins in §5 (they are all independent, one-file changes) and drop in `lib/claude.js` + `lib/skills.js`. Week 2: wire `/doc`, `/summarize`, `/pdf` to their agents; move `/excel` and calc-photo to the fast tier. Week 3: document/voice inputs, `/ask`, follow-up memory, DJP source. Then: search ranking, `/status`, handler tests in `check.js`.

## Appendix — live checks performed

JDIH search page: server-rendered list, first item PMK 64/2026 — scraper regex is viable (exact attribute order could not be byte-verified from this sandbox). OpenRouter `/api/v1/models`: `nex-agi/nex-n2.5-pro:free` present. Claude Code docs (`code.claude.com/docs`): confirmed `-p` reads stdin (10 MB cap), `--json-schema`, `--agent`, `.claude/agents` and `.claude/skills` conventions, `--bare` needs an API key.
