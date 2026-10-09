# AutoFill AI

A Chrome extension that works out what a form field expects (city, email, phone, …) and fills it with realistic test data.

> [!NOTE]
> **100% vibe coded.** Every line of this project was written by AI ([Claude Code](https://claude.com/claude-code)) from plain-language requests. No code was written by hand. See [About this project](#about-this-project) for what that means in practice.

- **Known fields** (`name="city"`, `type="email"`, …) are matched by keyword rules and filled from fake profiles fetched from [randomuser.me](https://randomuser.me).
- **Date fields** (Offer Date, Close Date, Firm Date, …) are recognised by the word "date" and filled in one shared format, without the AI.
- **Price fields** (Price, Purchase Price, Amount, Cost, Deposit) are filled from a price range set in the popup, without the AI.
- **Unknown fields** (`name="unit"`, `name="lotAndPlan"`, …) are handled by Chrome's built-in on-device AI (Gemini Nano). It's free, needs no API key, and runs offline. Answers are preloaded when the page loads, so clicks are usually instant.
- **Fields that already have a value are never changed.**

## Modes

| Mode       | What happens when you click into an empty field                                                                                                     |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Auto**   | The field is filled immediately. All fields on a page use the same fake person, so first name, last name and email match.                           |
| **Manual** | A list of 4 suggestions appears below the field. Pick one with the mouse or ↑ / ↓ / Enter. Esc closes the list and **↻ Shuffle** gives new options. |

## Settings

All settings are in the toolbar popup and apply immediately. No page reload is needed.

| Setting               | Default    | What it does                                                                |
| --------------------- | ---------- | --------------------------------------------------------------------------- |
| On / off switch       | On         | Turns the whole extension on or off                                         |
| Mode                  | Manual     | Auto or Manual (see above)                                                  |
| Data region           | US         | Country of the fake people (names, addresses, phone formats)                |
| ↻ Fetch new data      | –          | Replaces the cached profiles with a fresh set                               |
| Date format           | YYYY-MM-DD | Format for every date field, unless the field's placeholder shows another  |
| Price range           | 300,000 – 900,000 | Range for Price, Amount and Cost fields; deposits are a share of the price |
| AI for unknown fields | On         | Use the on-device AI for fields the keyword rules don't recognise          |
| Clear AI cache        | –          | Forgets saved AI answers so they're worked out again                        |

## Fields that are never filled

- Fields that already have a value, and disabled or read-only fields
- Password, hidden, checkbox, radio, file, range, colour and button inputs
- Search boxes (`type="search"`, `role="searchbox"`/`"combobox"`, `name="q"`)
- Fields whose name, id, placeholder or `aria-label` mentions search, query, captcha, OTP, coupon, promo, voucher, card number, CVV/CVC, password, message or comment. These are never sent to the AI.
- Fields the AI marks as "not fillable"

## Date fields

Any field whose name or label contains "date" (`offerDate`, `close_date`, "Firm Date", …) or has `type="date"` is filled without the AI. Birth dates are handled separately and get a date from the fake person.

- **Format:** set once in the popup (`YYYY-MM-DD`, `DD/MM/YYYY`, `MM/DD/YYYY`, …). If a field has a placeholder such as `dd/mm/yyyy`, that format is used for that field instead. Native `type="date"` pickers always get ISO, which is all they accept.
- **Value:** dates are relative to today, so related fields stay in order:

  | Words in the field                                                  | Auto fills       | Manual options       |
  | ------------------------------------------------------------------- | ---------------- | -------------------- |
  | close, closing, completion, settlement, possession, expiry, end, due, deadline, move in | today + 30 days | +30, +37, +44, +60 |
  | firm, condition, financing, inspection                              | today + 10 days  | +10, +17, +24, +40   |
  | anything else (offer, start, signed, …)                             | today            | today, +7, +14, +30  |

## Price fields

Any field whose name or label contains "price", "amount" or "cost" (`purchasePrice`, "Offer price", …) gets a round number from the **Price range** in the popup. Fields containing "deposit" get a percentage of that price. None of these use the AI.

- **One price per page:** the price, amount and deposit on a page all relate to the same price, so the deposit always makes sense. In manual mode, picking a price makes it the page's price.
- **Deposit options:** 5%, 10%, 15% and 20% of the page's price. Auto mode uses 5%.
- **Format:** plain digits (`450000`), which work with number inputs and most currency fields that add their own formatting. If the placeholder shows cents (`0.00`), `.00` is added. The dropdown shows each value with thousands separators underneath.
- **Rounding:** prices over 100,000 are rounded to the nearest 5,000, and smaller amounts to the nearest 1,000, 100 or 10.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select this folder.
3. Pin **AutoFill AI** from the puzzle-piece menu.

Requires desktop Chrome **138+**.

### Enable the AI (optional)

Open the popup and check the **AI for unknown fields** section:

- **Ready ✓**: nothing to do.
- **One-time model download needed**: click **Download AI model** (about 4 GB).
- **Your device can't run…**: the AI is skipped, and everything else still works.

Chrome's built-in AI needs about 22 GB of free disk space, plus either a GPU with more than 4 GB of video memory or 16 GB of RAM and 4+ CPU cores. Chrome stores the model at `%LOCALAPPDATA%\Google\Chrome\User Data\OptGuideOnDeviceModel\` and manages it itself. You can see its status at `chrome://on-device-internals`.

## Try it

```sh
python3 -m http.server 8000
```

Open <http://localhost:8000/test.html>. The test page has:

- known fields (city, name, email, phone, address, …)
- date fields (Offer, Firm and Close Date, plus one with a `dd/mm/yyyy` placeholder)
- price fields (Purchase Price, Deposit, and an Amount with a `0.00` placeholder)
- a prefilled field that must stay unchanged
- unknown fields for the AI (Unit, Lot and plan, ABN)
- a search box that should be ignored

After changing the code, reload the extension in `chrome://extensions` **and** reload the page.

## How it works

```
click on input
   │
   ├─ has a value / disabled / password / search box ──► do nothing
   │
   ├─ a date field ──► today + offset, in the shared date format
   │
   ├─ a price / deposit field ──► from the popup's price range
   │
   ├─ keyword rules recognise it ──► value from fetched profile
   │
   └─ unknown ──► on-device AI (usually already preloaded) ──► "not fillable" ──► do nothing
                                ├► standard field ──► value from profile
                                └► 4 custom values
```

Fields are recognised from these clues, in order:

1. The `autocomplete` attribute
2. `name` and `id`
3. Label text, `aria-label`, `placeholder` and `title`
4. The input type
5. Text in the field's wrapper element. This covers `<div><label>City</label><input></div>` without `for=`.

### AI preloading

The on-device model takes a few seconds per field. So when a page loads, and again when new fields appear in single-page apps, the extension asks it about every visible, empty, unknown field in the background. It handles one field at a time, up to 30 per page. The answers are cached for 7 days per site and field, so later visits don't run the model at all. Clicking a field while its answer is still being worked out waits for that same answer instead of starting a new one.

Values are set through the native value setter followed by `input`/`change` events, so React, Vue and Angular forms register the change.

## Files

| File                                    | Purpose                                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `manifest.json`                         | Extension manifest (MV3)                                                                         |
| `field-detector.js`                     | Keyword rules; decides what a field is and describes it for the AI                               |
| `content.js`                            | Focus handling, auto-fill, date values, AI preloading, and the manual-mode dropdown (Shadow DOM, so page CSS can't break it) |
| `background.js`                         | Fetches and caches profiles from randomuser.me (refreshed every 24 h)                            |
| `ai.js`                                 | AI answer cache (7 days per site and field) and routing to the model                             |
| `nano.js`                               | Wrapper around Chrome's Prompt API (`LanguageModel`)                                             |
| `offscreen.html` / `offscreen.js`       | Fallback that runs the model in a hidden page if the service worker can't access it              |
| `popup.html` / `popup.js` / `popup.css` | Settings popup                                                                                   |
| `test.html`                             | Demo form                                                                                        |

### Adding a keyword rule

Edit `RULES` in `field-detector.js`. Rules are checked top to bottom and the first match wins, so put specific patterns above general ones (for example "company name" above "name"). Text is normalised first, so `billing_firstName` becomes `billing first name`.

## Limitations

- City, state and zip come from randomuser.me, which picks them at random. They often don't belong together.
- `<select>` dropdowns are not filled.
- Company names and websites are generated from the person's last name.
- Gemini Nano is a small model, so niche formats can be inaccurate. Use **↻ Shuffle**, or add a keyword rule for fields you see often.
- The AI is set up for English; labels in other languages may work less reliably.

## Troubleshooting

- **Nothing happens:** check the popup switch. Then open DevTools on the page and look for `[AutoFill AI]` in the Console.
- **"Couldn't load data":** open `chrome://extensions` → AutoFill AI → **service worker** to see network errors.
- **A field isn't recognised and the AI is off:** add a keyword rule (see above).
- **The AI keeps giving the same wrong answer:** click **Clear AI cache** in the popup.
- **A date is in the wrong format:** change **Date format** in the popup, or check the field's placeholder, which takes priority.
- **Prices are the wrong size:** change **Price range** in the popup. It applies straight away, also on pages that are already open.

## About this project

### How it was built

This extension is **100% vibe coded**. The author described what they wanted in plain language, and [Claude Code](https://claude.com/claude-code) wrote and changed all of the code, step by step:

1. A basic autofill extension with Auto and Manual modes and data from randomuser.me
2. AI for unrecognised fields: first the Claude API, then switched to Chrome's free on-device model so no API key is needed
3. Preloading of AI answers, because the local model is slow
4. Rules for date and price fields, so they don't need the AI
5. A dropdown that repositions itself to stay inside the window

The author's role was deciding what to build, trying it in the browser, and reporting what to change.

### What has been tested

- **Automated checks:** syntax checks on every script, and small tests of the field-name rules (for example `Offer Date` → date, `lotAndPlan` → unknown, `statement` → not "state").
- **Headless Chrome:** the content script running with a fake `chrome` API, with screenshots of dropdown positioning on small windows and of price and deposit values in both modes.
- **Manual use in Chrome** by the author.

There are **no automated end-to-end tests** of the installed extension. Real websites vary a lot, so expect fields that are recognised wrongly or not at all. The on-device AI part (`nano.js`, `offscreen.js`) depends on Chrome's Prompt API, which is new and still changing.

### Use it for

- Filling forms with **fake test data** while developing or testing your own web apps
- Demos, QA and trying out forms quickly

### Don't use it for

- Real personal, legal or financial information. Every value is made up, including names, addresses, dates, prices and lot/plan numbers.
- Submitting forms on sites you don't own or have permission to test

### Privacy

- Fake profiles come from randomuser.me. Your own data is never sent there.
- The AI runs **on your device**. Field labels and page titles are not sent to any server.
- Settings and caches are stored in Chrome's extension storage on your computer. Settings sync to your Google account if Chrome sync is on.

### Disclaimer

This project is provided as is, with no warranty. Read the code before using it on anything important. Since it was all generated by AI, a human review is a good idea before you rely on it or build on it.

