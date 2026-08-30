// profile.js — SentinelX user profile store
// Runs in the service worker context (importScripts'd by background.js).
// All data stays in chrome.storage.local — never sent to any server.

// ── Schema ─────────────────────────────────────────────────────────────────
// This is the canonical shape of a UserProfile object.
// Every field is explicit. AI never fills this — the user does.

const PROFILE_SCHEMA = {
  // Personal
  full_name:       null,   // string
  email:           null,   // string
  phone:           null,   // string
  linkedin_url:    null,   // string
  github_url:      null,   // string
  website:         null,   // string

  // Location
  city:            null,   // string
  state:           null,   // string
  country:         null,   // string
  zip:             null,   // string

  // Work status (most critical — user fills these manually)
  currently_employed:        null,  // bool
  notice_period_days:        null,  // integer (0 = immediate)
  earliest_join_date:        null,  // ISO date string or null
  current_ctc:               null,  // number (annual, local currency)
  current_ctc_currency:      'INR', // string
  expected_ctc:              null,  // number (annual, local currency)
  expected_ctc_currency:     'INR', // string
  work_authorization:        null,  // "citizen"|"permanent_resident"|"work_visa"|"need_sponsorship"
  requires_sponsorship:      null,  // bool
  total_years_experience:    null,  // number (can be auto-computed from resume)

  // Preferences
  preferred_work_mode:  [],   // ["remote","hybrid","onsite"]
  preferred_locations:  [],   // string[]
  open_to_relocation:   null, // bool
  job_types:            [],   // ["fulltime","parttime","contract","internship"]
};

function getProfile() {
  return new Promise(resolve => {
    chrome.storage.local.get(['userProfile'], ({ userProfile }) => {
      resolve(userProfile || { ...PROFILE_SCHEMA });
    });
  });
}

function saveProfile(updates) {
  return new Promise(resolve => {
    chrome.storage.local.get(['userProfile'], ({ userProfile }) => {
      const merged = { ...PROFILE_SCHEMA, ...(userProfile || {}), ...updates };
      chrome.storage.local.set({ userProfile: merged }, () => resolve(merged));
    });
  });
}

function clearProfile() {
  return new Promise(resolve => chrome.storage.local.remove(['userProfile'], resolve));
}

// ── Compute total years of experience from resume ─────────────────────────
// Called automatically when resume is uploaded, result stored in profile.

function computeYearsFromResume(resume) {
  const exp = resume?.experience || [];
  if (!exp.length) return null;

  let totalMonths = 0;
  exp.forEach(e => {
    // Try to parse duration strings like "2 years 3 months", "Jan 2020 - Mar 2023"
    if (e.duration) {
      const ym = e.duration.match(/(\d+)\s*year/i);
      const mm = e.duration.match(/(\d+)\s*month/i);
      totalMonths += (ym ? parseInt(ym[1]) * 12 : 0) + (mm ? parseInt(mm[1]) : 0);
    } else if (e.start_date && e.end_date) {
      try {
        const start = new Date(e.start_date);
        const end   = e.end_date.toLowerCase().includes('present') ? new Date() : new Date(e.end_date);
        if (!isNaN(start) && !isNaN(end)) {
          totalMonths += Math.max(0, (end - start) / (1000 * 60 * 60 * 24 * 30));
        }
      } catch (_) {}
    }
  });

  return totalMonths > 0 ? Math.round(totalMonths / 12 * 10) / 10 : null;
}

// ── Ollama health check ────────────────────────────────────────────────────

async function checkOllama() {
  try {
    const res  = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(2500) });
    const data = await res.json();
    const models = (data.models || []).map(m => m.name);
    return { available: true, models };
  } catch (_) {
    return { available: false, models: [] };
  }
}
