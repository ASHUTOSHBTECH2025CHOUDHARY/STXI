// easyapply.js — SentinelX LinkedIn Easy Apply engine
// Injected into the LinkedIn tab via chrome.scripting.executeScript({ files: [...] })
// Exposes window.__sentinelEasyApply.run(profile, resume, jobContext, coverLetter)

(function () {
  'use strict';

  if (window.__sentinelEasyApply) return; // already injected — idempotent

  // ── React synthetic event bypass ──────────────────────────────────────────
  // LinkedIn uses React which ignores direct .value= assignments.
  // We must use the native setter + dispatch real events so React's
  // onChange / onBlur fire and update internal state.

  function reactSet(el, value) {
    try {
      const proto  = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, value);
    } catch (_) {
      el.value = value;
    }
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur',   { bubbles: true }));
  }

  function reactSetSelect(el, value) {
    const opts = Array.from(el.options);
    // Exact value match → label match (case-insensitive) → partial label match
    const opt =
      opts.find(o => o.value === value) ||
      opts.find(o => o.text.trim().toLowerCase() === value.toLowerCase()) ||
      opts.find(o => o.text.trim().toLowerCase().includes(value.toLowerCase()));
    if (!opt) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    if (setter) setter.call(el, opt.value); else el.value = opt.value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur',   { bubbles: true }));
    return true;
  }

  // ── Text normaliser ───────────────────────────────────────────────────────
  // Strips invisible Unicode characters, collapses whitespace, lowercases.
  // Used everywhere we compare DOM text to a search string to avoid
  // invisible-char mismatches (LinkedIn typeahead items contain these).

  function normText(str) {
    return (str || '')
      // Remove zero-width / invisible Unicode chars
      .replace(/[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  // ── Typeahead / GEO autocomplete filler ──────────────────────────────────
  // LinkedIn's location fields use a combobox that fires a Geo API on each
  // keystroke. We must: type the value → wait for dropdown → click suggestion.
  //
  // FIX (v2): Improved suggestion scoring so "Mathura, Uttar Pradesh" is always
  // preferred over a fuzzy match like "Maharashtra" even when LinkedIn's GEO API
  // returns results in an unexpected order. We score candidates:
  //   Score 4 — exact match (normalised full text === needle)
  //   Score 3 — starts with needle as a word boundary
  //   Score 2 — starts with needle (any position)
  //   Score 1 — contains needle
  //   Score 0 — no match → excluded
  // Highest score wins; ties broken by DOM order (first result).

  async function fillTypeahead(el, value) {
    if (!value) return false;

    const wait = ms => new Promise(r => setTimeout(r, ms));

    function typeChar(el, char, currentVal) {
      const nativeInputSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype, 'value'
      )?.set;

      el.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true, cancelable: true, key: char, code: 'Key' + char.toUpperCase(),
      }));

      if (nativeInputSetter) nativeInputSetter.call(el, currentVal + char);
      else el.value = currentVal + char;

      el.dispatchEvent(new InputEvent('input', {
        bubbles: true, cancelable: true,
        inputType: 'insertText',
        data: char,
      }));

      el.dispatchEvent(new KeyboardEvent('keyup', {
        bubbles: true, cancelable: true, key: char,
      }));
    }

    const dropdownSel = [
      '[role="listbox"] [role="option"]',
      '[role="option"]',
      '.basic-typeahead__selectable',
      '[data-test-typeahead-item]',
      '[class*="typeahead-item"]',
      '[class*="autocomplete"] li',
      '[id*="-ta"] li',
    ].join(',');

    const waitForSuggestions = async (maxWaitMs = 5000) => {
      const start = Date.now();
      while (Date.now() - start < maxWaitMs) {
        await wait(200);
        const items = document.querySelectorAll(dropdownSel);
        if (items.length > 0) return Array.from(items);
      }
      return [];
    };

    // ── Step 1: focus and clear ───────────────────────────────────────────────
    el.focus();
    await wait(150);

    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (nativeSetter) nativeSetter.call(el, '');
    else el.value = '';
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    await wait(150);

    // ── Step 2: type characters one by one ───────────────────────────────────
    const typeTarget = value.split(',')[0].trim();
    let typed = '';
    for (const char of typeTarget) {
      typeChar(el, char, typed);
      typed += char;
      await wait(40);
    }

    console.log('[SentinelX] Typeahead: typed →', typed, '| waiting for suggestions...');

    // ── Step 3: wait for GEO API dropdown ────────────────────────────────────
    let items = await waitForSuggestions(5000);

    if (items.length === 0) {
      el.dispatchEvent(new Event('change', { bubbles: true }));
      items = await waitForSuggestions(3000);
    }

    if (items.length === 0) {
      console.warn('[SentinelX] Typeahead: no suggestions for:', value);
      return false;
    }

    // ── Step 4: scored suggestion matching ───────────────────────────────────
    // FIX: Use a multi-tier scoring system to avoid selecting a fuzzy match
    // (e.g. "Maharashtra") when the correct city (e.g. "Mathura") is also
    // present. LinkedIn's GEO API sometimes reorders results by popularity.

    const needle = normText(typeTarget); // e.g. "mathura"

    function scoreItem(item) {
      const raw  = normText(item.textContent); // e.g. "mathura, uttar pradesh, india"
      if (!raw) return 0;

      // Exact full-text match
      if (raw === needle) return 4;

      // Starts with needle AND next char is a word boundary (, space, end)
      if (raw.startsWith(needle)) {
        const nextChar = raw[needle.length];
        if (!nextChar || nextChar === ',' || nextChar === ' ') return 3;
        // Starts with needle but next char is a letter (e.g. "maharashtra".startsWith("ma"))
        // → score 2 only, not 3, so a proper prefix match beats it
        return 2;
      }

      // Contains needle as a whole word
      const wordBoundary = new RegExp(`(^|[\\s,])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[\\s,])`);
      if (wordBoundary.test(raw)) return 2;

      // Contains needle anywhere
      if (raw.includes(needle)) return 1;

      return 0;
    }

    // Score all candidates; keep only those with score > 0
    const scored = items
      .map((item, idx) => ({ item, score: scoreItem(item), idx }))
      .filter(s => s.score > 0);

    if (scored.length === 0) {
      console.warn('[SentinelX] Typeahead: no scored match for:', value, '— falling back to first item');
      items[0].click();
      await wait(400);
      return el.value.trim() !== '';
    }

    // Sort by score DESC, then by original DOM order ASC (idx)
    scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
    const best = scored[0].item;

    console.log('[SentinelX] Typeahead: best match →', normText(best.textContent),
      '(score:', scored[0].score, ')');
    best.click();
    await wait(400);

    // ── Step 5: verify the input was actually filled ──────────────────────────
    if (!el.value || el.value.trim() === '') {
      best.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      best.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true }));
      best.click();
      await wait(300);
    }

    console.log('[SentinelX] Typeahead: final value →', el.value);
    return el.value.trim() !== '';
  }

  // ── Visibility ────────────────────────────────────────────────────────────
  // FIX: The old check used offsetParent which returns null for elements inside
  // fixed/sticky containers (like LinkedIn's Easy Apply modal), causing visible
  // fields to be skipped entirely. We now walk up the DOM checking computed
  // styles, then confirm non-zero bounding rect dimensions.

  function visible(el) {
    if (!el) return false;
    let node = el;
    while (node && node !== document.body) {
      const s = getComputedStyle(node);
      if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) return false;
      node = node.parentElement;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // ── Label extraction ──────────────────────────────────────────────────────
  // Build a single "hint string" from every label source available.
  //
  // FIX (v2): For radio/checkbox inputs that live inside a <fieldset>, we now
  // read the <legend> text directly from the closest fieldset rather than
  // relying on the upward DOM walk which could pick up a sibling fieldset's
  // legend via querySelector (querySelector searches DOWNWARD from the node,
  // so walking up and calling querySelector on each ancestor finds the first
  // descendant legend — which can belong to a different question group).

  function fieldHint(el) {
    const parts = [];

    // 1. aria-label
    if (el.getAttribute('aria-label')) parts.push(el.getAttribute('aria-label'));

    // 2. aria-labelledby → referenced element text
    const lby = el.getAttribute('aria-labelledby');
    if (lby) {
      lby.split(/\s+/).forEach(id => {
        const ref = document.getElementById(id);
        if (ref) parts.push(ref.textContent.trim());
      });
    }

    // 3. Explicit <label for="id">
    if (el.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl) parts.push(lbl.textContent.trim());
    }

    // 4. Implicit label ancestor
    const implLbl = el.closest('label');
    if (implLbl) parts.push(implLbl.textContent.trim());

    // 5. placeholder / name
    if (el.placeholder) parts.push(el.placeholder);
    if (el.name) parts.push(el.name.replace(/[-_]/g, ' '));

    // 6a. FIX: For inputs inside a <fieldset>, read the <legend> DIRECTLY
    //     from that fieldset — don't rely on the generic upward walk which
    //     calls querySelector() and can find the wrong legend.
    const fieldset = el.closest('fieldset');
    if (fieldset) {
      const legend = fieldset.querySelector(':scope > legend, :scope > legend span[aria-hidden="true"]');
      if (legend) {
        const t = legend.textContent.trim();
        if (t && t.length < 300) parts.push(t);
      }
    }

    // 6b. Generic upward walk — only used when NOT inside a fieldset
    if (!fieldset) {
      let node = el.parentElement;
      for (let i = 0; i < 5 && node; i++) {
        const lEl = node.querySelector(
          'label, [class*="label"], [class*="title"]'
        );
        if (lEl && lEl !== el && !lEl.contains(el)) {
          const t = lEl.textContent.trim();
          if (t && t.length < 150) { parts.push(t); break; }
        }
        node = node.parentElement;
      }
    }

    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  // ── Legend text for a fieldset ────────────────────────────────────────────
  // Used when building radio/checkbox groups to get the question text cleanly.

  function fieldsetLegendText(fieldset) {
    if (!fieldset) return '';
    // Prefer the aria-hidden span (contains the visible text without screen-reader duplication)
    const spanHidden = fieldset.querySelector(
      ':scope > legend span[aria-hidden="true"], ' +
      '[data-test-form-builder-radio-button-form-component__title] span[aria-hidden="true"], ' +
      '[data-test-checkbox-form-title] span[aria-hidden="true"]'
    );
    if (spanHidden) return spanHidden.textContent.trim();
    const legend = fieldset.querySelector(':scope > legend');
    if (legend) return legend.textContent.trim();
    return '';
  }

  // ── Extract ALL form fields on the visible modal step ────────────────────
  // Returns a structured list — passed to the model and to the heuristic filler.

  function extractFields(modal) {
    const fields = [];

    function domSnapshot(el) {
      const container =
        el.closest('fieldset') ||
        el.closest('[data-test-form-builder-radio-button-form-component]') ||
        el.closest('[class*="artdeco-text-input--container"]') ||
        el.closest('[class*="form-element"]') ||
        el.parentElement;
      if (!container) return el.outerHTML;
      return container.outerHTML.slice(0, 2000);
    }

    // Typeahead / GEO autocomplete inputs (combobox role)
    const typeaheadIds = new Set();
    modal.querySelectorAll('input[role="combobox"][aria-autocomplete="list"]').forEach(el => {
      if (!visible(el) || el.disabled || el.readOnly) return;
      typeaheadIds.add(el.id);
      fields.push({
        el,
        kind:        'typeahead',
        hint:        fieldHint(el),
        inputType:   'text',
        currentVal:  el.value.trim(),
        domHTML:     domSnapshot(el),
      });
    });

    // Text / email / tel / number / url inputs
    modal.querySelectorAll('input[type="text"],input[type="email"],input[type="tel"],input[type="number"],input[type="url"],input:not([type])').forEach(el => {
      if (typeaheadIds.has(el.id)) return;
      if (!visible(el) || el.disabled || el.readOnly || el.type === 'hidden') return;
      fields.push({
        el,
        kind:        'text',
        hint:        fieldHint(el),
        inputType:   el.type || 'text',
        maxLength:   el.maxLength > 0 ? el.maxLength : null,
        min:         el.min !== '' ? Number(el.min) : null,
        max:         el.max !== '' ? Number(el.max) : null,
        pattern:     el.pattern || null,
        currentVal:  el.value.trim(),
        domHTML:     domSnapshot(el),
      });
    });

    // Textareas
    modal.querySelectorAll('textarea').forEach(el => {
      if (!visible(el) || el.disabled || el.readOnly) return;
      fields.push({
        el,
        kind:       'textarea',
        hint:       fieldHint(el),
        maxLength:  el.maxLength > 0 ? el.maxLength : null,
        currentVal: el.value.trim(),
        domHTML:    domSnapshot(el),
      });
    });

    // Selects
    modal.querySelectorAll('select').forEach(el => {
      if (!visible(el) || el.disabled) return;
      fields.push({
        el,
        kind:       'select',
        hint:       fieldHint(el),
        options:    Array.from(el.options).map(o => o.text.trim()).filter(Boolean),
        currentVal: el.options[el.selectedIndex]?.text?.trim() || '',
        domHTML:    domSnapshot(el),
      });
    });

    // Radio groups
    // FIX (v2): Group hint now comes from fieldsetLegendText() which reads the
    // fieldset's own <legend> directly, preventing cross-group legend pollution.
    const radioGroups = {};
    modal.querySelectorAll('input[type="radio"]').forEach(el => {
      if (!visible(el) || el.disabled) return;
      const fs  = el.closest('fieldset');
      const key = el.name || fs?.id || fieldHint(el);
      if (!radioGroups[key]) {
        // Use legend text for the GROUP hint, individual fieldHint() for option labels
        const groupHint = fs
          ? fieldsetLegendText(fs) || fieldHint(el)
          : fieldHint(el);
        radioGroups[key] = { els: [], hint: groupHint, fieldset: fs };
      }
      radioGroups[key].els.push(el);
    });
    Object.values(radioGroups).forEach(g => {
      if (g.els.some(r => r.checked)) return; // already answered
      // Option labels: prefer data-test-text-selectable-option__input attr, then label text
      const options = g.els.map(r => {
        const attrVal = r.getAttribute('data-test-text-selectable-option__input');
        if (attrVal) return attrVal;
        // Find the <label> for this radio
        const lbl = r.id ? document.querySelector(`label[for="${CSS.escape(r.id)}"]`) : null;
        if (lbl) return lbl.textContent.trim();
        return r.value;
      });
      fields.push({
        el:         g.els[0],
        els:        g.els,
        kind:       'radio',
        hint:       g.hint,
        options,
        currentVal: '',
        domHTML:    domSnapshot(g.els[0]),
      });
    });

    // ── Checkbox groups ─────────────────────────────────────────────────────
    const checkboxGroupMap = {};
    modal.querySelectorAll('input[type="checkbox"]').forEach(el => {
      if (!visible(el) || el.disabled) return;

      const fieldset  = el.closest('fieldset[data-test-checkbox-form-component]');
      const isConsent = fieldset && fieldset.querySelector('[data-test-checkbox-form-required]');

      if (isConsent && el.getAttribute('aria-required') !== 'true') {
        if (!el.checked) el.click();
        return;
      }
      if (el.required && !el.checked) {
        el.click();
        return;
      }

      const groupKey = fieldset?.id || el.name || fieldHint(el);
      if (!groupKey) return;

      if (!checkboxGroupMap[groupKey]) {
        const groupHint = fieldset
          ? fieldsetLegendText(fieldset) || fieldHint(el)
          : fieldHint(el);
        checkboxGroupMap[groupKey] = { els: [], hint: groupHint, fieldset };
      }
      checkboxGroupMap[groupKey].els.push(el);
    });

    Object.values(checkboxGroupMap).forEach(g => {
      if (g.els.every(e => e.checked)) return;
      const options = g.els.map(e =>
        e.getAttribute('data-test-text-selectable-option__input') ||
        fieldHint(e) || e.value
      );
      fields.push({
        el:         g.els[0],
        els:        g.els,
        kind:       'checkbox-group',
        hint:       g.hint,
        options,
        required:   !!g.fieldset?.querySelector('[data-test-checkbox-form-required]'),
        currentVal: g.els.filter(e => e.checked).map(e =>
          e.getAttribute('data-test-text-selectable-option__input') || e.value
        ).join(', '),
        domHTML:    domSnapshot(g.els[0]),
      });
    });

    return fields;
  }

  // ── Unit coercion helper ──────────────────────────────────────────────────

  function coerceToFieldUnit(hint, value, inputType) {
    const h = (hint  || '').toLowerCase();
    const v = String(value).trim();

    const wantsDays   = /\bin days\b|\(days\)/i.test(h);
    const wantsMonths = /\bin months\b|\(months\)/i.test(h);
    const wantsWeeks  = /\bin weeks\b|\(weeks\)/i.test(h);
    const wantsNumber = inputType === 'number' || wantsDays || wantsMonths || wantsWeeks;

    if (!wantsNumber) return v;

    const numMatch = v.match(/(\d+(?:\.\d+)?)/);
    if (!numMatch) return v;
    const num = parseFloat(numMatch[1]);

    const hasMonths = /month/i.test(v);
    const hasWeeks  = /week/i.test(v);
    const hasDays   = /day/i.test(v);
    const hasYears  = /year/i.test(v);

    let asDays = num;
    if      (hasYears)  asDays = num * 365;
    else if (hasMonths) asDays = num * 30;
    else if (hasWeeks)  asDays = num * 7;
    else if (hasDays)   asDays = num;
    else return String(Math.round(num));

    if (wantsDays)   return String(Math.round(asDays));
    if (wantsMonths) return String(Math.round(asDays / 30));
    if (wantsWeeks)  return String(Math.round(asDays / 7));
    return String(Math.round(asDays));
  }

  // ── Heuristic answer ──────────────────────────────────────────────────────
  // Returns the value if we're CERTAIN, or null / '__MODEL__' / '__ASK__'.

  function heuristicAnswer(field, profile, resume, coverLetter, jobLocation) {
    const h = field.hint.toLowerCase();
    const p = profile || {};
    const b = resume?.basic_info || {};

    // ── Personal info ─────────────────────────────────────────────────────
    if (/first[\s-_]?name|given[\s-_]?name|forename/i.test(h)) {
      const name = p.full_name || b.name || '';
      return name.split(/\s+/)[0] || null;
    }
    if (/last[\s-_]?name|surname|family[\s-_]?name/i.test(h)) {
      const name = p.full_name || b.name || '';
      const parts = name.split(/\s+/);
      return parts.length > 1 ? parts.slice(1).join(' ') : null;
    }
    if (/\bfull[\s-_]?name\b|\bname\b/i.test(h) && !/company|org|school|university|employer|manager/i.test(h)) {
      return p.full_name || b.name || null;
    }
    if (/\bemail\b/i.test(h))   return p.email   || b.email   || null;
    if (/phone|mobile|tel\b/i.test(h)) return p.phone || b.phone || null;
    if (/linkedin/i.test(h))    return p.linkedin_url || b.linkedin_url || null;
    if (/github/i.test(h))      return p.github_url  || b.github_url   || null;
    if (/portfolio|website|personal.*url/i.test(h)) return p.website || b.website || null;

    // ── Location ──────────────────────────────────────────────────────────
    if (/\bcity\b/i.test(h))    return p.city    || b.city    || null;
    if (/\bstate\b|province/i.test(h)) return p.state || b.state || null;
    if (/\bcountry\b/i.test(h)) return p.country || b.country || null;
    if (/\bzip\b|postal/i.test(h)) return p.zip  || b.zip     || null;
    if (/\blocation\b|\baddress\b/i.test(h) && !/work.*location|preferred/i.test(h)) {
      return p.city ? `${p.city}${p.state ? ', ' + p.state : ''}` : null;
    }

    // ── Notice period ─────────────────────────────────────────────────────
    if (/notice[\s-_]?period/i.test(h)) {
      if (p.notice_period_days == null) return '__ASK__';
      const days = Number(p.notice_period_days);

      const asksForDays   = /\bin days\b|\(days\)/i.test(h);
      const asksForMonths = /\bin months\b|\(months\)/i.test(h);
      const asksForWeeks  = /\bin weeks\b|\(weeks\)/i.test(h);

      if (field.inputType === 'number' || field.kind === 'text') {
        if (asksForDays)   return String(days);
        if (asksForMonths) return String(Math.round(days / 30));
        if (asksForWeeks)  return String(Math.round(days / 7));
        return String(days);
      }

      if (field.kind === 'textarea') {
        if (asksForDays)   return String(days);
        if (asksForMonths) return String(Math.round(days / 30));
        if (asksForWeeks)  return String(Math.round(days / 7));
        if (days === 0)          return 'Immediate joiner';
        if (days <= 7)           return `${days} day${days > 1 ? 's' : ''}`;
        if (days % 30 === 0)     return `${days / 30} month${days > 30 ? 's' : ''}`;
        if (days <= 31)          return `${Math.round(days / 7)} week${days > 7 ? 's' : ''}`;
        return `${Math.round(days / 30)} month${days > 30 ? 's' : ''}`;
      }

      if (field.kind === 'select' || field.kind === 'radio') return '__MODEL__';
    }

    // ── Typeahead location fields ─────────────────────────────────────────
    if (field.kind === 'typeahead' && /location|city|geo/i.test(h)) {
      const prefLoc = window.__eaDump?.locationAnswer?.();
      if (prefLoc) return prefLoc;
      if (p.city) return `${p.city}${p.state ? ', ' + p.state : ''}`;
      return '__ASK__';
    }

    // ── Indian citizen ────────────────────────────────────────────────────
    // FIX: Handle both radio and select kinds correctly.
    // Returns the exact option string "Yes" or "No" so validate() can match it.
    if (/indian\s*citizen|citizen.*india/i.test(h)) {
      const country = (p.country || p.home_country || '').toLowerCase();
      const isIndian = country.includes('india') || country === '';
      const answer = isIndian ? 'Yes' : 'No';
      // For select fields, let the model pick from actual options list
      if (field.kind === 'select') return answer;
      // For radio fields, return "Yes"/"No" — these match data-test-text-selectable-option__input
      return answer;
    }

    // ── Job location OK / relocation OK ──────────────────────────────────
    // FIX: Always "Yes" regardless of open_to_relocation flag.
    // Return the correct option label that exists in the radio group.
    if (/ok with.*location|comfortable.*location|location.*ok|ok.*relocat|relocat.*ok/i.test(h)) {
      // Verify "Yes" is actually an option before returning it
      if (field.kind === 'radio' || field.kind === 'select') {
        const opts = (field.options || []).map(o => o.toLowerCase());
        if (opts.includes('yes')) return 'Yes';
        if (opts.includes('no'))  return 'No';
      }
      return 'Yes';
    }

    // ── Previously worked at company ─────────────────────────────────────
    if (/previously worked|former.*employee|worked with/i.test(h)) {
      const companies = (resume?.experience || []).map(e => (e.company || '').toLowerCase());
      const mentionedCompany = h.match(/worked (?:at|with)\s+([a-z0-9]+)/i)?.[1]?.toLowerCase();
      if (mentionedCompany && companies.some(c => c.includes(mentionedCompany))) return 'Yes';
      return 'No';
    }

    // ── Employee ID / National ID ─────────────────────────────────────────
    if (/employee\s*id|emp\s*id|staff\s*id/i.test(h)) {
      const priorWorkedHere = (sessionContext || []).find(e =>
        /previously worked|former.*employ|worked with/i.test(e.hint)
      );
      if (priorWorkedHere && /no/i.test(priorWorkedHere.value)) return '0';
      return p.employee_id ? String(p.employee_id) : '0';
    }
    if (/national\s*id|aadhaar|pan\s*(?:card|number)|passport\s*(?:no|number)/i.test(h)) {
      return p.national_id || p.aadhaar || p.pan || '__ASK__';
    }

    // ── How did you hear about this position ─────────────────────────────
    if (/how.*hear|source.*position|how.*find|referred by/i.test(h)) {
      // For select: match the exact option
      if (field.kind === 'select') {
        const opts = field.options || [];
        const portal = opts.find(o => /job\s*portal/i.test(o));
        if (portal) return portal;
        const social = opts.find(o => /social/i.test(o));
        if (social) return social;
      }
      return 'Job Portal';
    }

    // ── Source details ────────────────────────────────────────────────────
    if (/source\s*details|specify.*source|additional.*source/i.test(h)) {
      return 'LinkedIn';
    }

    // ── Preferred work location (select / radio) ──────────────────────────
    // FIX: For select/radio, send to model so it can pick from the actual
    // available city options. For typeahead/text, return the city directly.
    if (/preferred.*location.*work|location.*prefer|where.*prefer.*work/i.test(h)) {
      if (field.kind === 'select' || field.kind === 'radio') return '__MODEL__';
      const prefLoc = window.__eaDump?.locationAnswer?.();
      if (prefLoc) return prefLoc;
      return p.city || '__ASK__';
    }

    // ── Benefits / checkbox-group ─────────────────────────────────────────
    if (field.kind === 'checkbox-group' && !field.required) {
      return '__MODEL__';
    }

    // ── Commute comfort ───────────────────────────────────────────────────
    if (/commut|comfortable.*location|location.*comfortable/i.test(h)) {
      return 'Yes';
    }

    // ── CTC / salary ──────────────────────────────────────────────────────
    if (/confirm.*compensation|confirm.*ctc|confirm.*salary/i.test(h)) {
      if (p.current_ctc == null) return '__ASK__';
      return String(p.current_ctc);
    }
    if (/current.*ctc|current.*salary|present.*salary/i.test(h)) {
      if (p.current_ctc == null) return '__ASK__';
      return String(p.current_ctc);
    }
    if (/expected.*ctc|expected.*salary|desired.*salary/i.test(h)) {
      if (p.expected_ctc == null) return '__ASK__';
      return String(p.expected_ctc);
    }

    // ── Work authorisation ────────────────────────────────────────────────
    if (/authoriz|eligible.*work|work.*permit|legally.*allowed/i.test(h)) {
      if (!p.work_authorization) return '__MODEL__';
      const auth = p.work_authorization.toLowerCase();
      if (field.kind === 'select' || field.kind === 'radio') return '__MODEL__';
      return auth.includes('citizen') || auth.includes('pr') ? 'Yes' : null;
    }

    // ── Sponsorship / visa ────────────────────────────────────────────────
    if (/sponsor|h-?1b|visa.*required|require.*visa/i.test(h)) {
      const dumpVisaAnswer = window.__eaDump?.visaAnswer?.(jobLocation);
      if (dumpVisaAnswer && field.kind !== 'select' && field.kind !== 'radio') {
        return dumpVisaAnswer;
      }
      if (p.requires_sponsorship == null) return '__MODEL__';
      if (field.kind === 'select' || field.kind === 'radio') return '__MODEL__';
      return p.requires_sponsorship ? 'Yes' : 'No';
    }

    // ── Location preference (generic) ─────────────────────────────────────
    if (/preferred.*location|location.*preference|desired.*location/i.test(h)) {
      const prefLoc = window.__eaDump?.locationAnswer?.();
      if (prefLoc) return prefLoc;
      return p.city ? `${p.city}${p.state ? ', ' + p.state : ''}` : null;
    }

    // ── Years of experience ───────────────────────────────────────────────
    if (/years.*exp|exp.*years|how many years/i.test(h)) {
      if (p.total_years_experience != null) {
        return String(Math.round(p.total_years_experience));
      }
      const exp = resume?.experience || [];
      if (exp.length) {
        return String(Math.min(exp.length * 2, 20));
      }
      return '__MODEL__';
    }

    // ── Cover letter / motivation ─────────────────────────────────────────
    if (/cover[\s-_]?letter|motivation|why.*apply|why.*join|why.*want|tell us about you|introduce yourself|summary/i.test(h)) {
      return coverLetter || '__MODEL__';
    }

    return null;
  }

  // ── Validation pipeline ───────────────────────────────────────────────────

  function validate(field, rawValue) {
    const v = String(rawValue).trim();
    if (!v) return { ok: false, reason: 'empty value' };

    if (field.kind === 'checkbox-group') return { ok: true, value: v };

    if (field.kind === 'text' && field.inputType === 'number') {
      if (isNaN(Number(v))) return { ok: false, reason: `"${v}" is not a number` };
      const n = Number(v);
      if (field.min != null && n < field.min) return { ok: false, reason: `${n} < min ${field.min}` };
      if (field.max != null && n > field.max) return { ok: false, reason: `${n} > max ${field.max}` };
    }

    if (field.kind === 'text' && field.maxLength && v.length > field.maxLength) {
      return { ok: true, value: v.slice(0, field.maxLength), truncated: true };
    }

    if (field.kind === 'select' || field.kind === 'radio') {
      const opts = field.options || [];
      const match = opts.find(o => o.toLowerCase() === v.toLowerCase())
        || opts.find(o => o.toLowerCase().includes(v.toLowerCase()));
      if (!match) return { ok: false, reason: `"${v}" not in options [${opts.join(', ')}]` };
      return { ok: true, value: match };
    }

    return { ok: true, value: v };
  }

  // ── Ask Ollama ────────────────────────────────────────────────────────────

  async function askOllama(field, profile, resume, jobContext, sessionContext) {
    const systemPrompt = `You are a job application form-filling assistant. Answer each field using ONLY the user's profile and resume data.

STRICT RULES — follow every one, no exceptions:
1. Use ONLY information explicitly in the profile or resume. Never invent, estimate, or assume.
2. If the answer is missing, set "action":"ask_user" and explain what is missing in "ask_reason".
3. For select/radio fields, "value" MUST exactly match one of the provided options (same case, same spelling).
4. UNIT RULES — this is critical:
   - If the field label says "in days" or "(days)", give a plain integer in days. e.g. notice period = 90 days → value:"90"
   - If the field label says "in months" or "(months)", convert to months. e.g. 90 days → value:"3"
   - If the field label says "in weeks" or "(weeks)", convert to weeks. e.g. 90 days → value:"13"
   - If inputType is "number", return ONLY digits — no words, no units, no symbols.
   - NEVER answer "3 months" when the field asks for days. NEVER answer "90" when the field asks for months.
5. Respond ONLY with valid JSON. No explanation, no markdown, no code fences.`;

    const unitHint = (() => {
      const h = field.hint.toLowerCase();
      if (/\bin days\b|\(days\)/i.test(h))   return 'IMPORTANT: This field wants a number in DAYS (e.g. 90, not "3 months").';
      if (/\bin months\b|\(months\)/i.test(h)) return 'IMPORTANT: This field wants a number in MONTHS (e.g. 3, not "90 days").';
      if (/\bin weeks\b|\(weeks\)/i.test(h))  return 'IMPORTANT: This field wants a number in WEEKS.';
      if (field.inputType === 'number')        return 'IMPORTANT: This field is type="number" — return ONLY digits, no units or words.';
      return '';
    })();

    const userPrompt = `USER PROFILE:
${JSON.stringify(profile, null, 2)}

RESUME SUMMARY:
${JSON.stringify({
  name:       resume?.basic_info?.name,
  email:      resume?.basic_info?.email,
  experience: resume?.experience?.map(e => ({ title: e.title, company: e.company, years: e.duration })),
  skills:     resume?.skills,
  education:  resume?.education?.map(e => ({ degree: e.degree, field: e.field, year: e.year })),
}, null, 2)}

JOB CONTEXT:
${JSON.stringify(jobContext, null, 2)}

${(sessionContext && sessionContext.length > 0) ? `PREVIOUS ANSWERS IN THIS FORM SESSION (use these to understand context and answer dependent questions correctly):
${sessionContext.map((e, i) => `  ${i + 1}. [${e.kind}] "${e.hint}" → "${e.value}"`).join('\n')}

NOTE: If this question refers to or depends on a previous answer above (e.g. "enter your employee ID" after "have you worked here before?" was answered "No"), use that prior answer to determine the correct response.
` : ''}FORM FIELD:
Label/hint: "${field.hint}"
Field type: ${field.kind} (input type: ${field.inputType || field.kind})
${field.options?.length ? `Available options: ${JSON.stringify(field.options)}` : ''}
${field.maxLength ? `Max characters: ${field.maxLength}` : ''}
${field.min != null ? `Min value: ${field.min}` : ''}
${field.max != null ? `Max value: ${field.max}` : ''}
${unitHint ? `\n${unitHint}` : ''}
Current value: "${field.currentVal || ''}"

FIELD DOM HTML (use this to understand input type, aria attributes, available options, required status, and exact option values to select):
${field.domHTML || '(not available)'}

Respond with JSON only:
{
  "value": "<the answer>",
  "confidence": "high|medium|low",
  "source": "<which field in the profile/resume this came from>",
  "action": "fill|skip|ask_user",
  "ask_reason": "<if ask_user, what exactly needs to be provided>"
}`;

    try {
      const res = await fetch('http://localhost:11434/api/generate', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          model:  'llama3.2',
          prompt: `<|system|>\n${systemPrompt}\n<|user|>\n${userPrompt}\n<|assistant|>`,
          stream: false,
          options: { temperature: 0, num_predict: 300 },
        }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const raw  = data.response?.trim() || '';
      const json = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
      return JSON.parse(json);
    } catch (_) {
      return null;
    }
  }

  // ── Click a radio option by answer value ──────────────────────────────────
  // FIX (v2): Extracted into a helper so both the cache path and the main path
  // use identical matching logic.
  // Matching order:
  //   1. data-test-text-selectable-option__input attr exact match (case-insensitive)
  //   2. Associated <label> text exact match (case-insensitive)
  //   3. radio .value exact match (case-insensitive)
  //   4. Any of the above contains the answer string

  function clickRadioOption(field, answerValue) {
    const answer = answerValue.trim().toLowerCase();

    // Build a richer candidate list that includes label text
    const candidates = (field.els || []).map(r => {
      const attrVal = (r.getAttribute('data-test-text-selectable-option__input') || '').toLowerCase();
      const labelEl = r.id ? document.querySelector(`label[for="${CSS.escape(r.id)}"]`) : null;
      const labelTxt = (labelEl?.textContent?.trim() || '').toLowerCase();
      const radioVal = (r.value || '').toLowerCase();
      return { r, attrVal, labelTxt, radioVal };
    });

    // Tier 1: exact match on any attribute
    let match = candidates.find(c =>
      c.attrVal === answer || c.labelTxt === answer || c.radioVal === answer
    );

    // Tier 2: contains match
    if (!match) {
      match = candidates.find(c =>
        c.attrVal.includes(answer) || c.labelTxt.includes(answer) || answer.includes(c.attrVal) || answer.includes(c.labelTxt)
      );
    }

    if (match) {
      match.r.click();
      return true;
    }
    return false;
  }

  // ── Fill one field ────────────────────────────────────────────────────────

  async function fillField(field, profile, resume, jobContext, coverLetter, sessionContext) {
    if (field.currentVal) return { status: 'skipped', reason: 'already has value' };

    const jobLocation = jobContext?.location || '';

    // Step 2: dump cache
    const cached = window.__eaDump?.lookup?.(field.hint, field.kind, field.options);
    if (cached != null) {
      const v = validate(field, cached);
      if (v.ok) {
        try {
          if (field.kind === 'checkbox-group') {
            const chosen = v.value.split(',').map(s => s.trim().toLowerCase());
            field.els.forEach(cb => {
              const label = (cb.getAttribute('data-test-text-selectable-option__input') || fieldHint(cb) || cb.value).toLowerCase();
              const shouldCheck = chosen.some(c => label.includes(c) || c.includes(label));
              if (shouldCheck && !cb.checked) cb.click();
              if (!shouldCheck && cb.checked) cb.click();
            });
          } else if (field.kind === 'typeahead') {
            const ok = await fillTypeahead(field.el, v.value);
            if (!ok) return { status: 'typeahead_fail', reason: 'no suggestion selected (cache)', hint: field.hint };
          } else if (field.kind === 'select') {
            reactSetSelect(field.el, v.value);
          } else if (field.kind === 'checkbox') {
            const shouldCheck = /yes|true|1/i.test(v.value);
            if (field.el.checked !== shouldCheck) field.el.click();
          } else if (field.kind === 'radio') {
            const ok = clickRadioOption(field, v.value);
            if (!ok) return { status: 'validation_fail', reason: `cached radio "${v.value}" not found`, hint: field.hint };
          } else {
            reactSet(field.el, v.value);
          }
          return { status: 'filled_from_cache', value: v.value, hint: field.hint };
        } catch (e) {
          return { status: 'error', reason: e.message, hint: field.hint };
        }
      }
    }

    // Step 3: heuristic
    let rawValue   = heuristicAnswer(field, profile, resume, coverLetter, jobLocation);
    let answerSrc  = 'heuristic';
    let answerConf = 'high';

    if (rawValue === '__ASK__') {
      return { status: 'ask_user', reason: `Missing profile field needed for: ${field.hint}` };
    }

    // Step 4: model fallback
    if (rawValue === null || rawValue === '__MODEL__') {
      const modelResp = await askOllama(field, profile, resume, jobContext, sessionContext || []);
      if (!modelResp) {
        return { status: 'skip', reason: 'model unavailable / parse error', hint: field.hint };
      }
      if (modelResp.action === 'ask_user') {
        return { status: 'ask_user', reason: modelResp.ask_reason || field.hint };
      }
      if (modelResp.action === 'skip') {
        return { status: 'skip', reason: 'model chose to skip', hint: field.hint };
      }
      rawValue   = modelResp.value;
      answerSrc  = 'model';
      answerConf = modelResp.confidence || 'medium';
    }

    if (!rawValue && rawValue !== 0) {
      return { status: 'skip', reason: 'no value determined', hint: field.hint };
    }

    // Unit coercion
    rawValue = coerceToFieldUnit(field.hint, rawValue, field.inputType);

    // Step 5: validate
    const v = validate(field, rawValue);
    if (!v.ok) {
      return { status: 'validation_fail', reason: v.reason, value: rawValue, hint: field.hint };
    }

    // Step 6: set value
    try {
      if (field.kind === 'checkbox-group') {
        const chosen = v.value.split(',').map(s => s.trim().toLowerCase());
        field.els.forEach(cb => {
          const label = (cb.getAttribute('data-test-text-selectable-option__input') || fieldHint(cb) || cb.value).toLowerCase();
          const shouldCheck = chosen.some(c => label.includes(c) || c.includes(label));
          if (shouldCheck && !cb.checked) cb.click();
          if (!shouldCheck && cb.checked) cb.click();
        });
      } else if (field.kind === 'typeahead') {
        const ok = await fillTypeahead(field.el, v.value);
        if (!ok) return { status: 'typeahead_fail', reason: 'no suggestion selected', hint: field.hint };
      } else if (field.kind === 'select') {
        reactSetSelect(field.el, v.value);
      } else if (field.kind === 'checkbox') {
        const shouldCheck = /yes|true|1/i.test(v.value);
        if (field.el.checked !== shouldCheck) field.el.click();
      } else if (field.kind === 'radio') {
        // FIX: Use the improved clickRadioOption helper
        const ok = clickRadioOption(field, v.value);
        if (!ok) return { status: 'validation_fail', reason: `radio option "${v.value}" not found`, hint: field.hint };
      } else {
        reactSet(field.el, v.value);
      }
    } catch (e) {
      return { status: 'error', reason: e.message, hint: field.hint };
    }

    // Step 7: teach dump cache (non-PII only)
    const hint = field.hint.toLowerCase();
    const isPii = /\bemail\b|\bphone\b|\bmobile\b|\bfull.?name\b|\bfirst.?name\b|\blast.?name\b/.test(hint);
    if (!isPii) {
      window.__eaDump?.learn?.(field.hint, field.kind, v.value, answerSrc, answerConf);
    }

    return {
      status:    answerConf === 'low' ? 'filled_low_confidence' : 'filled',
      value:     v.value,
      hint:      field.hint,
      source:    answerSrc,
    };
  }

  // ── Fill one modal step ────────────────────────────────────────────────────

  async function fillStep(modal, profile, resume, jobContext, coverLetter, sessionContext) {
    const fields  = extractFields(modal);
    const results = [];

    for (const field of fields) {
      const r = await fillField(field, profile, resume, jobContext, coverLetter, sessionContext);
      results.push(r);

      if (r && (r.status === 'filled' || r.status === 'filled_from_cache' || r.status === 'filled_low_confidence')) {
        sessionContext.push({
          hint:  field.hint,
          kind:  field.kind,
          value: r.value,
        });
      }

      await sleep(120);
    }

    // Auto-check required consent checkboxes
    modal.querySelectorAll('input[type="checkbox"][required]').forEach(cb => {
      if (visible(cb) && !cb.disabled && !cb.checked) cb.click();
    });

    // Uncheck "Follow company"
    const followCb = modal.querySelector('input#follow-company-checkbox');
    if (followCb?.checked) { followCb.click(); }

    return results;
  }

  // ── Wait for element ──────────────────────────────────────────────────────

  function waitFor(selector, root, timeout) {
    root    = root    || document;
    timeout = timeout || 8000;
    return new Promise((resolve, reject) => {
      const el = root.querySelector(selector);
      if (el && visible(el)) return resolve(el);
      const deadline = setTimeout(() => { obs.disconnect(); reject(new Error('Timeout: ' + selector)); }, timeout);
      const obs = new MutationObserver(() => {
        const found = root.querySelector(selector);
        if (found && visible(found)) { clearTimeout(deadline); obs.disconnect(); resolve(found); }
      });
      obs.observe(root, { childList: true, subtree: true, attributes: true });
    });
  }

  // ── Click Easy Apply button ───────────────────────────────────────────────

  function findEasyApplyButton() {
    for (const btn of document.querySelectorAll('button')) {
      if (/easy apply/i.test(btn.textContent) && visible(btn) && !btn.disabled) return btn;
    }
    return null;
  }

  // ── Find the primary action button on current modal step ─────────────────

  function findActionButton(modal) {
    const candidates = [];
    for (const btn of modal.querySelectorAll('button')) {
      if (!visible(btn) || btn.disabled) continue;
      const txt  = btn.textContent.replace(/\s+/g, ' ').trim().toLowerCase();
      const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
      const combined = txt + ' ' + aria;

      if (/submit application|submit your application/.test(combined)) {
        candidates.push({ btn, type: 'submit', priority: 3 });
      } else if (/review your application|review application|\breview\b/.test(combined)) {
        candidates.push({ btn, type: 'review', priority: 2 });
      } else if (/next step|continue to next|^next$|^continue$/.test(combined)) {
        candidates.push({ btn, type: 'next', priority: 1 });
      }
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.priority - a.priority);
    return candidates[0];
  }

  // ── Check for validation errors ───────────────────────────────────────────

  function getVisibleErrors(modal) {
    return Array.from(modal.querySelectorAll(
      '.artdeco-inline-feedback--error, [data-test-form-element-error-message], [class*="error-message"], [class*="form-error"]'
    )).filter(e => visible(e) && e.textContent.trim()).map(e => e.textContent.trim());
  }

  // ── Wait for modal step to change ─────────────────────────────────────────

  async function waitForStepChange(modal, prevStepKey, timeout) {
    timeout = timeout || 10000;
    return new Promise(resolve => {
      const deadline = setTimeout(() => { obs.disconnect(); resolve(); }, timeout);
      const getKey = () => {
        const progress = modal.querySelector(
          '[class*="progress"], [class*="step-indicator"], [aria-valuenow], .t-12.t-black--light.t-normal'
        );
        const firstInput = modal.querySelector('input:not([type="hidden"]):not([disabled]), textarea, select');
        return (progress?.textContent || '') + '|' + (firstInput?.id || firstInput?.name || firstInput?.placeholder || '');
      };
      const obs = new MutationObserver(() => {
        if (getKey() !== prevStepKey) { clearTimeout(deadline); obs.disconnect(); resolve(); }
      });
      obs.observe(modal, { childList: true, subtree: true, attributes: true, characterData: true });
    });
  }

  // ── Main entry ────────────────────────────────────────────────────────────

  async function run(profile, resume, jobContext, coverLetter) {
    const log            = [];
    const flagged        = [];
    const sessionContext = [];

    // 1. Find and click Easy Apply
    const eaBtn = findEasyApplyButton();
    if (!eaBtn) return { success: false, error: 'Easy Apply button not found. Make sure a LinkedIn job is open with an Easy Apply button.' };
    eaBtn.click();

    // 2. Wait for modal
    let modal;
    try {
      modal = await waitFor('.jobs-easy-apply-modal, [data-test-modal-id="easy-apply-modal"], .artdeco-modal[role="dialog"]', document, 7000);
    } catch (_) {
      return { success: false, error: 'Easy Apply modal did not appear. LinkedIn may have changed its layout.' };
    }

    await sleep(900);

    // 3. Step loop
    const MAX_STEPS = 20;
    let stepNum = 0;

    while (stepNum < MAX_STEPS) {
      stepNum++;

      const stepResults = await fillStep(modal, profile, resume, jobContext, coverLetter, sessionContext);
      log.push({ step: stepNum, fields: stepResults });

      stepResults
        .filter(r => r.status === 'ask_user' || r.status === 'flag' || r.status === 'validation_fail')
        .forEach(r => flagged.push({ step: stepNum, ...r }));

      await sleep(600);

      const errors = getVisibleErrors(modal);
      if (errors.length) {
        return {
          success:     false,
          error:       'Form validation error on step ' + stepNum + ': ' + errors[0],
          step:        stepNum,
          needsReview: true,
          log,
          flagged,
        };
      }

      let action = findActionButton(modal);
      if (!action) {
        await sleep(1000);
        action = findActionButton(modal);
        if (!action) {
          return {
            success:     false,
            error:       'Could not find Next/Review/Submit button on step ' + stepNum + '. The form may have a custom layout.',
            step:        stepNum,
            needsReview: true,
            log,
            flagged,
          };
        }
      }

      if (action.type === 'submit') {
        return _result({
          success:     true,
          submitted:   false,
          steps:       stepNum,
          message:     'All fields filled — review carefully, then click Submit.',
          log,
          flagged,
          needsReview: flagged.length > 0,
        });
      }

      if (action.type === 'review') {
        const prevKey = (() => {
          const p = modal.querySelector('[class*="progress"], .t-12.t-black--light.t-normal');
          const i = modal.querySelector('input:not([type="hidden"]), textarea, select');
          return (p?.textContent || '') + '|' + (i?.id || i?.name || '');
        })();
        action.btn.click();
        await waitForStepChange(modal, prevKey, 8000);
        await sleep(800);
        continue;
      }

      const stepKey = (() => {
        const p = modal.querySelector('[class*="progress"], .t-12.t-black--light.t-normal');
        const i = modal.querySelector('input:not([type="hidden"]), textarea, select');
        return (p?.textContent || '') + '|' + (i?.id || i?.name || '');
      })();

      action.btn.click();
      await waitForStepChange(modal, stepKey, 10000);
      await sleep(700);
    }

    return _result({
      success:     false,
      error:       'Reached maximum steps (' + MAX_STEPS + '). The form may have unusually many steps.',
      needsReview: true,
      log,
      flagged,
    });
  }

  // ── Wrap result with dump snapshot ────────────────────────────────────────

  function _result(obj) {
    obj.__dumpSnapshot = window.__eaDump?.flush?.() || null;
    obj.__dumpDirty    = false;
    const allFields = (obj.log || []).flatMap(s => s.fields || []);
    obj._stats = {
      total:      allFields.length,
      filled:     allFields.filter(f => f.status?.startsWith('filled')).length,
      from_cache: allFields.filter(f => f.status === 'filled_from_cache').length,
      skipped:    allFields.filter(f => f.status === 'skipped').length,
      flagged:    (obj.flagged || []).length,
    };
    return obj;
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ── Expose ────────────────────────────────────────────────────────────────

  window.__sentinelEasyApply = { run };

})();