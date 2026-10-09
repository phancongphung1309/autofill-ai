// Asks Chrome's built-in AI (see nano.js) what an unrecognised field expects
// (e.g. name="lotAndPlan") and for realistic values. Loaded by background.js.

importScripts("nano.js");

const AI_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const AI_CACHE_MAX = 500;

function cacheKey(field) {
	const f = field.field;
	return [
		field.page.host,
		f.tag,
		f.type,
		f.name,
		f.id,
		f.label,
		f.placeholder,
	].join("|");
}

async function readAiCache() {
	const { aiCache = {} } = await chrome.storage.local.get("aiCache");
	return aiCache;
}

async function writeAiCache(key, entry) {
	const cache = await readAiCache();
	cache[key] = { ...entry, at: Date.now() };
	const keys = Object.keys(cache);
	if (keys.length > AI_CACHE_MAX) {
		keys.sort((a, b) => cache[a].at - cache[b].at);
		for (const k of keys.slice(0, keys.length - AI_CACHE_MAX)) delete cache[k];
	}
	await chrome.storage.local.set({ aiCache: cache });
}

// Some Chrome versions don't expose LanguageModel to extension service
// workers. In that case, run the model in a hidden offscreen page instead.
let offscreenReady = null;
function ensureOffscreen() {
	offscreenReady ??= (async () => {
		const existing = await chrome.runtime.getContexts({
			contextTypes: ["OFFSCREEN_DOCUMENT"],
		});
		if (existing.length) return;
		await chrome.offscreen.createDocument({
			url: "offscreen.html",
			reasons: ["WORKERS"],
			justification:
				"Run Chrome's on-device Prompt API, which this service worker cannot access.",
		});
	})().catch((err) => {
		offscreenReady = null;
		throw err;
	});
	return offscreenReady;
}

async function viaOffscreen(type, payload) {
	await ensureOffscreen();
	const res = await chrome.runtime.sendMessage({ target: "offscreen", type, ...payload });
	if (!res?.ok) throw new Error(res?.error || "Offscreen AI did not respond");
	return res.result;
}

const aiAvailability = () =>
	Nano.supported() ? Nano.availability() : viaOffscreen("availability", {});

const aiPrompt = (field) =>
	Nano.supported() ? Nano.suggest(field) : viaOffscreen("suggest", { field });

// fresh=true skips the cache (used by the dropdown's Shuffle button).
async function aiSuggest(field, { fresh = false } = {}) {
	const { ai } = await chrome.storage.sync.get({ ai: true });
	if (!ai) return { fillable: false, disabled: true };

	const key = cacheKey(field);
	if (!fresh) {
		const hit = (await readAiCache())[key];
		if (hit && Date.now() - hit.at < AI_CACHE_TTL_MS) return hit;
	}
	// The model must be downloaded from the popup first (needs a user click).
	if ((await aiAvailability()) !== "available") {
		return { fillable: false, disabled: true };
	}
	const result = await aiPrompt(field);
	await writeAiCache(key, result);
	return result;
}
