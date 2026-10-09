const DEFAULTS = { enabled: true, mode: 'manual', nat: 'us', ai: true, dateFormat: 'YYYY-MM-DD',
  priceMin: 300000, priceMax: 900000 };

const enabledEl = document.getElementById('enabled');
const natEl = document.getElementById('nat');
const dateFormatEl = document.getElementById('dateFormat');
const priceMinEl = document.getElementById('priceMin');
const priceMaxEl = document.getElementById('priceMax');
const statusEl = document.getElementById('status');
const aiEl = document.getElementById('ai');
const aiStatusEl = document.getElementById('aiStatus');
const modeEls = document.querySelectorAll('input[name="mode"]');

function render(s) {
  enabledEl.checked = s.enabled;
  document.body.classList.toggle('disabled', !s.enabled);
  modeEls.forEach((el) => { el.checked = el.value === s.mode; });
  natEl.value = s.nat;
  aiEl.checked = s.ai;
  dateFormatEl.value = s.dateFormat;
  priceMinEl.value = s.priceMin;
  priceMaxEl.value = s.priceMax;
}

chrome.storage.sync.get(DEFAULTS, render);

enabledEl.addEventListener('change', () => {
  chrome.storage.sync.set({ enabled: enabledEl.checked });
  document.body.classList.toggle('disabled', !enabledEl.checked);
});

modeEls.forEach((el) =>
  el.addEventListener('change', () => chrome.storage.sync.set({ mode: el.value }))
);

async function refresh() {
  statusEl.textContent = 'Fetching…';
  const res = await chrome.runtime.sendMessage({ type: 'refreshData' });
  statusEl.textContent = res?.ok ? `Loaded ${res.size} profiles.` : `Failed: ${res?.error}`;
}

natEl.addEventListener('change', async () => {
  await chrome.storage.sync.set({ nat: natEl.value });
  refresh();
});

document.getElementById('refresh').addEventListener('click', refresh);

function savePriceRange() {
  let min = Math.max(0, Number(priceMinEl.value) || 0);
  let max = Math.max(0, Number(priceMaxEl.value) || 0);
  if (max < min) [min, max] = [max, min];
  priceMinEl.value = min;
  priceMaxEl.value = max;
  chrome.storage.sync.set({ priceMin: min, priceMax: max });
}
priceMinEl.addEventListener('change', savePriceRange);
priceMaxEl.addEventListener('change', savePriceRange);

dateFormatEl.addEventListener('change', () =>
  chrome.storage.sync.set({ dateFormat: dateFormatEl.value })
);

// ---------- AI ----------

const downloadEl = document.getElementById('downloadAi');

const AI_STATUS = {
  unsupported: "This Chrome doesn't have built-in AI. Update to Chrome 138+ (desktop).",
  unavailable:
    "Your device can't run Chrome's built-in AI (needs 22 GB free disk and a GPU with 4 GB+ VRAM, or 16 GB RAM).",
  downloadable: 'One-time model download needed (a few GB, then works offline).',
  downloading: 'Model is downloading…',
  available: 'Ready ✓ Unknown fields are handled on-device.',
};

async function renderAi() {
  let state;
  try {
    state = await Nano.availability();
  } catch (err) {
    state = 'unsupported';
  }
  aiStatusEl.textContent = AI_STATUS[state] || state;
  downloadEl.hidden = !(state === 'downloadable' || state === 'downloading');
}
renderAi();

aiEl.addEventListener('change', () => chrome.storage.sync.set({ ai: aiEl.checked }));

// Downloading needs a user click, so it has to start here rather than in the background.
downloadEl.addEventListener('click', async () => {
  downloadEl.disabled = true;
  aiStatusEl.textContent = 'Starting download…';
  try {
    await Nano.download((p) => {
      aiStatusEl.textContent = `Downloading model… ${Math.round(p * 100)}% (you can close this popup)`;
    });
  } catch (err) {
    aiStatusEl.textContent = `Download failed: ${err.message}`;
  }
  downloadEl.disabled = false;
  renderAi();
});

document.getElementById('clearAi').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'clearAiCache' });
  aiStatusEl.textContent = 'AI cache cleared.';
});
