const fs = require('fs');
const path = require('path');
const { allowedChatId } = require('./lib/config');
const telegram = require('./lib/telegram');
const knowledge = require('./lib/knowledge');
const pdf = require('./lib/pdf');
const vault = require('./lib/vault');
const enhance = require('./lib/enhance');
const jobs = require('./lib/jobs');
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
const os = require('os');
const { MODELS, DEFAULT_MODEL, modelForJob, parseModelOverride } = require('./lib/models');

const BOT_COMMANDS = [
	{ command: 'start', description: 'Show what this bot does' },
	{ command: 'list', description: 'List your most recent vault entries' },
	{ command: 'search', description: 'Search your vault: /search <query>' },
	{ command: 'get', description: 'Open a result by number: /get <n>' },
	{ command: 'pdf', description: 'Capture a PDF: /pdf <link or title>' },
	{ command: 'calc', description: 'Calculate: /calc <expr or word problem>, or send a photo' },
	{ command: 'summarize', description: 'Summarize text or a vault note: /summarize <text | note n>' },
	{ command: 'news', description: 'News digest: /news <topic>' },
	{ command: 'schedule', description: 'Add to calendar: /schedule <freeform event text>' },
	{ command: 'doc', description: 'Draft a Word doc: /doc <template or "default"> | <brief>' },
	{ command: 'excel', description: 'Draft an Excel table: /excel <template or "default"> | <brief>' },
	{ command: 'templates', description: 'List your .docx/.xlsx templates and their placeholders' },
	{ command: 'regcheck', description: 'Check now for new Kemenkeu/DJP regulations' },
	{ command: 'banner', description: 'Sample images for a banner: /banner <keyword>' },
	{ command: 'grammar', description: 'Fix grammar: /grammar <text>' },
	{ command: 'promptgen', description: 'Generate a prompt: /promptgen <goal>' },
	{ command: 'broadcast', description: 'Draft a WA broadcast: /broadcast <brief>' },
	{ command: 'send', description: 'Send the last /broadcast draft to your WhatsApp group' },
	{ command: 'confirm', description: 'Confirm the last low-confidence /schedule event' },
	{ command: 'todo', description: '/todo <item>, /todo list, /todo done <n>' },
	{ command: 'models', description: 'List available models for overrides' },
	{ command: 'help', description: 'Show available commands' },
];

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
	await telegram.sendMessage(chatId, `Got it. Enhancing this idea with <b>${escapeHtml(model.label)}</b>...`);
	startTyping(chatId);
	try {
		const { title, tags, body } = await enhance.enhanceIdea(rest, model.chat);
		const filePath = knowledge.writeIdeaNote({ title, tags, rawIdea: rest, enhancedBody: body });
		await telegram.sendMessage(
			chatId,
			`<b>${escapeHtml(title)}</b>\n\n${escapeHtml(body)}\n\n💾 Saved to notes/${path.basename(filePath)}`,
		);
		// Fire-and-forget: the note is already saved locally, so a slow (or
		// failing) push must never delay or fail the reply (docs/ANALYSIS.md
		// bug #5). syncVaultQuietly itself never rejects.
		syncVaultQuietly(`Add idea: ${title}`);
	} catch (err) {
		await telegram.sendMessage(chatId, `Enhancement failed: ${escapeHtml(err.message)}`);
	} finally {
		stopTyping();
	}
}

// Generic runner for single-turn text jobs (grammar, prompt-gen, broadcast):
// a system prompt + user text in, model reply out. Supports the same
// "<model>: text" override as idea enhancement.
async function runSimpleJob(chatId, argText, { systemPrompt, verb, usage }) {
	if (!argText) {
		await telegram.sendMessage(chatId, usage);
		return;
	}
	const { modelKey, rest } = parseModelOverride(argText);
	const model = MODELS[modelKey];
	startTyping(chatId);
	try {
		const result = await model.chat([
			{ role: 'system', content: systemPrompt },
			{ role: 'user', content: rest },
		]);
		await telegram.sendMessage(chatId, escapeHtml(result));
	} catch (err) {
		await telegram.sendMessage(chatId, `${verb} failed: ${escapeHtml(err.message)}`);
	} finally {
		stopTyping();
	}
}

// Remembers the last drafted broadcast per chat, so /send can confirm and
// actually post it without re-drafting.
const lastBroadcastDraft = new Map();

async function handleBroadcast(chatId, argText) {
	if (!argText) {
		await telegram.sendMessage(chatId, 'Usage: /broadcast &lt;brief&gt;');
		return;
	}
	const { modelKey, rest } = parseModelOverride(argText);
	const model = MODELS[modelKey];
	startTyping(chatId);
	try {
		const draft = await model.chat([
			{ role: 'system', content: jobs.BROADCAST_PROMPT },
			{ role: 'user', content: rest },
		]);
		lastBroadcastDraft.set(chatId, draft);
		await telegram.sendMessage(chatId, `${escapeHtml(draft)}\n\n— Send this to the group with /send, or /broadcast again to redraft.`);
	} catch (err) {
		await telegram.sendMessage(chatId, `Broadcast draft failed: ${escapeHtml(err.message)}`);
	} finally {
		stopTyping();
	}
}

async function handleSend(chatId) {
	const draft = lastBroadcastDraft.get(chatId);
	if (!draft) {
		await telegram.sendMessage(chatId, 'No broadcast draft to send. Use /broadcast &lt;brief&gt; first.');
		return;
	}
	try {
		await whatsapp.sendToGroup(draft);
		lastBroadcastDraft.delete(chatId);
		await telegram.sendMessage(chatId, '✅ Sent to the WhatsApp group.');
	} catch (err) {
		await telegram.sendMessage(chatId, `Send failed: ${escapeHtml(err.message)}`);
	}
}

// The numbers in a /todo list are positions, and completing an item
// renumbers everything below it. Remembering what was actually shown lets
// "done 2" close the item the user read as 2, even if the list moved since.
const lastTodoListing = new Map();

async function handleTodo(chatId, arg) {
	const [sub, ...restParts] = arg.split(/\s+/);
	const rest = restParts.join(' ').trim();

	if (arg === 'list' || arg === '') {
		const items = todo.listItems();
		lastTodoListing.set(chatId, items.map((it) => it.text));
		if (items.length === 0) {
			await telegram.sendMessage(chatId, 'No open to-dos. Add one: /todo &lt;item&gt;');
			return;
		}
		const lines = items.map((it, i) => `${i + 1}. ${escapeHtml(it.text)}`);
		await telegram.sendMessage(chatId, `Open to-dos:\n\n${lines.join('\n')}\n\nMark done: /todo done &lt;n&gt;`);
		return;
	}
	if (sub === 'done') {
		const n = Number(rest);
		if (!Number.isInteger(n) || n < 1) {
			await telegram.sendMessage(chatId, 'Usage: /todo done &lt;n&gt; — the number from /todo list.');
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
			await telegram.sendMessage(chatId, `✅ Done: ${escapeHtml(text)}`);
		} catch (err) {
			await telegram.sendMessage(chatId, escapeHtml(err.message) + '\n\nRun /todo list to see current numbers.');
		}
		return;
	}
	todo.addItem(arg);
	await syncVaultQuietly(`Todo add: ${arg}`);
	await telegram.sendMessage(chatId, `➕ Added: ${escapeHtml(arg)}`);
}

async function handleCalc(chatId, argText) {
	if (!argText) {
		await telegram.sendMessage(chatId, 'Usage: /calc &lt;expression or word problem&gt;, or send a photo of a math problem.');
		return;
	}
	const { modelKey, rest } = parseModelOverride(argText);
	const model = MODELS[modelKey];
	startTyping(chatId);
	try {
		const { expression, result } = await calc.solveText(rest, model.chat);
		await telegram.sendMessage(chatId, `<code>${escapeHtml(expression)}</code> = <b>${escapeHtml(result)}</b>`);
	} catch (err) {
		await telegram.sendMessage(chatId, `Calculation failed: ${escapeHtml(err.message)}`);
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
		await telegram.sendMessage(chatId, `<code>${escapeHtml(expression)}</code> = <b>${escapeHtml(result)}</b>`);
	} catch (err) {
		await telegram.sendMessage(chatId, `Calculation failed: ${escapeHtml(err.message)}`);
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
		await telegram.sendMessage(
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
			await telegram.sendMessage(chatId, 'Run /list or /search first, then /summarize note &lt;n&gt; with a valid number.');
			return;
		}
		const target = results[n - 1];
		try {
			text = vault.readNote(target.path);
			sourceLabel = target.path;
		} catch (err) {
			await telegram.sendMessage(chatId, `Couldn't open that entry: ${escapeHtml(err.message)}`);
			return;
		}
	}

	if (text.trim().length < 200) {
		await telegram.sendMessage(chatId, 'That is already short enough to read as-is - send at least a couple of paragraphs.');
		return;
	}

	const usingClaude = text.length > summarize.CLAUDE_LENGTH_THRESHOLD;
	const where = sourceLabel ? `<b>${escapeHtml(sourceLabel)}</b> ` : '';
	await telegram.sendMessage(
		chatId,
		`Summarizing ${where}(${text.length.toLocaleString()} chars) with ${usingClaude ? 'Claude CLI' : escapeHtml(model.label)}...`,
	);
	startTyping(chatId);
	try {
		const summary = await summarize.summarize(text, model.chat);
		await telegram.sendMessage(chatId, escapeHtml(summary));
	} catch (err) {
		await telegram.sendMessage(chatId, `Summarize failed: ${escapeHtml(err.message)}`);
	} finally {
		stopTyping();
	}
}

async function handleNews(chatId, rawTopic) {
	if (!rawTopic) {
		await telegram.sendMessage(chatId, 'Usage: /news &lt;topic&gt;');
		return;
	}
	const { modelKey, rest: topic } = parseModelOverride(rawTopic);
	const model = MODELS[modelKey];
	startTyping(chatId);
	try {
		const headlines = await news.fetchHeadlines(topic, { limit: 8 });
		if (headlines.length === 0) {
			await telegram.sendMessage(chatId, `No recent news found for "${escapeHtml(topic)}".`);
			return;
		}
		const digest = await news.synthesizeDigest(headlines, model.chat);
		const links = headlines
			.map((h, i) => `${i + 1}. <a href="${escapeHtml(h.link)}">${escapeHtml(h.title)}</a> — ${escapeHtml(h.source)}`)
			.join('\n');
		await telegram.sendMessage(chatId, `<b>${escapeHtml(topic)}</b>\n\n${escapeHtml(digest)}\n\n${links}`);
	} catch (err) {
		await telegram.sendMessage(chatId, `News lookup failed: ${escapeHtml(err.message)}`);
	} finally {
		stopTyping();
	}
}

// Holds a low-confidence parsed event awaiting /confirm, per chat — mirrors
// lastBroadcastDraft/{/broadcast,/send}. Cleared once confirmed.
const pendingSchedule = new Map();

async function handleSchedule(chatId, rawText) {
	if (!rawText) {
		await telegram.sendMessage(chatId, 'Usage: /schedule &lt;event, e.g. "meeting with tax team tomorrow 2pm at room 305&quot;&gt;');
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
		await telegram.sendMessage(chatId, `Scheduling failed: ${escapeHtml(err.message)}`);
	} finally {
		stopTyping();
	}
}

async function handleScheduleConfirm(chatId) {
	const pending = pendingSchedule.get(chatId);
	if (!pending) {
		await telegram.sendMessage(chatId, 'No pending event to confirm. Use /schedule first.');
		return;
	}
	try {
		await radicale.pushEvent(pending.uid, pending.ics);
		pendingSchedule.delete(chatId);
		await telegram.sendMessage(chatId, `✅ Added <b>${escapeHtml(pending.event.title)}</b> to your calendar.`);
	} catch (err) {
		await telegram.sendMessage(chatId, `Couldn't add to your calendar: ${escapeHtml(err.message)}`);
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
		await telegram.sendMessage(chatId, 'Usage: /doc &lt;template name or &quot;default&quot;&gt; | &lt;brief&gt;\ne.g. /doc default | Memo reminder for monthly report deadline');
		return;
	}
	const { templateName, brief } = parseDocArgs(argText);
	await telegram.sendMessage(
		chatId,
		`Drafting with Claude CLI${templateName ? ` using template "${escapeHtml(templateName)}"` : ' (default layout)'}... usually 1-3 min.`,
	);
	startTyping(chatId);
	try {
		const { outputPath, title, usedTemplate } = await docgen.generateWordDoc({ templateName, brief });
		// Saved to OneDrive already; also send it back so it's usable right
		// away without switching devices (docs/ANALYSIS.md bug #12).
		await telegram.sendDocument(
			chatId,
			fs.readFileSync(outputPath),
			path.basename(outputPath),
			`💾 <b>${escapeHtml(title)}</b>\nSaved to OneDrive: Bot Output\\${escapeHtml(path.basename(outputPath))}${usedTemplate ? '' : '\n(no matching template found — used default layout)'}`,
		);
	} catch (err) {
		await telegram.sendMessage(chatId, `Doc generation failed: ${escapeHtml(err.message)}`);
	} finally {
		stopTyping();
	}
}

async function handleExcel(chatId, argText) {
	if (!argText || !argText.includes('|')) {
		await telegram.sendMessage(chatId, 'Usage: /excel &lt;template name or &quot;default&quot;&gt; | &lt;brief describing the data&gt;');
		return;
	}
	const { templateName, brief } = parseDocArgs(argText);
	await telegram.sendMessage(
		chatId,
		`Drafting with Claude CLI${templateName ? ` using template "${escapeHtml(templateName)}"` : ' (new sheet)'}... usually 1-3 min.`,
	);
	startTyping(chatId);
	try {
		const { outputPath, title, usedTemplate } = await docgen.generateExcelDoc({ templateName, brief });
		// Saved to OneDrive already; also send it back so it's usable right
		// away without switching devices (docs/ANALYSIS.md bug #12).
		await telegram.sendDocument(
			chatId,
			fs.readFileSync(outputPath),
			path.basename(outputPath),
			`💾 <b>${escapeHtml(title)}</b>\nSaved to OneDrive: Bot Output\\${escapeHtml(path.basename(outputPath))}${usedTemplate ? '' : '\n(no matching template found — created a new sheet)'}`,
		);
	} catch (err) {
		await telegram.sendMessage(chatId, `Excel generation failed: ${escapeHtml(err.message)}`);
	} finally {
		stopTyping();
	}
}

async function runRegulationCheck(chatId, { announceNoChange = false, modelKey = 'ollamacloud' } = {}) {
	const model = MODELS[modelKey] || MODELS[DEFAULT_MODEL];
	const newItems = await regmonitor.checkForNew();
	if (newItems.length === 0) {
		if (announceNoChange) await telegram.sendMessage(chatId, 'No new Kemenkeu regulations since last check.');
		return;
	}
	const overview = await regmonitor.synthesizeOverview(newItems, model.chat).catch(() => '');
	const lines = newItems
		.map((it) => `• <a href="${escapeHtml(it.url)}">${escapeHtml(it.number)}</a> — ${escapeHtml(it.title)}`)
		.join('\n');
	await telegram.sendMessage(
		chatId,
		`📋 <b>${newItems.length} new Kemenkeu regulation(s)</b>\n\n${overview ? `${escapeHtml(overview)}\n\n` : ''}${lines}`,
	);
}

async function handleTemplates(chatId) {
	try {
		const items = await docgen.listTemplates();
		if (items.length === 0) {
			await telegram.sendMessage(chatId, 'No templates yet. Drop .docx / .xlsx files into the OneDrive folder: Bot Templates');
			return;
		}
		const lines = items.map((it) => {
			const name = escapeHtml(path.basename(it.file, it.ext));
			const head = `\u{1F4C4} <b>${name}</b> (${it.ext.slice(1)})`;
			if (it.tags === null) return `${head}\n   ⚠️ could not be read`;
			if (it.tags.length === 0) return `${head}\n   no {placeholders} — will be copied unchanged`;
			return `${head}\n   fills: ${it.tags.map((t) => escapeHtml('{' + t + '}')).join(', ')}`;
		});
		await telegram.sendMessage(
			chatId,
			`<b>Your templates</b> (OneDrive → Bot Templates)\n\n${lines.join('\n\n')}\n\nUse one: /doc &lt;part of the name&gt; | &lt;brief&gt;\nPut {title} {content} {date} {author} in the file where text should go.`,
		);
	} catch (err) {
		await telegram.sendMessage(chatId, `Could not list templates: ${escapeHtml(err.message)}`);
	}
}

async function handleRegcheck(chatId, modelKeyArg) {
	startTyping(chatId);
	try {
		await runRegulationCheck(chatId, { announceNoChange: true, modelKey: MODELS[modelKeyArg] ? modelKeyArg : modelForJob('regcheck') });
	} catch (err) {
		await telegram.sendMessage(chatId, `Regulation check failed: ${escapeHtml(err.message)}`);
	} finally {
		stopTyping();
	}
}

async function handleBanner(chatId, rawKeyword) {
	if (!rawKeyword) {
		await telegram.sendMessage(chatId, 'Usage: /banner &lt;keyword&gt;, e.g. /banner office christmas celebration');
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
			await telegram.sendMessage(chatId, `No images found for "${escapeHtml(query)}".`);
		} else if (photos.length === 1) {
			await telegram.sendPhoto(chatId, photos[0].imageUrl, caption);
		} else {
			await telegram.sendMediaGroup(
				chatId,
				photos.map((p, i) => (i === 0 ? { url: p.imageUrl, caption } : { url: p.imageUrl })),
			);
		}
	} catch (err) {
		await telegram.sendMessage(chatId, `Banner search failed: ${escapeHtml(err.message)}`);
	} finally {
		stopTyping();
	}
}

async function handleModels(chatId) {
	const lines = Object.entries(MODELS).map(
		([key, m]) => `${key === DEFAULT_MODEL ? '⭐' : '  '} <b>${escapeHtml(key)}</b> — ${escapeHtml(m.label)}`,
	);
	await telegram.sendMessage(
		chatId,
		`Available models (⭐ = default):\n\n${lines.join('\n')}\n\nOverride per message: "&lt;model&gt;: your idea", e.g. "groq: summarize this trend".`,
	);
}

async function handlePdf(chatId, rawInput) {
	if (!rawInput) {
		await telegram.sendMessage(chatId, 'Usage: /pdf (link or document title)');
		return;
	}
	const { modelKey, rest: input } = parseModelOverride(rawInput);
	const model = MODELS[modelKey];
	await telegram.sendMessage(chatId, `Looking up "${escapeHtml(input)}"...`);
	startTyping(chatId);
	try {
		const url = await pdf.resolvePdfUrl(input);
		await telegram.sendMessage(chatId, `Found: ${escapeHtml(url)}\nDownloading and extracting text...`);
		const { buffer, finalUrl } = await pdf.fetchPdfBuffer(url);
		const text = await pdf.extractText(buffer);

		const title = input.length < 80 && !pdf.isUrl(input) ? input : finalUrl.split('/').pop() || 'PDF Source';
		const usingClaude = text.length > summarize.CLAUDE_LENGTH_THRESHOLD;
		await telegram.sendMessage(
			chatId,
			`Summarizing (${text.length.toLocaleString()} chars) with ${usingClaude ? 'Claude CLI' : escapeHtml(model.label)}...`,
		);
		const summary = await summarize.summarize(text, model.chat).catch((err) => {
			console.error('[bridge] summarize failed:', err.message);
			return null;
		});

		const { filePath, sidecarPath } = knowledge.writeSourceCapture({
			title,
			sourceUrl: finalUrl,
			tags: [],
			extractedText: text, // the full text — writeSourceCapture sidecars it to .txt itself if it's large
			summary,
			notes: '',
		});
		const summaryLine = summary ? `\n\n${summary}` : '\n\n(summary failed, but the full text was still saved)';
		const sidecarLine = sidecarPath ? `\n📄 Full text: external-sources/${path.basename(sidecarPath)}` : '';
		await telegram.sendMessage(
			chatId,
			`💾 Captured "${escapeHtml(title)}" to external-sources/${path.basename(filePath)}${sidecarLine}${escapeHtml(summaryLine)}`,
		);
	} catch (err) {
		await telegram.sendMessage(chatId, `PDF capture failed: ${escapeHtml(err.message)}`);
	} finally {
		stopTyping();
	}
}

function escapeHtml(s) {
	return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Remembers the last /list or /search results per chat, so /get &lt;n&gt; can
// resolve a plain number to a vault file path.
const lastResults = new Map();

async function handleList(chatId) {
	const results = vault.listNotes(10);
	lastResults.set(chatId, results);
	if (results.length === 0) {
		await telegram.sendMessage(chatId, 'Your vault is empty so far.');
		return;
	}
	const lines = results.map((r, i) => `${i + 1}. <b>${escapeHtml(r.title)}</b>\n   ${escapeHtml(r.path)}`);
	await telegram.sendMessage(chatId, `Most recent vault entries:\n\n${lines.join('\n')}\n\nUse /get &lt;n&gt; to open one.`);
}

async function handleSearch(chatId, query) {
	if (!query) {
		await telegram.sendMessage(chatId, 'Usage: /search &lt;query&gt;');
		return;
	}
	const results = vault.searchNotes(query, 10);
	lastResults.set(chatId, results);
	if (results.length === 0) {
		await telegram.sendMessage(chatId, `No matches for "${escapeHtml(query)}".`);
		return;
	}
	const lines = results.map((r, i) => `${i + 1}. <b>${escapeHtml(r.title)}</b>\n   ...${escapeHtml(r.snippet)}...`);
	await telegram.sendMessage(chatId, `Matches for "${escapeHtml(query)}":\n\n${lines.join('\n\n')}\n\nUse /get &lt;n&gt; to open one.`);
}

async function handleGet(chatId, arg) {
	const results = lastResults.get(chatId);
	const n = Number(arg);
	if (!results || !Number.isInteger(n) || n < 1 || n > results.length) {
		await telegram.sendMessage(chatId, 'Run /list or /search first, then /get &lt;n&gt; with a valid number.');
		return;
	}
	const target = results[n - 1];
	try {
		const content = vault.readNote(target.path);
		const MAX = 3800;
		const body = content.length > MAX ? `${content.slice(0, MAX)}\n\n…(truncated, ${content.length.toLocaleString()} chars total)` : content;
		await telegram.sendMessage(chatId, `<b>${escapeHtml(target.path)}</b>\n\n<pre>${escapeHtml(body)}</pre>`);
	} catch (err) {
		await telegram.sendMessage(chatId, `Couldn't open that entry: ${escapeHtml(err.message)}`);
	}
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
	'/broadcast &lt;brief&gt; — draft a WhatsApp broadcast, then /send to actually post it',
	'/todo &lt;item&gt; / /todo list / /todo done &lt;n&gt; — quick to-do list',
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
// cloud provider (~600ms), while /doc and /excel shell out to the Claude CLI
// for up to 5 minutes — serializing those blocked every other command.
// ponytail: no concurrency cap. Add a small limiter if a local model ever
// becomes the default again, or if Telegram rate-limits show up in the log.
function enqueue(task) {
	return Promise.resolve()
		.then(task)
		.catch((err) => console.error('[bridge] task error:', err));
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
		await telegram.sendMessage(chatId, ARG_PROMPTS[text], { reply_markup: { force_reply: true, selective: true } });
		return;
	}
	if (text.startsWith('/')) {
		pendingCommand.delete(chatId); // a new command cancels a pending prompt
	} else if (pendingCommand.has(chatId)) {
		text = `${pendingCommand.get(chatId)} ${text}`;
		pendingCommand.delete(chatId);
	}

	if (text === '/start' || text === '/help') {
		await telegram.sendMessage(chatId, HELP_TEXT);
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
			runSimpleJob(chatId, text.slice('/grammar'.length).trim(), {
				systemPrompt: jobs.GRAMMAR_PROMPT,
				verb: 'Grammar check',
				usage: 'Usage: /grammar &lt;text&gt;',
			}),
		);
		return;
	}
	if (text.startsWith('/promptgen')) {
		enqueue(() =>
			runSimpleJob(chatId, text.slice('/promptgen'.length).trim(), {
				systemPrompt: jobs.PROMPTGEN_PROMPT,
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
	if (text === '/send') {
		enqueue(() => handleSend(chatId));
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
		await telegram.sendMessage(chatId, `Unknown command. ${HELP_TEXT}`);
		return;
	}
	enqueue(() => handleIdea(chatId, text));
}

async function pollLoop() {
	try {
		await telegram.setMyCommands(BOT_COMMANDS);
		console.log('[bridge] command menu updated');
	} catch (err) {
		console.error('[bridge] failed to update command menu:', err.message);
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
			}
		} catch (err) {
			console.error('[bridge] poll error:', err.message);
			await new Promise((r) => setTimeout(r, 5000));
		}
	}
}

module.exports = { handleMessage, pendingCommand, syncVaultQuietly };

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
						: '\u26A0\uFE0F <b>Daily regulation check failed</b>';
				return telegram.sendMessage(allowedChatId, prefix + '\n\n' + escapeHtml(err.message)).catch(() => {});
			}),
		),
	);
	console.log('[bridge] regulation monitor scheduled for 07:00 WIB daily');

	pollLoop();
}
