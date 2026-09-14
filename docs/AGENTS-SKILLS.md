# Drop-in bundle for telegram-idea-bridge

Copy `.claude/` and `lib/` into the repo root. Nothing here changes behaviour
until `bridge.js` calls it, so it is safe to commit first and wire command by
command.

## What is in here

```
.claude/agents/      7 Claude Code subagents (deep tier: /doc, /excel-with-template,
                     long /summarize, /pdf, calc photo fallback, regcheck deep dive,
                     weekly vault review)
.claude/skills/      18 SKILL.md files — one per model-backed command. Fast-tier skills
                     are read by lib/skills.js as system prompts; deep-tier skills are
                     invoked as `claude -p "/<skill> <args>" --agent <agent>`.
lib/claude.js        Replacement CLI runner: stdin, --output-format json, --json-schema,
                     --agent, --resume, timeout, structured result.
lib/skills.js        Loader + fast-tier runner (JSON mode, temperature, max_tokens,
                     fence-tolerant JSON parsing).
```

## Two small edits to existing files

**`lib/models.js`** — let callers pass generation params through:

```js
// makeOpenAICompatChat → attempt(messages, timeoutMs, params)
body: JSON.stringify({ model, messages, ...params }),
// and in the returned chat():
return async function chat(messages, { timeoutMs = 120000, retries = 2, params = {} } = {}) {
  ... return await attempt(messages, timeoutMs, params);
```
For Groq gpt-oss models you can also add `reasoning_effort: 'low'` to `params` for
the fast tier — it roughly halves latency on gpt-oss-120b.

**`bridge.js`** — add a long-message helper and use it everywhere a model reply is sent:

```js
async function sendLong(chatId, html) {
  const MAX = 3900;
  if (html.length <= MAX) return telegram.sendMessage(chatId, html);
  const parts = [];
  let buf = '';
  for (const para of html.split(/\n\n/)) {
    if ((buf + '\n\n' + para).length > MAX) { parts.push(buf); buf = para; } else buf = buf ? buf + '\n\n' + para : para;
  }
  if (buf) parts.push(buf);
  for (const p of parts) await telegram.sendMessage(chatId, p);
}
```

## Wiring examples

Fast tier (replaces `enhance.enhanceIdea`):
```js
const skills = require('./lib/skills');
const r = await skills.runFast('idea-enhance', rest, model.chat);
// r = { title, tags, language, body, save_confidence }
if (r.save_confidence < 0.5) { /* ask 💾 Save / 🗑 Discard with an inline keyboard */ }
```

Schedule with the weekday fix:
```js
const now = schedule.nowInWib();
const weekday = ['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'][now.getUTCDay()];
const ev = await skills.runFast('event-parse', rest, model.chat, { extra: `NOW: ${schedule.formatWib(now)} ${weekday}` });
if (ev.confidence < 0.8) { /* ask to confirm before radicale.pushEvent */ }
```

Deep tier (replaces `docgen.draftContent`):
```js
const claude = require('./lib/claude');
const DOC_SCHEMA = { type: 'object', required: ['title', 'content'], properties: {
  title: { type: 'string' }, content: { type: 'string' }, document_type: { type: 'string' },
  hal: { type: 'string' }, yth: { type: 'string' }, tembusan: { type: 'array', items: { type: 'string' } },
  needs_from_user: { type: 'array', items: { type: 'string' } } } };
const doc = await claude.runSkill('office-doc', `${templatePath || 'default'} ${brief}`, {
  schema: DOC_SCHEMA, addDir: docgen.TEMPLATES_DIR, timeoutMs: 4 * 60 * 1000 });
// then fillDocxTemplate(templatePath, doc) and ALSO telegram.sendDocument(chatId, buffer, name, caption)
```

Long summary via stdin (fixes the Windows 32k argv limit):
```js
const s = await claude.runSkill('summarize-long', title, { stdin: text, schema: SUMMARY_SCHEMA, agent: 'long-doc-summarizer' });
```

Weekly review (replaces hermes-review-prompt.txt + notify-review.js trigger):
```
claude -p "/vault-review C:\Users\<you>\openknowledge\notes 2026-09-14" --agent vault-curator --output-format json
```
then run `node notify-review.js weekly-review-2026-09-14.md` as before.

## Notes

- Run the CLI with `cwd` = the bridge repo so `.claude/agents` and `.claude/skills` load.
  Do **not** add `--bare`: it skips subagent/skill discovery and requires an API key.
- Each agent sets `permissionMode: dontAsk` (or `acceptEdits` for the curator) and a
  `maxTurns`, so an unattended run can never hang on a prompt.
- `lib/claude.js` reads `CLAUDE_BIN` / `CLAUDE_SHELL=1` from `.env` if `claude` is an
  npm `.cmd` shim rather than a native `.exe` on the Windows box.
- Fast-tier JSON contracts are validated loosely (`parseJson`); add a tiny
  field check per command if the fallback OpenRouter model misbehaves.
