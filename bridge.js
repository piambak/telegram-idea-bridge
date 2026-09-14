const fs = require('fs');
const path = require('path');
const { allowedChatId, knowledgeBaseDir } = require('./lib/config');
const telegram = require('./lib/telegram');
const knowledge = require('./lib/knowledge');
const pdf = require('./lib/pdf');
const vault = require('./lib/vault');
const todo = require('./lib/todo');
const calc = require('./lib/calc');
const summarize = require('./lib/summarize');
const news = require('./lib/news');
const schedule = require('./lib/schedule');
const radicale = require('./lib/radicale');
const whatsapp = require('./lib/whatsapp');
const docgen = require('./lib/docgen');
const regmonitor = require('./lib/regmonitor');
const images = require('./lib/images');
const vaultsync = require('./lib/vaultsync');
const state = require('./lib/state');
const skills = require('./lib/skills');
const claude = require('./lib/claude');
const ui = require('./lib/ui');
const pending = require('./lib/pending');
const os = require('os');
const { MODELS, DEFAULT_MODEL, modelForJob, parseModelOverride } = require('./lib/models');

const { escapeHtml } = ui;

// Emoji + Indonesian descriptions for the Telegram command menu
// (docs/V2-SPEC.md §1).
const BOT_COMMANDS = [
	{ command: 'start', description: '👋 Apa saja yang bisa bot ini lakukan' },
	{ command: 'list', description: '📋 Catatan terbaru di vault' },
	{ command: 'search', description: '🔍 Cari di vault: /search <kata kunci>' },
	{ command: 'get', description: '📄 Buka hasil nomor: /get <n>' },
	{ command: 'pdf', description: '📥 Simpan PDF: /pdf <tautan atau judul>' },
	{ command: 'calc', description: '🧮 Hitung: /calc <ekspresi>, atau kirim foto' },
	{ command: 'summarize', description: '📝 Ringkas teks/catatan: /summarize <teks | note n>' },
	{ command: 'news', description: '📰 Ringkasan berita: /news <topik>' },
	{ command: 'schedule', description: '📅 Tambah ke kalender: /schedule <teks acara>' },
	{ command: 'confirm', description: '✅ Konfirmasi jadwal yang belum pasti' },
	{ command: 'doc', description: '📃 Buat dokumen Word: /doc <template> | <ringkasan>' },
	{ command: 'excel', description: '📊 Buat tabel Excel: /excel <template> | <ringkasan>' },
	{ command: 'templates', description: '🗂 Daftar template Word/Excel' },
	{ command: 'regcheck', description: '⚖️ Cek peraturan Kemenkeu/DJP terbaru' },
	{ command: 'banner', description: '🎨 Cari gambar untuk banner: /banner <kata kunci>' },
	{ command: 'grammar', description: '✏️ Perbaiki tata bahasa: /grammar <teks>' },
	{ command: 'promptgen', description: '💡 Buat prompt AI: /promptgen <tujuan>' },
	{ command: 'broadcast', description: '📢 Draft broadcast WA: /broadcast <ringkasan>' },
	{ command: 'todo', description: '☑️ Daftar tugas: /todo <item>, /todo list' },
	{ command: 'models', description: '🤖 Daftar model AI yang tersedia' },
	{ command: 'help', description: '❓ Daftar lengkap perintah' },
];

const BOT_DESCRIPTION =
	'Second brain pribadi via Telegram. Kirim ide apa saja untuk disimpan ke vault, atau gunakan ' +
	'/pdf, /calc, /schedule, /doc, /excel, /news, /regcheck, /banner, /broadcast, dan /todo. Ketik /start untuk ringkasannya.';
const BOT_SHORT_DESCRIPTION = 'Bot ide & produktivitas pribadi';

const OFFSET_STATE_FILE = 'offset';

function loadOffset() {
	return state.readJson(OFFSET_STATE_FILE, 0);
}

function saveOffset(offset) {
	state.writeJson(OFFSET_STATE_FILE, offset);
}

// Keep-alive typing indicator while a job runs. Refcounted: jobs now run
// concurrently, so the timer must survive until the LAST one finishes —
// a plain single timer would leak on start and die early on stop.
let typingTimer;
let typingCount = 0;
function startTyping(chatId) {
	if (typingCount++ > 0) return;
	const tick = () => telegram.sendChatAction(chatId, 'typing').catch(() => {});
	tick();
	typingTimer = setInterval(tick, 4000);
}
function stopTyping() {
	if (typingCount > 0 && --typingCount === 0) clearInterval(typingTimer);
}

// Best-effort push to the personal Obsidian vault repo — never let a sync
// failure block the user-facing response, since the note is already saved
// locally in OpenKnowledge regardless.
function syncVaultQuietly(message) {
	return vaultsync.sync(message).catch((err) => console.error('[bridge] vault sync failed:', err.message));
}

async function handleIdea(chatId, rawText) {
	const { modelKey, rest } = parseModelOverride(rawText);
	const model = MODELS[modelKey];
	const job = await ui.progress(chatId, `⏳ Enhancing this idea with <b>${escapeHtml(model.label)}</b>...`);
	startTyping(chatId);
	try {
		const { title, tags, body } = await skills.runFast('idea-enhance', rest, model.chat);
		const filePath = knowledge.writeIdeaNote({ title, tags, rawIdea: rest, enhancedBody: body });
		await job.finish(
			ui.card({
				icon: '💡',
				title,
				subtitle: (tags || []).map((t) => `#${t}`).join(' '),
				body,
				footer: `💾 notes/${path.basename(filePath)}`,
			}),
		);
		// Fire-and-forget: the note is already saved locally, so a slow (or
		// failing) push must never delay or fail the reply (docs/ANALYSIS.md
		// bug #5). syncVaultQuietly itself never rejects.
		syncVaultQuietly(`Add idea: ${title}`);
	} catch (err) {
		await job.finish(`Enhancement failed: ${escapeHtml(err.message)}`);
	} finally {
		stopTyping();
	}
}

// Generic runner for single-turn fast-tier skills (grammar-fix, prompt-gen):
// skill name + user text in, model reply out (via lib/skills.runFast).
// `render` turns a json_mode skill's parsed object into the plain text to
// show; defaults to identity for a plain-text skill. Supports the same
// "<model>: text" override as idea enhancement.
async function runSkillJob(chatId, argText, { skillName, verb, usage, render = (r) => r }) {
	if (!argText) {
		await ui.send(chatId, usage);
		return;
	}
	const { modelKey, rest } = parseModelOverride(argText);
	const model = MODELS[modelKey];
	startTyping(chatId);
	try {
		const result = await skills.runFast(skillName, rest, model.chat);
		await ui.send(chatId, escapeHtml(render(result)));
	} catch (err) {
		await ui.send(chatId, `${verb} failed: ${escapeHtml(err.message)}`);
	} finally {
		stopTyping();
	}
}

// Broadcast drafts, and every /todo item, offer inline buttons instead of a
// follow-up command (docs/V2-SPEC.md §1). Each button's payload lives in
// .state/pending.json (lib/pending.js) keyed by a short id, not in memory —
// a restart never loses a draft.
const BROADCAST_KEYBOARD = (id) =>
	ui.keyboard([[{ text: '📤 Kirim', callback_data: `bcsend:${id}` }, { text: '🔁 Draft ulang', callback_data: `bcredraft:${id}` }]]);

async function handleBroadcast(chatId, argText) {
	if (!argText) {
		await ui.send(chatId, 'Usage: /broadcast &lt;brief&gt;');
		return;
	}
	const { modelKey, rest } = parseModelOverride(argText);
	const model = MODELS[modelKey];
	const job = await ui.progress(chatId, '⏳ Drafting broadcast...');
	startTyping(chatId);
	try {
		const draft = await skills.runFast('wa-broadcast', rest, model.chat);
		const id = pending.create('broadcast', { brief: rest, draft });
		await job.finish(escapeHtml(draft), { reply_markup: BROADCAST_KEYBOARD(id) });
	} catch (err) {
		await job.finish(`Broadcast draft failed: ${escapeHtml(err.message)}`);
	} finally {
		stopTyping();
	}
}

// [📤 Kirim] — posts the held draft to the WhatsApp group.
async function handleBroadcastSend(chatId, messageId, entry) {
	await whatsapp.sendToGroup(entry.data.draft);
	await telegram.editMessageText(chatId, messageId, `${escapeHtml(entry.data.draft)}\n\n<i>✅ Sent to the WhatsApp group.</i>`);
}

// [🔁 Draft ulang] — redrafts from the same brief and re-attaches fresh buttons.
async function handleBroadcastRedraft(chatId, messageId, entry) {
	const model = MODELS[DEFAULT_MODEL];
	const draft = await skills.runFast('wa-broadcast', entry.data.brief, model.chat);
	const id = pending.create('broadcast', { brief: entry.data.brief, draft });
	await telegram.editMessageText(chatId, messageId, escapeHtml(draft), { reply_markup: BROADCAST_KEYBOARD(id) });
}

// The numbers in "/todo done <n>" are positions, and completing an item
// renumbers everything below it. Remembering what was actually shown lets
// "done 2" close the item the user read as 2, even if the list moved since.
// (The ✅ buttons below don't have this problem — each one carries the
// item's own text, not a position.)
const lastTodoListing = new Map();

// Builds the current open-todo view: text + one ✅ button per item. Reused
// by both /todo list and the done-button handler (which refreshes the same
// message in place after marking one done).
function buildTodoListView() {
	const items = todo.listItems();
	if (items.length === 0) {
		return { text: 'No open to-dos. Add one: /todo &lt;item&gt;', keyboard: undefined };
	}
	const rows = items.map((it) => [
		{ text: `✅ ${it.text.length > 40 ? `${it.text.slice(0, 40)}…` : it.text}`, callback_data: `tododone:${pending.create('todo_done', { text: it.text })}` },
	]);
	return { text: '<b>Open to-dos</b>', keyboard: ui.keyboard(rows) };
}

async function handleTodo(chatId, arg) {
	const [sub, ...restParts] = arg.split(/\s+/);
	const rest = restParts.join(' ').trim();

	if (arg === 'list' || arg === '') {
		const items = todo.listItems();
		lastTodoListing.set(chatId, items.map((it) => it.text));
		const { text, keyboard } = buildTodoListView();
		await telegram.sendMessage(chatId, text, keyboard ? { reply_markup: keyboard } : undefined);
		return;
	}
	if (sub === 'done') {
		const n = Number(rest);
		if (!Number.isInteger(n) || n < 1) {
			await ui.send(chatId, 'Usage: /todo done &lt;n&gt; — the number from /todo list.');
			return;
		}
		try {
			// Prefer the text the user actually saw; fall back to positional
			// only when there is no remembered listing (e.g. after a restart).
			const remembered = lastTodoListing.get(chatId);
			const expected = remembered && remembered[n - 1];
			const text = expected ? todo.markDoneMatching(expected) : todo.markDone(n);
			lastTodoListing.delete(chatId); // positions just shifted; force a re-list
			await syncVaultQuietly(`Todo done: ${text}`);
			await ui.send(chatId, `✅ Done: ${escapeHtml(text)}`);
		} catch (err) {
			await ui.send(chatId, escapeHtml(err.message) + '\n\nRun /todo list to see current numbers.');
		}
		return;
	}
	todo.addItem(arg);
	await syncVaultQuietly(`Todo add: ${arg}`);
	await ui.send(chatId, `➕ Added: ${escapeHtml(arg)}`);
}

// ✅ button on a /todo list item — marks it done and refreshes the same
// message in place with the remaining items and fresh buttons.
async function handleTodoDoneButton(chatId, messageId, entry) {
	const text = todo.markDoneMatching(entry.data.text);
	await syncVaultQuietly(`Todo done: ${text}`);
	const { text: newText, keyboard } = buildTodoListView();
	await telegram.editMessageText(chatId, messageId, `✅ ${escapeHtml(text)}\n\n${newText}`, keyboard ? { reply_markup: keyboard } : undefined);
}

async function handleCalc(chatId, argText) {
	if (!argText) {
		await ui.send(chatId, 'Usage: /calc &lt;expression or word problem&gt;, or send a photo of a math problem.');
		return;
	}
	const { modelKey, rest } = parseModelOverride(argText);
	const model = MODELS[modelKey];
	startTyping(chatId);
	try {
		const { expression, result } = await calc.solveText(rest, model.chat);
		await ui.send(chatId, `<code>${escapeHtml(expression)}</code> = <b>${escapeHtml(result)}</b>`);
	} catch (err) {
		await ui.send(chatId, `Calculation failed: ${escapeHtml(err.message)}`);
	} finally {
		stopTyping();
	}
}

async function handleCalcImage(chatId, fileId) {
	startTyping(chatId);
	let imagePath;
	try {
		const file = await telegram.getFile(fileId);
		const buffer = await telegram.downloadFile(file.file_path);
		imagePath = path.join(os.tmpdir(), `calc-${chatId}-${Date.now()}${path.extname(file.file_path) || '.jpg'}`);
		fs.writeFileSync(imagePath, buffer);
		const { expression, result } = await calc.solveImage(imagePath);
		await ui.send(chatId, `<code>${escapeHtml(expression)}</code> = <b>${escapeHtml(result)}</b>`);
	} catch (err) {
		await ui.send(chatId, `Calculation failed: ${escapeHtml(err.message)}`);
	} finally {
		if (imagePath) fs.unlink(imagePath, () => {});
		stopTyping();
	}
}

// Ad-hoc summarization of text pasted straight into Telegram, or of a note
// already in the vault ("/summarize note <n>" after /list or /search).
// lib/summarize picks the engine by length on its own: long documents go to
// the Claude CLI, short ones to the fast model.
async function handleSummarize(chatId, argText) {
	if (!argText) {
		await ui.send(
			chatId,
			'Usage: /summarize &lt;text&gt;\nOr summarize a vault entry: /summarize note &lt;n&gt; (after /list or /search)',
		);
		return;
	}

	const { modelKey, rest } = parseModelOverride(argText, 'summarize');
	const model = MODELS[modelKey];

	// "note <n>" resolves against the last /list or /search results.
	let text = rest;
	let sourceLabel = null;
	const noteMatch = rest.match(/^note\s+(\d+)$/i);
	if (noteMatch) {
		const results = lastResults.get(chatId);
		const n = Number(noteMatch[1]);
		if (!results || n < 1 || n > results.length) {
			await ui.send(chatId, 'Run /list or /search first, then /summarize note &lt;n&gt; with a valid number.');
			return;
		}
		const target = results[n - 1];
		try {
			text = vault.readNote(target.path);
			sourceLabel = target.path;
		} catch (err) {
			await ui.send(chatId, `Couldn't open that entry: ${escapeHtml(err.message)}`);
			return;
		}
	}

	if (text.trim().length < 200) {
		await ui.send(chatId, 'That is already short enough to read as-is - send at least a couple of paragraphs.');
		return;
	}

	const usingClaude = text.length > summarize.CLAUDE_LENGTH_THRESHOLD;
	const where = sourceLabel ? `<b>${escapeHtml(sourceLabel)}</b> ` : '';
	const job = await ui.progress(
		chatId,
		`⏳ Summarizing ${where}(${text.length.toLocaleString()} chars) with ${usingClaude ? 'Claude CLI' : escapeHtml(model.label)}...`,
	);
	startTyping(chatId);
	try {
		const summary = await summarize.summarize(text, model.chat);
		await job.finish(escapeHtml(summary));
	} catch (err) {
		await job.finish(`Summarize failed: ${escapeHtml(err.message)}`);
	} finally {
		stopTyping();
	}
}

async function handleNews(chatId, rawTopic) {
	if (!rawTopic) {
		await ui.send(chatId, 'Usage: /news &lt;topic&gt;');
		return;
	}
	const { modelKey, rest: topic } = parseModelOverride(rawTopic);
	const model = MODELS[modelKey];
	startTyping(chatId);
	try {
		const headlines = await news.fetchHeadlines(topic, { limit: 8 });
		if (headlines.length === 0) {
			await ui.send(chatId, `No recent news found for "${escapeHtml(topic)}".`);
			return;
		}
		const digest = await news.synthesizeDigest(headlines, model.chat);
		const links = headlines
			.map((h, i) => `${i + 1}. <a href="${escapeHtml(h.link)}">${escapeHtml(h.title)}</a> — ${escapeHtml(h.source)}`)
			.join('\n');
		const cardHtml = ui.card({ icon: '📰', title: topic, body: digest });
		await ui.send(chatId, `${cardHtml}\n\n${links}`);
	} catch (err) {
		await ui.send(chatId, `News lookup failed: ${escapeHtml(err.message)}`);
	} finally {
		stopTyping();
	}
}

// Holds a low-confidence parsed event awaiting /confirm, per chat — mirrors
// the broadcast draft pattern. Cleared once confirmed.
const pendingSchedule = new Map();

async function handleSchedule(chatId, rawText) {
	if (!rawText) {
		await ui.send(chatId, 'Usage: /schedule &lt;event, e.g. "meeting with tax team tomorrow 2pm at room 305&quot;&gt;');
		return;
	}
	const { modelKey, rest } = parseModelOverride(rawText);
	const model = MODELS[modelKey];
	startTyping(chatId);
	try {
		const event = await schedule.parseEvent(rest, model.chat);

		const ics = schedule.buildIcs(event);
		const uid = (ics.match(/^UID:(.+)$/m) || [])[1];

		// A date/time the model itself flagged as uncertain must not be
		// pushed to the calendar automatically — "Jumat depan" used to be a
		// coin flip with no way to catch a wrong guess before it landed on
		// the calendar (docs/ANALYSIS.md bug #15).
		let calendarLine;
		if (event.confidence < schedule.CONFIRM_BELOW_CONFIDENCE) {
			pendingSchedule.set(chatId, { uid, ics, event });
			calendarLine = `\n\n⚠️ Not fully sure about this date/time (confidence ${Math.round(event.confidence * 100)}%) — not added to your calendar yet. Reply /confirm to add it, or ignore and use the file below.`;
		} else {
			try {
				await radicale.pushEvent(uid, ics);
				calendarLine = '\n\n✅ Added to your calendar.';
			} catch (err) {
				calendarLine = `\n\n⚠️ Couldn't add to your calendar (${escapeHtml(err.message)}) — use the file below instead.`;
			}
		}

		const filename = `${event.title.replace(/[^\w-]+/g, '_').slice(0, 40) || 'event'}.ics`;
		await telegram.sendDocument(
			chatId,
			Buffer.from(ics, 'utf8'),
			filename,
			`📅 <b>${escapeHtml(event.title)}</b>\n${escapeHtml(event.start)} – ${escapeHtml(event.end)} WIB${event.location ? `\n📍 ${escapeHtml(event.location)}` : ''}${calendarLine}`,
		);
	} catch (err) {
		await ui.send(chatId, `Scheduling failed: ${escapeHtml(err.message)}`);
	} finally {
		stopTyping();
	}
}

async function handleScheduleConfirm(chatId) {
	const pendingEvent = pendingSchedule.get(chatId);
	if (!pendingEvent) {
		await ui.send(chatId, 'No pending event to confirm. Use /schedule first.');
		return;
	}
	try {
		await radicale.pushEvent(pendingEvent.uid, pendingEvent.ics);
		pendingSchedule.delete(chatId);
		await ui.send(chatId, `✅ Added <b>${escapeHtml(pendingEvent.event.title)}</b> to your calendar.`);
	} catch (err) {
		await ui.send(chatId, `Couldn't add to your calendar: ${escapeHtml(err.message)}`);
	}
}

function parseDocArgs(argText) {
	const sep = argText.indexOf('|');
	if (sep === -1) return { templateName: null, brief: argText.trim() };
	const templatePart = argText.slice(0, sep).trim();
	const brief = argText.slice(sep + 1).trim();
	const templateName = !templatePart || templatePart.toLowerCase() === 'default' ? null : templatePart;
	return { templateName, brief };
}

async function handleDoc(chatId, argText) {
	if (!argText || !argText.includes('|')) {
		await ui.send(chatId, 'Usage: /doc &lt;template name or &quot;default&quot;&gt; | &lt;brief&gt;\ne.g. /doc default | Memo reminder for monthly report deadline');
		return;
	}
	const { templateName, brief } = parseDocArgs(argText);
	const job = await ui.progress(
		chatId,
		`⏳ Drafting with Claude CLI${templateName ? ` using template "${escapeHtml(templateName)}"` : ' (default layout)'}... usually 1-3 min.`,
	);
	startTyping(chatId);
	try {
		const { outputPath, title, usedTemplate } = await docgen.generateWordDoc({ templateName, brief });
		await job.finish(`✅ Drafted <b>${escapeHtml(title)}</b>`);
		// Saved to OneDrive already; also send it back so it's usable right
		// away without switching devices (docs/ANALYSIS.md bug #12). A file
		// can't replace a text message via edit, so this is still a second,
		// necessary message.
		await telegram.sendDocument(
			chatId,
			fs.readFileSync(outputPath),
			path.basename(outputPath),
			`💾 <b>${escapeHtml(title)}</b>\nSaved to OneDrive: Bot Output\\${escapeHtml(path.basename(outputPath))}${usedTemplate ? '' : '\n(no matching template found — used default layout)'}`,
		);
	} catch (err) {
		await job.finish(`Doc generation failed: ${escapeHtml(err.message)}`);
	} finally {
		stopTyping();
	}
}

async function handleExcel(chatId, argText) {
	if (!argText || !argText.includes('|')) {
		await ui.send(chatId, 'Usage: /excel &lt;template name or &quot;default&quot;&gt; | &lt;brief describing the data&gt;');
		return;
	}
	const { templateName, brief } = parseDocArgs(argText);
	const job = await ui.progress(chatId, `⏳ Drafting${templateName ? ` using template "${escapeHtml(templateName)}"` : ' (new sheet)'}...`);
	startTyping(chatId);
	try {
		const { outputPath, title, usedTemplate } = await docgen.generateExcelDoc({ templateName, brief, chat: MODELS[DEFAULT_MODEL].chat });
		await job.finish(`✅ Drafted <b>${escapeHtml(title)}</b>`);
		await telegram.sendDocument(
			chatId,
			fs.readFileSync(outputPath),
			path.basename(outputPath),
			`💾 <b>${escapeHtml(title)}</b>\nSaved to OneDrive: Bot Output\\${escapeHtml(path.basename(outputPath))}${usedTemplate ? '' : '\n(no matching template found — created a new sheet)'}`,
		);
	} catch (err) {
		await job.finish(`Excel generation failed: ${escapeHtml(err.message)}`);
	} finally {
		stopTyping();
	}
}

async function runRegulationCheck(chatId, { announceNoChange = false, modelKey = 'ollamacloud' } = {}) {
	const model = MODELS[modelKey] || MODELS[DEFAULT_MODEL];
	const newItems = await regmonitor.checkForNew();
	if (newItems.length === 0) {
		if (announceNoChange) await ui.send(chatId, 'No new Kemenkeu regulations since last check.');
		return;
	}
	const overview = await regmonitor.synthesizeOverview(newItems, model.chat).catch(() => '');
	const lines = newItems
		.map((it) => `• <a href="${escapeHtml(it.url)}">${escapeHtml(it.number)}</a> — ${escapeHtml(it.title)}`)
		.join('\n');
	const cardHtml = ui.card({ icon: '📋', title: `${newItems.length} new Kemenkeu regulation(s)`, body: overview || undefined });
	await ui.send(chatId, `${cardHtml}\n\n${lines}`);
}

async function handleTemplates(chatId) {
	try {
		const items = await docgen.listTemplates();
		if (items.length === 0) {
			await ui.send(chatId, 'No templates yet. Drop .docx / .xlsx files into the OneDrive folder: Bot Templates');
			return;
		}
		const lines = items.map((it) => {
			const name = escapeHtml(path.basename(it.file, it.ext));
			const head = `\u{1F4C4} <b>${name}</b> (${it.ext.slice(1)})`;
			if (it.tags === null) return `${head}\n   ⚠️ could not be read`;
			if (it.tags.length === 0) return `${head}\n   no {placeholders} — will be copied unchanged`;
			return `${head}\n   fills: ${it.tags.map((t) => escapeHtml('{' + t + '}')).join(', ')}`;
		});
		await ui.send(
			chatId,
			`<b>Your templates</b> (OneDrive → Bot Templates)\n\n${lines.join('\n\n')}\n\nUse one: /doc &lt;part of the name&gt; | &lt;brief&gt;\nPut {title} {content} {date} {author} in the file where text should go.`,
		);
	} catch (err) {
		await ui.send(chatId, `Could not list templates: ${escapeHtml(err.message)}`);
	}
}

async function handleRegcheck(chatId, modelKeyArg) {
	startTyping(chatId);
	try {
		await runRegulationCheck(chatId, { announceNoChange: true, modelKey: MODELS[modelKeyArg] ? modelKeyArg : modelForJob('regcheck') });
	} catch (err) {
		await ui.send(chatId, `Regulation check failed: ${escapeHtml(err.message)}`);
	} finally {
		stopTyping();
	}
}

async function handleBanner(chatId, rawKeyword) {
	if (!rawKeyword) {
		await ui.send(chatId, 'Usage: /banner &lt;keyword&gt;, e.g. /banner office christmas celebration');
		return;
	}
	const { modelKey, rest: keyword } = parseModelOverride(rawKeyword, 'banner');
	const model = MODELS[modelKey];
	startTyping(chatId);
	try {
		const query = await images.refineKeyword(keyword, model.chat);
		// sendMediaGroup requires 2-10 items and errors on anything else
		// (docs/ANALYSIS.md bug #6) — a single result needs sendPhoto instead.
		const photos = (await images.searchImages(query, { perPage: 6 })).slice(0, 10);
		const caption = `🎨 Search: <b>${escapeHtml(query)}</b>`;
		if (photos.length === 0) {
			await ui.send(chatId, `No images found for "${escapeHtml(query)}".`);
		} else if (photos.length === 1) {
			await telegram.sendPhoto(chatId, photos[0].imageUrl, caption);
		} else {
			await telegram.sendMediaGroup(
				chatId,
				photos.map((p, i) => (i === 0 ? { url: p.imageUrl, caption } : { url: p.imageUrl })),
			);
		}
	} catch (err) {
		await ui.send(chatId, `Banner search failed: ${escapeHtml(err.message)}`);
	} finally {
		stopTyping();
	}
}

async function handleModels(chatId) {
	const lines = Object.entries(MODELS).map(
		([key, m]) => `${key === DEFAULT_MODEL ? '⭐' : '  '} <b>${escapeHtml(key)}</b> — ${escapeHtml(m.label)}`,
	);
	await ui.send(
		chatId,
		`Available models (⭐ = default):\n\n${lines.join('\n')}\n\nOverride per message: "&lt;model&gt;: your idea", e.g. "groq: summarize this trend".`,
	);
}

async function handlePdf(chatId, rawInput) {
	if (!rawInput) {
		await ui.send(chatId, 'Usage: /pdf (link or document title)');
		return;
	}
	const { modelKey, rest: input } = parseModelOverride(rawInput);
	const model = MODELS[modelKey];
	const job = await ui.progress(chatId, `⏳ Looking up "${escapeHtml(input)}"...`);
	startTyping(chatId);
	try {
		const url = await pdf.resolvePdfUrl(input);
		await job.update(`⏳ Found: ${escapeHtml(url)}\nDownloading and extracting text...`);
		const { buffer, finalUrl } = await pdf.fetchPdfBuffer(url);
		const text = await pdf.extractText(buffer);

		const title = input.length < 80 && !pdf.isUrl(input) ? input : finalUrl.split('/').pop() || 'PDF Source';
		const usingClaude = text.length > summarize.CLAUDE_LENGTH_THRESHOLD;
		await job.update(`⏳ Summarizing (${text.length.toLocaleString()} chars) with ${usingClaude ? 'Claude CLI' : escapeHtml(model.label)}...`);
		const summary = await summarize.summarize(text, model.chat, title).catch((err) => {
			console.error('[bridge] summarize failed:', err.message);
			return null;
		});
		// Deep tier (research-capturer): real tags instead of always [], found
		// by actually reading the vault for related notes. Best-effort — a
		// slow/failing capture call must not lose the already-extracted text.
		const capture = await claude
			.runSkill('source-capture', title, {
				stdin: text,
				schema: skills.schemaFor('source-capture'),
				agent: 'research-capturer',
				addDir: knowledgeBaseDir,
				allowedTools: 'Read,Grep,Glob',
				timeoutMs: 5 * 60 * 1000,
			})
			.catch((err) => {
				console.error('[bridge] source-capture failed:', err.message);
				return null;
			});
		const tags = capture && capture.ok && Array.isArray(capture.data.tags) ? capture.data.tags : [];

		const { filePath, sidecarPath } = knowledge.writeSourceCapture({
			title,
			sourceUrl: finalUrl,
			tags,
			extractedText: text, // the full text — writeSourceCapture sidecars it to .txt itself if it's large
			summary,
			notes: '',
		});
		const summaryLine = summary ? `\n\n${summary}` : '\n\n(summary failed, but the full text was still saved)';
		const sidecarLine = sidecarPath ? `\n📄 Full text: external-sources/${path.basename(sidecarPath)}` : '';
		await job.finish(`💾 Captured "${escapeHtml(title)}" to external-sources/${path.basename(filePath)}${sidecarLine}${escapeHtml(summaryLine)}`);
	} catch (err) {
		await job.finish(`PDF capture failed: ${escapeHtml(err.message)}`);
	} finally {
		stopTyping();
	}
}

// Remembers the last /list or /search results per chat, so /get &lt;n&gt; can
// resolve a plain number to a vault file path.
const lastResults = new Map();

async function handleList(chatId) {
	const results = vault.listNotes(10);
	lastResults.set(chatId, results);
	if (results.length === 0) {
		await ui.send(chatId, 'Your vault is empty so far.');
		return;
	}
	const lines = results.map((r, i) => `${i + 1}. <b>${escapeHtml(r.title)}</b>\n   ${escapeHtml(r.path)}`);
	await ui.send(chatId, `Most recent vault entries:\n\n${lines.join('\n')}\n\nUse /get &lt;n&gt; to open one.`);
}

async function handleSearch(chatId, query) {
	if (!query) {
		await ui.send(chatId, 'Usage: /search &lt;query&gt;');
		return;
	}
	const results = vault.searchNotes(query, 10);
	lastResults.set(chatId, results);
	if (results.length === 0) {
		await ui.send(chatId, `No matches for "${escapeHtml(query)}".`);
		return;
	}
	const lines = results.map((r, i) => `${i + 1}. <b>${escapeHtml(r.title)}</b>\n   ...${escapeHtml(r.snippet)}...`);
	await ui.send(chatId, `Matches for "${escapeHtml(query)}":\n\n${lines.join('\n\n')}\n\nUse /get &lt;n&gt; to open one.`);
}

async function handleGet(chatId, arg) {
	const results = lastResults.get(chatId);
	const n = Number(arg);
	if (!results || !Number.isInteger(n) || n < 1 || n > results.length) {
		await ui.send(chatId, 'Run /list or /search first, then /get &lt;n&gt; with a valid number.');
		return;
	}
	const target = results[n - 1];
	try {
		const content = vault.readNote(target.path);
		const MAX = 3800;
		const body = content.length > MAX ? `${content.slice(0, MAX)}\n\n…(truncated, ${content.length.toLocaleString()} chars total)` : content;
		await ui.send(chatId, `<b>${escapeHtml(target.path)}</b>\n\n<pre>${escapeHtml(body)}</pre>`);
	} catch (err) {
		await ui.send(chatId, `Couldn't open that entry: ${escapeHtml(err.message)}`);
	}
}

async function handleStart(chatId) {
	const html = ui.card({
		icon: '👋',
		title: 'Idea Bridge',
		subtitle: 'Second brain pribadi via Telegram',
		sections: [
			{
				label: '📝 Catatan',
				items: ['Ketik apa saja untuk disimpan sebagai ide', '/list, /search, /get — buka catatan', '/pdf — simpan PDF', '/summarize — ringkas teks/catatan'],
			},
			{ label: '🗓 Jadwal & dokumen', items: ['/schedule — tambah ke kalender', '/doc, /excel — buat dokumen', '/templates — lihat template'] },
			{ label: '🧮 Lainnya', items: ['/calc — hitung (teks atau foto)', '/news, /regcheck, /banner', '/broadcast, /todo, /grammar, /promptgen'] },
		],
		footer: '/help untuk daftar lengkap perintah',
	});
	await ui.send(chatId, html);
}

const HELP_TEXT = [
	"Send me any idea and I'll enhance it (default model: Groq) and save it to your knowledge base.",
	'Override the model for one message: "&lt;model&gt;: your idea", e.g. "groq: summarize this trend".',
	'',
	'/list — recent vault entries',
	'/search &lt;query&gt; — search your vault',
	'/get &lt;n&gt; — open a result from /list or /search',
	'/pdf &lt;link or title&gt; — capture a PDF into the vault',
	'/grammar &lt;text&gt; — fix grammar and clarity',
	'/promptgen &lt;goal&gt; — generate a ready-to-use AI prompt',
	'/broadcast &lt;brief&gt; — draft a WhatsApp broadcast, then use the buttons to send or redraft',
	'/todo &lt;item&gt; / /todo list (✅ buttons) / /todo done &lt;n&gt; — quick to-do list',
	'/calc &lt;expr or word problem&gt; — calculate (or send a photo of a problem)',
	'/summarize &lt;text&gt; — summarize pasted text, or /summarize note &lt;n&gt; for a vault entry',
	'/news &lt;topic&gt; — recent news digest',
	'/schedule &lt;event text&gt; — generate a .ics calendar file',
	'/confirm — confirm the last /schedule event when its date/time was uncertain',
	'/doc &lt;template or &quot;default&quot;&gt; | &lt;brief&gt; — draft a Word doc into OneDrive',
	'/excel &lt;template or &quot;default&quot;&gt; | &lt;brief&gt; — draft an Excel table into OneDrive',
	'/templates — list your Word/Excel templates and the placeholders each one fills',
	'/regcheck — check now for new Kemenkeu regulations (auto-checked daily at 07:00 WIB)',
	'/banner &lt;keyword&gt; — sample stock images for a banner/design idea',
	'/models — list available models and overrides',
	'/help — this message',
].join('\n');

// Jobs run concurrently. The old single-flight queue existed because the
// default model was local Ollama on a one-core box; the default is now a
// cloud provider (~600ms), while /doc, long /summarize, and /pdf shell out
// to the Claude CLI for up to 5 minutes — serializing those blocked every
// other command.
// ponytail: no concurrency cap. Add a small limiter if a local model ever
// becomes the default again, or if Telegram rate-limits show up in the log.
function enqueue(task) {
	return Promise.resolve()
		.then(task)
		.catch((err) => console.error('[bridge] task error:', err));
}

// Which pending-payload type each callback_data prefix resolves to a
// handler for. Every button on the bot uses this same dispatch —
// (chatId, messageId, pendingEntry) in, edits the message in place.
const CALLBACK_ACTIONS = {
	bcsend: handleBroadcastSend,
	bcredraft: handleBroadcastRedraft,
	tododone: handleTodoDoneButton,
};

// callback_data is "<action>:<pendingId>" — a short id, never the payload
// itself (Telegram caps callback_data at 64 bytes; lib/pending.js holds the
// actual draft/target in .state/pending.json, docs/V2-SPEC.md §1).
async function handleCallbackQuery(cq) {
	const chatId = cq.message && cq.message.chat && cq.message.chat.id;
	const messageId = cq.message && cq.message.message_id;
	if (chatId !== allowedChatId) return;

	const [action, id] = String(cq.data || '').split(':');
	const entry = pending.get(id);
	if (!entry) {
		await telegram.answerCallbackQuery(cq.id, { text: 'Tombol ini sudah kedaluwarsa.' }).catch(() => {});
		return;
	}
	try {
		const handler = CALLBACK_ACTIONS[action];
		if (handler) await handler(chatId, messageId, entry);
		pending.remove(id);
		await telegram.answerCallbackQuery(cq.id);
	} catch (err) {
		console.error('[bridge] callback query failed:', err.message);
		pending.remove(id);
		await telegram.editMessageText(chatId, messageId, `⚠️ ${escapeHtml(err.message)}`).catch(() => {});
		await telegram.answerCallbackQuery(cq.id, { text: 'Gagal.' }).catch(() => {});
	}
}

// Tapping a command in Telegram's menu sends a bare "/cmd" with no argument.
// Instead of answering with a usage line, remember the command and treat the
// next plain message as its argument — click the menu, then just type the text.
const ARG_PROMPTS = {
	'/search': 'What should I search the vault for?',
	'/get': 'Which result number? (from the last /list or /search)',
	'/pdf': 'Send the PDF link or the document title.',
	'/grammar': 'Send the text to fix.',
	'/promptgen': 'What is the goal of the prompt?',
	'/broadcast': 'Send the brief for the WhatsApp broadcast.',
	'/calc': 'Send the expression or word problem — or a photo of it.',
	'/summarize': 'Send the text to summarize, or "note &lt;n&gt;" for a vault entry.',
	'/news': 'Which topic?',
	'/schedule': 'Describe the event, e.g. "meeting with tax team tomorrow 2pm at room 305".',
	'/doc': 'Send: &lt;template name or "default"&gt; | &lt;brief&gt;',
	'/excel': 'Send: &lt;template name or "default"&gt; | &lt;brief&gt;',
	'/banner': 'Which keyword? e.g. office christmas celebration',
};

const pendingCommand = new Map();

async function handleMessage(message) {
	const chatId = message.chat.id;
	if (chatId !== allowedChatId) return;

	if (message.photo && message.photo.length > 0) {
		const caption = (message.caption || '').trim();
		if (caption && !caption.startsWith('/calc')) return; // photo for some other purpose, ignore
		pendingCommand.delete(chatId);
		const largest = message.photo[message.photo.length - 1];
		enqueue(() => handleCalcImage(chatId, largest.file_id));
		return;
	}

	let text = (message.text || '').trim();
	if (!text) return;

	if (ARG_PROMPTS[text]) {
		pendingCommand.set(chatId, text);
		await ui.send(chatId, ARG_PROMPTS[text], { reply_markup: { force_reply: true, selective: true } });
		return;
	}
	if (text.startsWith('/')) {
		pendingCommand.delete(chatId); // a new command cancels a pending prompt
	} else if (pendingCommand.has(chatId)) {
		text = `${pendingCommand.get(chatId)} ${text}`;
		pendingCommand.delete(chatId);
	}

	if (text === '/start') {
		enqueue(() => handleStart(chatId));
		return;
	}
	if (text === '/help') {
		enqueue(() => ui.send(chatId, HELP_TEXT));
		return;
	}
	if (text === '/list') {
		enqueue(() => handleList(chatId));
		return;
	}
	if (text.startsWith('/search')) {
		enqueue(() => handleSearch(chatId, text.slice('/search'.length).trim()));
		return;
	}
	if (text.startsWith('/get')) {
		enqueue(() => handleGet(chatId, text.slice('/get'.length).trim()));
		return;
	}
	if (text.startsWith('/pdf')) {
		enqueue(() => handlePdf(chatId, text.slice(4).trim()));
		return;
	}
	if (text === '/templates') {
		enqueue(() => handleTemplates(chatId));
		return;
	}
	if (text === '/models') {
		enqueue(() => handleModels(chatId));
		return;
	}
	if (text.startsWith('/grammar')) {
		enqueue(() =>
			runSkillJob(chatId, text.slice('/grammar'.length).trim(), {
				skillName: 'grammar-fix',
				verb: 'Grammar check',
				usage: 'Usage: /grammar &lt;text&gt;',
				render: (r) => r.corrected,
			}),
		);
		return;
	}
	if (text.startsWith('/promptgen')) {
		enqueue(() =>
			runSkillJob(chatId, text.slice('/promptgen'.length).trim(), {
				skillName: 'prompt-gen',
				verb: 'Prompt generation',
				usage: 'Usage: /promptgen &lt;goal&gt;',
			}),
		);
		return;
	}
	if (text.startsWith('/broadcast')) {
		enqueue(() => handleBroadcast(chatId, text.slice('/broadcast'.length).trim()));
		return;
	}
	if (text === '/confirm') {
		enqueue(() => handleScheduleConfirm(chatId));
		return;
	}
	if (text.startsWith('/todo')) {
		enqueue(() => handleTodo(chatId, text.slice('/todo'.length).trim()));
		return;
	}
	if (text.startsWith('/calc')) {
		enqueue(() => handleCalc(chatId, text.slice('/calc'.length).trim()));
		return;
	}
	if (text.startsWith('/summarize')) {
		enqueue(() => handleSummarize(chatId, text.slice('/summarize'.length).trim()));
		return;
	}
	if (text.startsWith('/news')) {
		enqueue(() => handleNews(chatId, text.slice('/news'.length).trim()));
		return;
	}
	if (text.startsWith('/schedule')) {
		enqueue(() => handleSchedule(chatId, text.slice('/schedule'.length).trim()));
		return;
	}
	if (text.startsWith('/doc')) {
		enqueue(() => handleDoc(chatId, text.slice('/doc'.length).trim()));
		return;
	}
	if (text.startsWith('/excel')) {
		enqueue(() => handleExcel(chatId, text.slice('/excel'.length).trim()));
		return;
	}
	if (text.startsWith('/regcheck')) {
		enqueue(() => handleRegcheck(chatId, text.slice('/regcheck'.length).trim()));
		return;
	}
	if (text.startsWith('/banner')) {
		enqueue(() => handleBanner(chatId, text.slice('/banner'.length).trim()));
		return;
	}
	if (text.startsWith('/')) {
		await ui.send(chatId, `Unknown command. ${HELP_TEXT}`);
		return;
	}
	enqueue(() => handleIdea(chatId, text));
}

async function pollLoop() {
	try {
		await telegram.setMyCommands(BOT_COMMANDS);
		await telegram.setMyDescription(BOT_DESCRIPTION);
		await telegram.setMyShortDescription(BOT_SHORT_DESCRIPTION);
		console.log('[bridge] command menu and description updated');
	} catch (err) {
		console.error('[bridge] failed to update command menu/description:', err.message);
	}

	let offset = loadOffset();
	console.log('[bridge] polling started, offset =', offset);
	for (;;) {
		try {
			const updates = await telegram.getUpdates(offset);
			for (const update of updates) {
				offset = update.update_id + 1;
				saveOffset(offset);
				if (update.message) handleMessage(update.message).catch((err) => console.error('[bridge] handleMessage error:', err));
				if (update.callback_query) handleCallbackQuery(update.callback_query).catch((err) => console.error('[bridge] handleCallbackQuery error:', err));
			}
		} catch (err) {
			console.error('[bridge] poll error:', err.message);
			await new Promise((r) => setTimeout(r, 5000));
		}
	}
}

module.exports = { handleMessage, handleCallbackQuery, pendingCommand, syncVaultQuietly };

if (require.main === module) {
	// One-time migration of pre-.state/ files (bug #7: seen-regulations.json
	// used to live at the repo root, tracked in git and rewritten daily).
	// A no-op once each file has been moved once, so this is safe on every boot.
	state.migrateLegacyFile(path.join(__dirname, '.offset'), 'offset');
	state.migrateLegacyFile(path.join(__dirname, 'seen-regulations.json'), 'seen-regulations.json');

	// The daily run is unattended, so its failures must reach Telegram rather
	// than only the log - a broken scraper otherwise looks exactly like a quiet
	// news day. enqueue() swallows errors by design, so catch before it does.
	regmonitor.scheduleDaily(7, () =>
		enqueue(() =>
			runRegulationCheck(allowedChatId, { announceNoChange: false, modelKey: modelForJob('regcheck') }).catch((err) => {
				const prefix =
					err.name === 'ScrapeError'
						? '\u{1F527} <b>Regulation scraper is broken</b>'
						: '⚠️ <b>Daily regulation check failed</b>';
				return ui.send(allowedChatId, prefix + '\n\n' + escapeHtml(err.message)).catch(() => {});
			}),
		),
	);
	console.log('[bridge] regulation monitor scheduled for 07:00 WIB daily');

	pollLoop();
}
