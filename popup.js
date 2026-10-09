const DEFAULTS = { enabled: true, mode: 'manual', nat: 'us' };

const enabledEl = document.getElementById('enabled');
const natEl = document.getElementById('nat');
const statusEl = document.getElementById('status');
const modeEls = document.querySelectorAll('input[name="mode"]');

function render(s) {
  enabledEl.checked = s.enabled;
  document.body.classList.toggle('disabled', !s.enabled);
  modeEls.forEach((el) => { el.checked = el.value === s.mode; });
  natEl.value = s.nat;
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
