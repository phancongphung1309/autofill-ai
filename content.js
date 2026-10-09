// Watches for focus on inputs and either fills them (auto mode) or shows a
// suggestion dropdown below them (manual mode).
//
// Known fields (city, email, …) are filled from a fetched profile. Unknown
// fields (e.g. name="lotAndPlan") go to Chrome's built-in on-device AI.
(() => {
	const { detect, describe, fieldText, isFillable, isIgnored } =
		globalThis.AutofillDetector;
	const OPTION_COUNT = 4;

	let settings = {
		enabled: true,
		mode: "manual",
		ai: true,
		dateFormat: "YYYY-MM-DD",
		priceMin: 300000,
		priceMax: 900000,
	};
	// One "anchor" profile per page keeps related fields consistent
	// (first name, last name and email all belong to the same person).
	let anchorProfile = null;
	let anchorPromise = null;
	// One price per page, so a deposit can be a sensible share of it.
	let anchorPrice = null;
	// AI answers (as promises) per element, so a click reuses a preload that's
	// still running, and refocusing a field doesn't ask again.
	const aiResults = new WeakMap();
	// Set once the model reports it isn't available, to stop preloading.
	let aiUnavailable = false;
	// AI preloading state (declared up here because the settings callback
	// below can call schedulePreload() before the rest of the file has run).
	let preloadTimer = null;
	let preloading = false;
	let preloadAgain = false;

	chrome.storage.sync.get(settings, (s) => {
		settings = { ...settings, ...s };
		schedulePreload();
	});
	chrome.storage.onChanged.addListener((changes, area) => {
		if (area !== "sync") return;
		for (const [k, { newValue }] of Object.entries(changes))
			settings[k] = newValue;
		if ("priceMin" in changes || "priceMax" in changes) anchorPrice = null;
		if ("nat" in changes) {
			anchorProfile = null;
			anchorPromise = null;
		}
		if (!settings.enabled || settings.mode !== "manual") dropdown.hide();
		if ("ai" in changes || "enabled" in changes) {
			aiUnavailable = false;
			schedulePreload();
		}
	});

	// ---------- data ----------

	async function send(msg) {
		const res = await chrome.runtime.sendMessage(msg);
		if (!res?.ok) throw new Error(res?.error || "No response from extension");
		return res;
	}

	const requestProfiles = async (count) =>
		(await send({ type: "getProfiles", count })).profiles;

	function getAnchor() {
		if (anchorProfile) return Promise.resolve(anchorProfile);
		anchorPromise ??= requestProfiles(1)
			.then(([p]) => (anchorProfile = p))
			.finally(() => {
				anchorPromise = null;
			});
		return anchorPromise;
	}

	function askAi(el, { fresh = false } = {}) {
		if (!fresh && aiResults.has(el)) return aiResults.get(el);
		const promise = fetchAi(el, fresh).then(
			(result) => {
				if (result.disabled) {
					aiResults.delete(el);
					aiUnavailable = true;
				}
				return result;
			},
			(err) => {
				aiResults.delete(el);
				throw err;
			},
		);
		aiResults.set(el, promise);
		return promise;
	}

	async function fetchAi(el, fresh) {
		const field = describe(el);
		// Give the AI the fake person so its values match the rest of the form.
		try {
			const p = await getAnchor();
			field.person = {
				name: p.fullName,
				address: p.address,
				city: p.city,
				state: p.state,
				zip: p.zip,
				country: p.country,
			};
		} catch {}
		const { result } = await send({ type: "aiSuggest", field, fresh });
		return result;
	}

	// ---------- dates ----------

	// Dates don't need the AI: every date field (Offer Date, Close Date, …) uses
	// the same format. The format comes from the field's placeholder if it has
	// one (e.g. "dd/mm/yyyy"), otherwise from the popup setting.
	function dateFormatFor(el) {
		const hint = (el.placeholder || "").trim().toUpperCase();
		if (/^(DD|MM|YYYY)([\/.\- ])(DD|MM)\2(DD|MM|YYYY|YY)$/.test(hint))
			return hint;
		return settings.dateFormat;
	}

	function formatDate(el, date) {
		const pad = (n) => String(n).padStart(2, "0");
		const y = String(date.getFullYear());
		const m = pad(date.getMonth() + 1);
		const d = pad(date.getDate());
		// Native pickers only accept ISO.
		if (el.type === "date") return `${y}-${m}-${d}`;
		if (el.type === "datetime-local") return `${y}-${m}-${d}T10:00`;
		return dateFormatFor(el)
			.replace("YYYY", y)
			.replace("YY", y.slice(2))
			.replace("MM", m)
			.replace("DD", d);
	}

	const addDays = (n) => {
		const d = new Date();
		d.setHours(12, 0, 0, 0);
		d.setDate(d.getDate() + n);
		return d;
	};

	// Rough timeline so related dates stay in order: offer today, firm/conditions
	// ~10 days later, closing ~30 days later.
	function dateBaseOffset(el) {
		const text = fieldText(el);
		if (
			/\b(clos(e|ing)|completion|settlement|possession|expir\w*|end|due|deadline|move ?in)\b/.test(
				text,
			)
		)
			return 30;
		if (/\b(firm|conditions?|financ\w*|inspection)\b/.test(text)) return 10;
		return 0;
	}

	function daysLabel(n) {
		if (n === 0) return "Today";
		if (n === 1) return "Tomorrow";
		return `In ${n} days`;
	}

	function dateSource(el) {
		return {
			title: "date",
			async load() {
				const base = dateBaseOffset(el);
				return [0, 7, 14, 30].map((extra) => ({
					value: formatDate(el, addDays(base + extra)),
					sub: daysLabel(base + extra),
				}));
			},
		};
	}

	// ---------- prices ----------

	// Price, amount and cost fields get a value from the popup's price range;
	// deposits get a percentage of the page's price. No AI needed.
	function niceRound(n) {
		const step = n >= 100000 ? 5000 : n >= 10000 ? 1000 : n >= 1000 ? 100 : 10;
		return Math.max(step, Math.round(n / step) * step);
	}

	function randomPrice() {
		const min = Number(settings.priceMin) || 0;
		const max = Math.max(Number(settings.priceMax) || 0, min);
		return niceRound(min + Math.random() * (max - min));
	}

	const getAnchorPrice = () => (anchorPrice ??= randomPrice());
	const DEPOSIT_PERCENTS = [5, 10, 15, 20];
	const depositFor = (price, percent) => niceRound((price * percent) / 100);

	// Plain digits work with number inputs and most currency masks. Add cents
	// only when the placeholder shows them (e.g. "0.00").
	function formatMoney(el, n) {
		let value = String(n);
		if (el.type !== "number" && /[.,]\d{2}\s*$/.test(el.placeholder || "")) value += ".00";
		return fitValue(el, value);
	}

	function priceValue(el, key) {
		const price = getAnchorPrice();
		return formatMoney(el, key === "deposit" ? depositFor(price, DEPOSIT_PERCENTS[0]) : price);
	}

	function priceSource(el, key) {
		return {
			title: key,
			async load() {
				const price = getAnchorPrice();
				if (key === "deposit") {
					return DEPOSIT_PERCENTS.map((percent) => ({
						value: formatMoney(el, depositFor(price, percent)),
						sub: `${percent}% of ${price.toLocaleString()}`,
					}));
				}
				const prices = new Set([price]);
				// Bounded: a narrow range may not have 4 distinct round prices.
				for (let i = 0; i < 20 && prices.size < OPTION_COUNT; i++) prices.add(randomPrice());
				return [...prices].map((n) => ({
					value: formatMoney(el, n),
					sub: n.toLocaleString(),
					price: n,
				}));
			},
		};
	}

	function formatValue(el, key, profile) {
		let value = profile[key];
		if (value == null) return "";
		if (key === "dob") {
			const [y, m, d] = value.split("-").map(Number);
			value = formatDate(el, new Date(y, m - 1, d, 12));
		}
		return fitValue(el, value);
	}

	function fitValue(el, value) {
		if (el.type === "number") value = value.replace(/[^\d.-]/g, "");
		if (el.maxLength > 0) value = value.slice(0, el.maxLength);
		return value;
	}

	const SUBTITLE = {
		city: (p) => `${p.state}, ${p.country}`,
		state: (p) => p.country,
		country: () => "",
		zip: (p) => `${p.city}, ${p.state}`,
		address: (p) => `${p.city}, ${p.state}`,
		address2: (p) => p.address,
		fullName: (p) => p.email,
		firstName: (p) => p.fullName,
		lastName: (p) => p.fullName,
	};
	const subtitleFor = (key, p) => (SUBTITLE[key] || ((x) => x.fullName))(p);
	const prettyKey = (key) => key.replace(/([A-Z])/g, " $1").toLowerCase();

	// A "source" knows how to produce dropdown items for one field.
	// load(fresh) -> [{ value, sub, profile? }]
	function profileSource(el, key) {
		return {
			title: prettyKey(key),
			async load() {
				const profiles = await requestProfiles(OPTION_COUNT + 2);
				if (anchorProfile) profiles.unshift(anchorProfile);
				const seen = new Set();
				const items = [];
				for (const p of profiles) {
					const value = formatValue(el, key, p);
					if (!value || seen.has(value)) continue;
					seen.add(value);
					items.push({ value, sub: subtitleFor(key, p), profile: p });
					if (items.length === OPTION_COUNT) break;
				}
				return items;
			},
		};
	}

	function aiSource(el) {
		let key = null;
		const source = {
			title: "asking AI…",
			async load(fresh) {
				const r = await askAi(el, { fresh });
				if (!r.fillable) return null; // AI says leave it alone
				// AI recognised it as a standard field: use profile data for consistency.
				if (r.key) {
					key = r.key;
					source.title = prettyKey(key);
					return profileSource(el, key).load();
				}
				source.title = `${r.label || "field"} · AI`;
				return [
					...new Set(r.values.map((v) => fitValue(el, v)).filter(Boolean)),
				].map((value) => ({ value, sub: "" }));
			},
		};
		return source;
	}

	// ---------- writing values ----------

	// Use the native setter + events so React/Vue/Angular-controlled inputs
	// pick up the change, not just the DOM.
	function setValue(el, value) {
		const proto =
			el instanceof HTMLTextAreaElement
				? HTMLTextAreaElement.prototype
				: HTMLInputElement.prototype;
		Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
		el.dispatchEvent(new Event("input", { bubbles: true }));
		el.dispatchEvent(new Event("change", { bubbles: true }));
	}

	const isEmpty = (el) => el.value.trim() === "";

	// ---------- auto mode ----------

	async function autoFill(el, key) {
		try {
			let value = "";
			if (key === "date") {
				value = formatDate(el, addDays(dateBaseOffset(el)));
			} else if (key === "price" || key === "deposit") {
				value = priceValue(el, key);
			} else if (key) {
				value = formatValue(el, key, await getAnchor());
			} else {
				const r = await askAi(el);
				if (!r.fillable) return;
				value = r.key
					? formatValue(el, r.key, await getAnchor())
					: fitValue(el, r.values[0] || "");
			}
			// Re-check: the user may have typed while we were waiting.
			if (value && isEmpty(el)) setValue(el, value);
		} catch (err) {
			console.warn("[AutoFill AI]", err.message);
		}
	}

	// ---------- manual mode dropdown ----------

	const dropdown = (() => {
		let host = null;
		let root = null;
		let target = null;
		let source = null;
		let items = [];
		let active = -1;
		let token = 0;
		let resizeObserver = null;

		const GAP = 4; // space between the field and the box
		const MARGIN = 8; // minimum distance from the viewport edges
		const MIN_WIDTH = 240;
		const MIN_LIST_HEIGHT = 120; // below this, prefer flipping above the field

		function ensure() {
			if (host) return;
			host = document.createElement("div");
			host.setAttribute("data-autofill-ai", "");
			host.style.cssText =
				"position:fixed;top:0;left:0;z-index:2147483647;display:none;";
			root = host.attachShadow({ mode: "closed" });
			root.innerHTML = `
        <style>
          .box { font: 13px/1.35 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color: #111827;
                 background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden;
                 display: flex; flex-direction: column; box-sizing: border-box;
                 box-shadow: 0 10px 25px -5px rgba(0,0,0,.15), 0 4px 6px -4px rgba(0,0,0,.1); }
          .head { display: flex; justify-content: space-between; align-items: center; padding: 6px 10px;
                  font-size: 11px; color: #6b7280; background: #f9fafb; border-bottom: 1px solid #f3f4f6; }
          .head button { all: unset; cursor: pointer; color: #4f46e5; font-size: 11px; }
          .head button:hover { text-decoration: underline; }
          .head { flex: none; }
          .body { overflow-y: auto; min-height: 0; overscroll-behavior: contain; }
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
			root.addEventListener("mousedown", (e) => e.preventDefault());
			root.querySelector(".more").addEventListener("click", () => load(true));
			root.querySelector(".body").addEventListener("click", (e) => {
				const li = e.target.closest("li");
				if (li) choose(Number(li.dataset.i));
			});
			document.documentElement.appendChild(host);

			// Re-position when the field changes size (responsive layouts) or the
			// box changes size (suggestions loaded, shorter list).
			resizeObserver = new ResizeObserver(() => position());
			resizeObserver.observe(root.querySelector(".box"));
		}

		// Keeps the box inside the viewport: clamps it horizontally, shrinks it
		// on narrow windows, flips it above the field when there's more room
		// there, and caps its height so the list scrolls instead of overflowing.
		function position() {
			if (!target || !host) return;
			const box = root.querySelector(".box");
			const r = target.getBoundingClientRect();
			// clientWidth/Height exclude scrollbars, unlike innerWidth/Height.
			const vw = document.documentElement.clientWidth || window.innerWidth;
			const vh = document.documentElement.clientHeight || window.innerHeight;

			// Field scrolled out of view: hide the box without closing it.
			const offscreen = r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw;
			host.style.visibility = offscreen ? "hidden" : "visible";
			if (offscreen) return;

			const width = Math.min(Math.max(r.width, MIN_WIDTH), vw - MARGIN * 2);
			const left = Math.min(Math.max(r.left, MARGIN), vw - width - MARGIN);

			const spaceBelow = vh - r.bottom - GAP - MARGIN;
			const spaceAbove = r.top - GAP - MARGIN;
			box.style.maxHeight = "none";
			const natural = box.scrollHeight;
			const above = natural > spaceBelow && spaceBelow < MIN_LIST_HEIGHT && spaceAbove > spaceBelow;
			const maxHeight = Math.max(above ? spaceAbove : spaceBelow, 0);
			const height = Math.min(natural, maxHeight);

			box.style.maxHeight = `${maxHeight}px`;
			host.style.width = `${width}px`;
			host.style.left = `${left}px`;
			host.style.top = `${above ? r.top - GAP - height : r.bottom + GAP}px`;
		}

		function render(html) {
			root.querySelector(".title").textContent =
				`AutoFill AI · ${source.title}`;
			root.querySelector(".body").innerHTML = html;
		}

		function escape(s) {
			return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
		}

		async function load(fresh = false) {
			const my = ++token;
			render('<div class="msg">Loading suggestions…</div>');
			try {
				const result = await source.load(fresh);
				if (my !== token) return;
				if (result === null) return hide(); // not a field we should fill
				items = result;
				active = 0;
				if (!items.length)
					return render(
						'<div class="msg">No suggestions for this field.</div>',
					);
				render(
					`<ul>${items
						.map(
							(
								it,
								i,
							) => `<li data-i="${i}" class="${i === active ? "active" : ""}">
                        <div class="v">${escape(it.value)}</div>
                        ${it.sub ? `<div class="s">${escape(it.sub)}</div>` : ""}
                      </li>`,
						)
						.join("")}</ul>`,
				);
			} catch (err) {
				if (my === token)
					render(
						`<div class="msg">Couldn't load data: ${escape(err.message)}</div>`,
					);
			}
		}

		function highlight(i) {
			if (!items.length) return;
			active = (i + items.length) % items.length;
			root.querySelectorAll("li").forEach((li, idx) => {
				li.classList.toggle("active", idx === active);
				// The list may be scrollable on small windows.
				if (idx === active) li.scrollIntoView({ block: "nearest" });
			});
		}

		function choose(i) {
			const it = items[i];
			if (!it || !target) return;
			if (it.profile) anchorProfile = it.profile;
			if (it.price) anchorPrice = it.price;
			setValue(target, it.value);
			hide();
		}

		function show(el, src) {
			ensure();
			target = el;
			source = src;
			items = [];
			host.style.display = "block";
			resizeObserver.observe(el);
			position();
			load();
		}

		function hide() {
			token++;
			if (target) resizeObserver.unobserve(target);
			target = null;
			items = [];
			if (host) host.style.display = "none";
		}

		function onKeydown(e) {
			if (!target || e.target !== target || !items.length) return;
			if (e.key === "ArrowDown") {
				e.preventDefault();
				highlight(active + 1);
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				highlight(active - 1);
			} else if (e.key === "Enter") {
				e.preventDefault();
				e.stopPropagation();
				choose(active);
			} else if (e.key === "Escape") hide();
		}

		return {
			show,
			hide,
			position,
			onKeydown,
			get target() {
				return target;
			},
		};
	})();

	// ---------- event wiring ----------

	function handleFocus(e) {
		const el = e.composedPath()[0];
		if (!settings.enabled || !isFillable(el) || !isEmpty(el)) return; // keep existing values
		const key = detect(el);
		// Unknown field: fall back to AI, unless it's one we should never touch.
		if (!key && (!settings.ai || isIgnored(el))) return;
		if (settings.mode === "auto") autoFill(el, key);
		else dropdown.show(el, sourceFor(el, key));
	}

	function sourceFor(el, key) {
		if (key === "date") return dateSource(el);
		if (key === "price" || key === "deposit") return priceSource(el, key);
		if (key) return profileSource(el, key);
		return aiSource(el);
	}

	// ---------- AI preloading ----------

	// The on-device model takes a few seconds per field. Ask it about every
	// unknown field in the background as soon as the page loads, so that by
	// the time the user clicks, the answer is already cached.
	const PRELOAD_MAX = 30;

	const isVisible = (el) => el.getClientRects().length > 0;

	function schedulePreload(delay = 800) {
		clearTimeout(preloadTimer);
		preloadTimer = setTimeout(preload, delay);
	}

	async function preload() {
		if (!settings.enabled || !settings.ai || aiUnavailable) return;
		if (preloading) {
			preloadAgain = true;
			return;
		}
		preloading = true;
		try {
			const fields = [...document.querySelectorAll("input, textarea")]
				.filter(
					(el) =>
						isFillable(el) &&
						isEmpty(el) &&
						isVisible(el) &&
						!aiResults.has(el) &&
						!isIgnored(el) &&
						!detect(el),
				)
				.slice(0, PRELOAD_MAX);
			// One at a time, so the model isn't swamped and a click can get in between.
			for (const el of fields) {
				if (!settings.enabled || !settings.ai || aiUnavailable) break;
				try {
					await askAi(el);
				} catch {}
			}
		} finally {
			preloading = false;
			if (preloadAgain) {
				preloadAgain = false;
				schedulePreload();
			}
		}
	}

	// Forms in single-page apps often appear after load.
	new MutationObserver((mutations) => {
		if (mutations.some((m) => m.addedNodes.length)) schedulePreload(1500);
	}).observe(document.documentElement, { childList: true, subtree: true });

	document.addEventListener("focusin", handleFocus, true);
	// Clicking an already-focused input (e.g. after Escape) reopens the list.
	document.addEventListener(
		"click",
		(e) => {
			const el = e.composedPath()[0];
			if (el === document.activeElement && el !== dropdown.target)
				handleFocus(e);
		},
		true,
	);

	document.addEventListener(
		"focusout",
		(e) => {
			if (e.composedPath()[0] === dropdown.target) dropdown.hide();
		},
		true,
	);

	// In manual mode, the user clearing a field brings suggestions back;
	// typing their own value hides them.
	document.addEventListener(
		"input",
		(e) => {
			if (!e.isTrusted) return; // ignore our own synthetic events
			const el = e.composedPath()[0];
			if (!settings.enabled || settings.mode !== "manual") return;
			if (el === dropdown.target && !isEmpty(el)) dropdown.hide();
			else if (
				el === document.activeElement &&
				el !== dropdown.target &&
				isEmpty(el)
			)
				handleFocus(e);
		},
		true,
	);

	document.addEventListener("keydown", (e) => dropdown.onKeydown(e), true);
	window.addEventListener("scroll", () => dropdown.position(), true);
	window.addEventListener("resize", () => dropdown.position());
	// Pinch-zoom and the on-screen keyboard change the visual viewport only.
	window.visualViewport?.addEventListener("resize", () => dropdown.position());
})();
