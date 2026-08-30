// eadump.js — SentinelX EasyApply Persistent Q&A Cache
// ─────────────────────────────────────────────────────
// Injected into the LinkedIn tab BEFORE easyapply.js runs.
// Exposes window.__eaDump with:
//   .lookup(hint, kind, options)   → cached answer string or null
//   .learn(hint, kind, value, src) → persist a new answer
//   .visaAnswer(jobLocation)       → sponsorship answer based on visa policy
//   .locationAnswer()              → first preferred location or null
//   .flush()                       → returns the full dump object (for background to save)
//
// Data flow:
//   background.js injects this script with the current dump as window.__eaDumpInit,
//   then injects easyapply.js which calls window.__eaDump.lookup() before Ollama.
//   After run() completes, background.js calls window.__eaDump.flush() and saves
//   the result to chrome.storage.local under the key 'eaDump'.

(function () {
  'use strict';

  if (window.__eaDump) return; // idempotent

  // ── Initialise from seed injected by background.js ───────────────────────
  // background.js does:
  //   await chrome.scripting.executeScript({ func: (d) => { window.__eaDumpInit = d; }, args: [dumpObj] });
  // If the seed is missing we start with an empty store (first run).

  const seed = window.__eaDumpInit || { entries: {}, visa_policy: {}, location_preferences: [] };

  const store = {
    entries:              seed.entries              || {},
    visa_policy:          seed.visa_policy          || {},
    location_preferences: seed.location_preferences || [],
    _dirty: false,  // true when any new answer has been learned this session
  };

  // ── Question fingerprinting ───────────────────────────────────────────────
  // We normalise the hint string to a stable key so that minor label
  // differences ("First name *" vs "First Name") map to the same entry.

  function fingerprintQuestion(hint, kind) {
    const normalised = hint
      .toLowerCase()
      .replace(/[*()[\]{}<>]/g, '')       // strip decoration
      .replace(/\s+/g, ' ')               // collapse whitespace
      .replace(/\bplease\b|\benter\b|\bprovide\b|\byour\b/g, '') // strip filler words
      .trim();
    return `${kind}::${normalised}`;
  }

  // ── Lookup ────────────────────────────────────────────────────────────────
  // Returns the cached answer string, or null if not found / expired.
  // For select/radio, also verifies the answer is still among current options.

  function lookup(hint, kind, options) {
    const key   = fingerprintQuestion(hint, kind);
    const entry = store.entries[key];
    if (!entry) return null;

    // For select/radio, validate the saved answer is still a valid option
    if ((kind === 'select' || kind === 'radio') && options && options.length) {
      const opts = options.map(o => o.toLowerCase());
      const val  = (entry.value || '').toLowerCase();
      const stillValid = opts.some(o => o === val || o.includes(val) || val.includes(o));
      if (!stillValid) {
        // Options changed — invalidate this entry so the model re-answers
        console.debug(`[eaDump] cache miss (options changed) for: "${hint}"`);
        return null;
      }
    }

    // Bump usage count
    entry.use_count = (entry.use_count || 0) + 1;
    entry.last_used = new Date().toISOString();
    store._dirty = true;

    console.debug(`[eaDump] cache HIT "${hint}" → "${entry.value}" (used ${entry.use_count}×)`);
    return entry.value;
  }

  // ── Learn ─────────────────────────────────────────────────────────────────
  // Persist a new Q→A pair. Only saves deterministic answers (skip ask_user,
  // skip low-confidence model guesses unless explicitly trusted).
  //
  // source:
  //   'heuristic'  — came from the fast heuristic matcher (always trusted)
  //   'model'      — came from Ollama (trusted if confidence !== 'low')
  //   'user'       — user manually provided (always trusted, highest priority)

  function learn(hint, kind, value, source, confidence) {
    if (!hint || value == null || value === '') return;
    if (source === 'model' && confidence === 'low') return; // don't cache uncertain answers

    const key = fingerprintQuestion(hint, kind);

    // Never downgrade a 'user' or 'heuristic' entry with a weaker model answer
    const existing = store.entries[key];
    if (existing) {
      const sourcePriority = { user: 3, heuristic: 2, model: 1 };
      const existingPri = sourcePriority[existing.source] || 0;
      const newPri      = sourcePriority[source]          || 0;
      if (existingPri > newPri) {
        console.debug(`[eaDump] skipping learn — existing "${existing.source}" > "${source}" for: "${hint}"`);
        return;
      }
    }

    store.entries[key] = {
      hint,
      kind,
      value:      String(value),
      source,
      confidence: confidence || 'high',
      learned_at: new Date().toISOString(),
      use_count:  0,
      last_used:  null,
    };
    store._dirty = true;
    console.debug(`[eaDump] learned "${hint}" → "${value}" (${source})`);
  }

  // ── Visa / sponsorship answer ─────────────────────────────────────────────
  // Uses visa_policy from the dump.
  // If the job location is outside India (or blank), returns the
  // configured outside-India sponsorship answer.

  function visaAnswer(jobLocation) {
    const p = store.visa_policy;
    if (!p || Object.keys(p).length === 0) return null;

    const home    = (p.home_country || 'India').toLowerCase();
    const loc     = (jobLocation   || '').toLowerCase();
    const outside = loc === '' || !loc.includes(home);

    if (outside) {
      // Outside home country — use H-1B / sponsorship policy
      return p.sponsorship_answer_outside_india || 'Yes';
    }
    return p.sponsorship_answer_inside_india || 'No';
  }

  // ── Location preference answer ────────────────────────────────────────────

  function locationAnswer() {
    const prefs = store.location_preferences;
    if (!prefs || !prefs.length) return null;
    return prefs[0]; // return highest-priority preferred location
  }

  // ── Flush ─────────────────────────────────────────────────────────────────
  // Returns the current store snapshot so background.js can persist it.
  // Also clears the _dirty flag.

  function flush() {
    store._dirty = false;
    const { _dirty, ...snapshot } = store; // eslint-disable-line no-unused-vars
    return {
      _meta: {
        version:     2,
        description: 'SentinelX EasyApply persistent Q&A cache.',
        last_flushed: new Date().toISOString(),
      },
      ...snapshot,
    };
  }

  function isDirty() { return store._dirty; }

  // ── Expose ────────────────────────────────────────────────────────────────

  window.__eaDump = { lookup, learn, visaAnswer, locationAnswer, flush, isDirty };

})();