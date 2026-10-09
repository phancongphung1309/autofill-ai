// Watches for focus on inputs and either fills them (auto mode) or shows a
// suggestion dropdown below them (manual mode).
(() => {
  const { detect } = globalThis.AutofillDetector;
  const OPTION_COUNT = 4;

  let settings = { enabled: true, mode: 'manual' };
  // One "anchor" profile per page keeps related fields consistent
  // (first name, last name and email all belong to the same person).
  let anchorProfile = null;
  let anchorPromise = null;

  chrome.storage.sync.get(settings, (s) => { settings = { ...settings, ...s }; });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const [k, { newValue }] of Object.entries(changes)) settings[k] = newValue;
    if ('nat' in changes) { anchorProfile = null; anchorPromise = null; }
    if (!settings.enabled || settings.mode !== 'manual') dropdown.hide();
  });

  // ---------- data ----------

  async function requestProfiles(count) {
    const res = await chrome.runtime.sendMessage({ type: 'getProfiles', count });
    if (!res?.ok) throw new Error(res?.error || 'No response from extension');
    return res.profiles;
  }

  function getAnchor() {
    if (anchorProfile) return Promise.resolve(anchorProfile);
    anchorPromise ??= requestProfiles(1)
      .then(([p]) => (anchorProfile = p))
      .finally(() => { anchorPromise = null; });
    return anchorPromise;
  }

  function formatValue(el, key, profile) {
    let value = profile[key];
    if (value == null) return '';
    if (key === 'dob' && el.type !== 'date') {
      const [y, m, d] = value.split('-');
      const hint = (el.placeholder || '').toLowerCase();
      if (/^dd/.test(hint)) value = `${d}/${m}/${y}`;
      else if (/^mm/.test(hint)) value = `${m}/${d}/${y}`;
    }
    if (el.type === 'number') value = value.replace(/\D/g, '');
    if (el.maxLength > 0) value = value.slice(0, el.maxLength);
    return value;
  }

  const SUBTITLE = {
    city: (p) => `${p.state}, ${p.country}`,
    state: (p) => p.country,
    country: () => '',
    zip: (p) => `${p.city}, ${p.state}`,
    address: (p) => `${p.city}, ${p.state}`,
    address2: (p) => p.address,
    fullName: (p) => p.email,
    firstName: (p) => p.fullName,
    lastName: (p) => p.fullName,
  };
  const subtitleFor = (key, p) => (SUBTITLE[key] || ((x) => x.fullName))(p);

  // ---------- writing values ----------

  // Use the native setter + events so React/Vue/Angular-controlled inputs
  // pick up the change, not just the DOM.
  function setValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const isEmpty = (el) => el.value.trim() === '';

  // ---------- auto mode ----------

  async function autoFill(el, key) {
    try {
      const profile = await getAnchor();
      // Re-check: the user may have typed while we were fetching.
      if (isEmpty(el)) setValue(el, formatValue(el, key, profile));
    } catch (err) {
      console.warn('[AutoFill AI]', err.message);
    }
  }

  // ---------- manual mode dropdown ----------

  const dropdown = (() => {
    let host = null;
    let root = null;
    let target = null;
    let fieldKey = null;
    let items = [];
    let active = -1;
    let token = 0;

    function ensure() {
      if (host) return;
      host = document.createElement('div');
      host.setAttribute('data-autofill-ai', '');
      host.style.cssText = 'position:absolute;top:0;left:0;z-index:2147483647;display:none;';
      root = host.attachShadow({ mode: 'closed' });
      root.innerHTML = `
        <style>
          .box { font: 13px/1.35 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color: #111827;
                 background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden;
                 box-shadow: 0 10px 25px -5px rgba(0,0,0,.15), 0 4px 6px -4px rgba(0,0,0,.1); }
          .head { display: flex; justify-content: space-between; align-items: center; padding: 6px 10px;
                  font-size: 11px; color: #6b7280; background: #f9fafb; border-bottom: 1px solid #f3f4f6; }
          .head button { all: unset; cursor: pointer; color: #4f46e5; font-size: 11px; }
          .head button:hover { text-decoration: underline; }
          ul { list-style: none; margin: 0; padding: 4px 0; }
          li { padding: 6px 10px; cursor: pointer; }
          li.active { background: #eef2ff; }
          .v { font-weight: 500; }
          .s { font-size: 11px; color: #6b7280; }
          .msg { padding: 8px 10px; color: #6b7280; }
        </style>
        <div class="box">
          <div class="head"><span class="title"></span><button type="button" class="more">↻ Shuffle</button></div>
          <div class="body"></div>
        </div>`;
      // Keep focus on the input while interacting with the dropdown.
      root.addEventListener('mousedown', (e) => e.preventDefault());
      root.querySelector('.more').addEventListener('click', () => load());
      root.querySelector('.body').addEventListener('click', (e) => {
        const li = e.target.closest('li');
        if (li) choose(Number(li.dataset.i));
      });
      document.documentElement.appendChild(host);
    }

    function position() {
      if (!target || !host) return;
      const r = target.getBoundingClientRect();
      host.style.top = `${r.bottom + window.scrollY + 4}px`;
      host.style.left = `${r.left + window.scrollX}px`;
      host.style.width = `${Math.max(r.width, 240)}px`;
    }

    function render(html) {
      root.querySelector('.body').innerHTML = html;
    }

    function escape(s) {
      return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    }

    async function load() {
      const my = ++token;
      render('<div class="msg">Loading suggestions…</div>');
      try {
        const profiles = await requestProfiles(OPTION_COUNT + 2);
        if (my !== token) return;
        // Offer the page's anchor profile first so related fields stay consistent.
        if (anchorProfile) profiles.unshift(anchorProfile);
        const seen = new Set();
        items = [];
        for (const p of profiles) {
          const value = formatValue(target, fieldKey, p);
          if (!value || seen.has(value)) continue;
          seen.add(value);
          items.push({ value, profile: p });
          if (items.length === OPTION_COUNT) break;
        }
        active = 0;
        render(
          `<ul>${items
            .map((it, i) => {
              const sub = subtitleFor(fieldKey, it.profile);
              return `<li data-i="${i}" class="${i === active ? 'active' : ''}">
                        <div class="v">${escape(it.value)}</div>
                        ${sub ? `<div class="s">${escape(sub)}</div>` : ''}
                      </li>`;
            })
            .join('')}</ul>`
        );
      } catch (err) {
        if (my === token) render(`<div class="msg">Couldn't load data: ${escape(err.message)}</div>`);
      }
    }

    function highlight(i) {
      if (!items.length) return;
      active = (i + items.length) % items.length;
      root.querySelectorAll('li').forEach((li, idx) => li.classList.toggle('active', idx === active));
    }

    function choose(i) {
      const it = items[i];
      if (!it || !target) return;
      anchorProfile = it.profile;
      setValue(target, it.value);
      hide();
    }

    function show(el, key) {
      ensure();
      target = el;
      fieldKey = key;
      items = [];
      root.querySelector('.title').textContent = `AutoFill AI · ${key.replace(/([A-Z])/g, ' $1').toLowerCase()}`;
      host.style.display = 'block';
      position();
      load();
    }

    function hide() {
      token++;
      target = null;
      items = [];
      if (host) host.style.display = 'none';
    }

    function onKeydown(e) {
      if (!target || e.target !== target || !items.length) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); highlight(active + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(active - 1); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); choose(active); }
      else if (e.key === 'Escape') hide();
    }

    return { show, hide, position, onKeydown, get target() { return target; } };
  })();

  // ---------- event wiring ----------

  function handleFocus(e) {
    const el = e.composedPath()[0];
    if (!settings.enabled) return;
    const key = detect(el);
    if (!key || !isEmpty(el)) return; // keep existing values untouched
    if (settings.mode === 'auto') autoFill(el, key);
    else dropdown.show(el, key);
  }

  document.addEventListener('focusin', handleFocus, true);
  // Clicking an already-focused input (e.g. after Escape) reopens the list.
  document.addEventListener('click', (e) => {
    const el = e.composedPath()[0];
    if (el === document.activeElement && el !== dropdown.target) handleFocus(e);
  }, true);

  document.addEventListener('focusout', (e) => {
    if (e.composedPath()[0] === dropdown.target) dropdown.hide();
  }, true);

  // In manual mode, the user clearing a field brings suggestions back;
  // typing their own value hides them.
  document.addEventListener('input', (e) => {
    if (!e.isTrusted) return; // ignore our own synthetic events
    const el = e.composedPath()[0];
    if (!settings.enabled || settings.mode !== 'manual') return;
    if (el === dropdown.target && !isEmpty(el)) dropdown.hide();
    else if (el === document.activeElement && el !== dropdown.target && isEmpty(el)) handleFocus(e);
  }, true);

  document.addEventListener('keydown', (e) => dropdown.onKeydown(e), true);
  window.addEventListener('scroll', () => dropdown.position(), true);
  window.addEventListener('resize', () => dropdown.position());
})();
