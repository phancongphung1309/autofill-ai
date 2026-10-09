// Fetches fake-but-realistic profiles from randomuser.me, caches them,
// and hands them out to content scripts.

importScripts('ai.js');

const POOL_SIZE = 50;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SETTINGS = { enabled: true, mode: 'manual', nat: 'us' };
const COMPANY_SUFFIXES = ['LLC', 'Inc.', 'Group', '& Co.', 'Holdings', 'Partners'];

let inflight = null;

async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...(await chrome.storage.sync.get(DEFAULT_SETTINGS)) };
}

function toProfile(u, i) {
  const first = u.name.first;
  const last = u.name.last;
  const streetNumber = u.location.street.number;
  const slug = last.toLowerCase().normalize('NFD').replace(/[^a-z]/g, '') || 'company';
  return {
    firstName: first,
    lastName: last,
    fullName: `${first} ${last}`,
    email: u.email,
    username: u.login.username,
    phone: u.phone,
    address: `${streetNumber} ${u.location.street.name}`,
    address2: `Apt ${(streetNumber % 90) + 1}`,
    city: u.location.city,
    state: u.location.state,
    country: u.location.country,
    zip: String(u.location.postcode),
    dob: u.dob.date.slice(0, 10),
    age: String(u.dob.age),
    company: `${last} ${COMPANY_SUFFIXES[i % COMPANY_SUFFIXES.length]}`,
    website: `https://www.${slug}.com`,
  };
}

async function fetchPool(nat) {
  const url =
    `https://randomuser.me/api/?results=${POOL_SIZE}` +
    `&nat=${encodeURIComponent(nat)}&inc=name,location,email,login,dob,phone&noinfo`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`randomuser.me responded ${res.status}`);
  const { results } = await res.json();
  const pool = results.map(toProfile);
  await chrome.storage.local.set({ cache: { nat, fetchedAt: Date.now(), pool } });
  return pool;
}

async function getPool({ force = false } = {}) {
  const { nat } = await getSettings();
  const { cache } = await chrome.storage.local.get('cache');
  const fresh = cache && cache.nat === nat && Date.now() - cache.fetchedAt < CACHE_TTL_MS;
  if (!force && fresh && cache.pool.length) return cache.pool;

  // Share one network request between concurrent callers.
  inflight ??= fetchPool(nat).finally(() => { inflight = null; });
  try {
    return await inflight;
  } catch (err) {
    // Offline or API down: fall back to stale cache if we have one.
    if (cache?.pool?.length) return cache.pool;
    throw err;
  }
}

function sample(pool, count) {
  const copy = pool.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, count);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'getProfiles') {
    getPool()
      .then((pool) => sendResponse({ ok: true, profiles: sample(pool, msg.count || 1) }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // async response
  }
  if (msg?.type === 'refreshData') {
    getPool({ force: true })
      .then((pool) => sendResponse({ ok: true, size: pool.length }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg?.type === 'aiSuggest') {
    aiSuggest(msg.field, { fresh: msg.fresh })
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg?.type === 'clearAiCache') {
    chrome.storage.local.remove('aiCache').then(() => sendResponse({ ok: true }));
    return true;
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.sync.set(await getSettings());
  getPool().catch(() => {}); // warm the cache
});
