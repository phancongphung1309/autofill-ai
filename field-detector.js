// Works out what kind of data an input expects, e.g. <input name="city"> -> "city".
(() => {
  // Order matters: more specific rules come first ("company name" before "name",
  // "email address" before "address").
  const RULES = [
    ['email', /\be ?mail\b/],
    // "date" is a strong signal, so it beats words like "address" or "state"
    // ("Address change date", "Close date"). Birth dates are handled first.
    ['dob', /\bdate of birth\b|\bbirth ?date\b|\bdob\b|\bbirthday\b|\bbday\b/],
    ['date', /\bdate\b|\bdated\b/],
    // Money fields are filled from the price range in the popup, no AI needed.
    ['deposit', /\bdeposits?\b/],
    ['price', /\bprices?\b|\bamount\b|\bcost\b/],
    ['username', /\buser ?(name|id)\b|\blogin\b|\bnick ?name\b/],
    ['company', /\bcompany\b|\borgani[sz]ation\b|\bemployer\b|\bbusiness\b/],
    ['website', /\bweb ?site\b|\bhomepage\b|\burl\b/],
    ['firstName', /\bfirst ?name\b|\bgiven ?name\b|\bfname\b|\bforename\b/],
    ['lastName', /\blast ?name\b|\bsurname\b|\bfamily ?name\b|\blname\b/],
    ['zip', /\bzip( ?code)?\b|\bpostal ?code\b|\bpost ?code\b|\bpin ?code\b/],
    ['city', /\bcity\b|\btown\b|\blocality\b|\bsuburb\b|\bmunicipality\b|\bville\b|\bstadt\b|\bciudad\b|\bthanh pho\b/],
    ['state', /\bstate\b|\bprovince\b|\bregion\b|\bcounty\b|\bprefecture\b/],
    ['country', /\bcountry\b|\bnation\b/],
    ['address2', /\baddress ?(line)? ?2\b|\bline ?2\b|\bapt\b|\bapartment\b|\bsuite\b/],
    ['address', /\baddress\b|\bstreet\b|\baddr\b/],
    ['phone', /\bphone\b|\bmobile\b|\btel\b|\btelephone\b|\bcell\b/],
    ['age', /\bage\b/],
    ['fullName', /\bfull ?name\b|\bname\b/],
  ];

  // HTML autocomplete tokens -> our field keys.
  const AUTOCOMPLETE = {
    'given-name': 'firstName',
    'family-name': 'lastName',
    name: 'fullName',
    email: 'email',
    username: 'username',
    tel: 'phone',
    'tel-national': 'phone',
    'street-address': 'address',
    'address-line1': 'address',
    'address-line2': 'address2',
    'address-level2': 'city',
    'address-level1': 'state',
    'postal-code': 'zip',
    country: 'country',
    'country-name': 'country',
    organization: 'company',
    bday: 'dob',
    url: 'website',
  };

  const TYPE_FALLBACK = {
    email: 'email', tel: 'phone', url: 'website', date: 'date', 'datetime-local': 'date',
  };

  const SKIP_TYPES = new Set([
    'hidden', 'password', 'checkbox', 'radio', 'file', 'submit',
    'button', 'reset', 'image', 'range', 'color',
  ]);

  // "billing_firstName" -> "billing first name"; "Thành phố" -> "thanh pho"
  function normalize(text) {
    return String(text || '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/([a-zA-Z])(\d)|(\d)([a-zA-Z])/g, '$1$3 $2$4')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function classifyText(text) {
    const norm = normalize(text);
    if (!norm) return null;
    for (const [key, re] of RULES) if (re.test(norm)) return key;
    return null;
  }

  function labelText(el) {
    const parts = [];
    if (el.labels) for (const l of el.labels) parts.push(l.textContent);
    const ids = el.getAttribute('aria-labelledby');
    if (ids) {
      for (const id of ids.split(/\s+/)) {
        const ref = el.ownerDocument.getElementById(id);
        if (ref) parts.push(ref.textContent);
      }
    }
    return parts.join(' ').slice(0, 200);
  }

  // Many component-library forms put the label in a sibling element without
  // for=, e.g. <div><label>Lot and plan</label><input name="lotAndPlan"></div>.
  // Walk up while the ancestor wraps only this field and use its text.
  function containerText(el) {
    let text = '';
    let node = el.parentElement;
    for (let i = 0; i < 3 && node && node !== el.ownerDocument.body; i++, node = node.parentElement) {
      if (node.querySelectorAll('input, textarea, select').length > 1) break;
      text = node.textContent;
    }
    return text.replace(/\s+/g, ' ').trim().slice(0, 120);
  }

  function shortLabel(el) {
    return (
      labelText(el) || el.getAttribute('aria-label') || el.placeholder ||
      containerText(el) || el.name || el.id || ''
    ).replace(/\s+/g, ' ').trim().slice(0, 60);
  }

  // Fields we never fill or send to the AI.
  const IGNORE = /\b(search|query|captcha|otp|coupon|promo|voucher|card ?number|cvv|cvc|password|message|comment)\b/;
  function isIgnored(el) {
    const role = el.getAttribute('role');
    if (el.type === 'search' || role === 'searchbox' || role === 'combobox') return true;
    if (el.name === 'q') return true;
    return IGNORE.test(normalize(`${el.name || ''} ${el.id || ''} ${el.placeholder || ''} ${el.getAttribute('aria-label') || ''}`));
  }

  function isFillable(el) {
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return false;
    if (el.disabled || el.readOnly) return false;
    if (el instanceof HTMLInputElement && SKIP_TYPES.has(el.type)) return false;
    return true;
  }

  // Returns a field key like "city", or null if the field isn't recognised.
  function detect(el) {
    if (!isFillable(el)) return null;

    const ac = (el.getAttribute('autocomplete') || '').trim().toLowerCase().split(/\s+/).pop();
    if (AUTOCOMPLETE[ac]) return AUTOCOMPLETE[ac];

    // Strongest signal first: the developer-chosen name/id, then human-facing text.
    return (
      classifyText(`${el.name || ''} ${el.id || ''}`) ||
      classifyText(
        [labelText(el), el.getAttribute('aria-label'), el.placeholder, el.title].join(' ')
      ) ||
      TYPE_FALLBACK[el.type] ||
      classifyText(containerText(el)) ||
      null
    );
  }

  // All human/developer-facing text for a field, normalised.
  function fieldText(el) {
    return normalize([
      el.name, el.id, labelText(el), el.getAttribute('aria-label'), el.placeholder, el.title,
    ].join(' '));
  }

  // Context sent to the AI for fields the rules above don't recognise.
  function describe(el) {
    const scope = el.form || el.closest('form, [role="form"], fieldset') || el.ownerDocument.body;
    const nearbyFields = [...scope.querySelectorAll('input, textarea, select')]
      .filter((x) => x !== el && x.type !== 'hidden' && x.type !== 'submit')
      .slice(0, 25)
      .map(shortLabel)
      .filter(Boolean);
    const attr = (n) => el.getAttribute(n) || undefined;
    return {
      page: { host: location.hostname, title: document.title.slice(0, 100) },
      field: {
        tag: el.tagName.toLowerCase(),
        type: el.type,
        name: el.name || undefined,
        id: el.id || undefined,
        label: (labelText(el) || containerText(el)) || undefined,
        placeholder: el.placeholder || undefined,
        ariaLabel: attr('aria-label'),
        autocomplete: attr('autocomplete'),
        pattern: attr('pattern'),
        inputMode: attr('inputmode'),
        min: attr('min'),
        max: attr('max'),
        maxLength: el.maxLength > 0 ? el.maxLength : undefined,
      },
      nearbyFields,
    };
  }

  globalThis.AutofillDetector = {
    detect, describe, fieldText, isFillable, isIgnored, classifyText, normalize,
  };
})();
