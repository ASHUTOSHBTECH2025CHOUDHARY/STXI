// background.js — Service worker for SentinelX

importScripts('crypto.js', 'sentinelX.js', 'jobextractor.js', 'profile.js');

const DEFAULT_SERVER = 'https://sentinel-x-delta.vercel.app';

// ── Sentinel lifecycle ────────────────────────────────────────────────────────

let _sentinelReady = null;

async function ensureSentinel() {
  if (!_sentinelReady) _sentinelReady = initSentinel();
  return _sentinelReady;
}

// ── Storage helpers ───────────────────────────────────────────────────────────

function getStorage(keys) {
  return new Promise(r => chrome.storage.local.get(keys, r));
}

function setStorage(obj) {
  return new Promise(r => chrome.storage.local.set(obj, r));
}

function err(msg) {
  return { status: 'error', error: msg };
}

// ── Central API fetch — all auth headers attached here ────────────────────────

async function apiFetch(path, options = {}) {
  await broadcastToActiveTab('loading', LLM_LABELS[path] || 'Working…');
  try {
    const { serverUrl = DEFAULT_SERVER, groqKey = '', sentinelToken = '' } =
      await getStorage(['serverUrl', 'groqKey', 'sentinelToken']);
    const base      = (serverUrl || DEFAULT_SERVER).replace(/\/$/, '');
    const sentinelX = await ensureSentinel();

    const headers = {
      'Content-Type':  'application/json',
      'X-Sentinel-Id': sentinelX,
    };

    // Authorization: Bearer <sentinel_token>
    if (sentinelToken) headers['Authorization'] = `Bearer ${sentinelToken}`;

    // X-GROQ-KEY: user key if available, else omit (server falls back to default)
    if (groqKey && groqKey.trim()) headers['X-GROQ-KEY'] = groqKey.trim();

    const res = await fetch(`${base}${path}`, { headers, ...options });

    if (res.status === 401) {
      await broadcastToActiveTab('idle');
      return err('API key invalid. Please update your Groq key in Settings or use the default key.');
    }
    if (res.status === 500) {
      await broadcastToActiveTab('idle');
      return err('Server error (500). Please retry in a moment.');
    }
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.detail || `HTTP ${res.status}`);
    }
    return res.json();
  } catch (e) {
    await broadcastToActiveTab('error');
    // Network failure — signal disconnect
    chrome.storage.local.set({ serverStatus: 'disconnected' });
    throw e;
  } finally {
    await broadcastToActiveTab('idle');
  }
}

// ── Tab overlay ───────────────────────────────────────────────────────────────

const LLM_LABELS = {
  '/mail/generate':         'Generating email…',
  '/mail/tone-check':       'Checking tone…',
  '/mail/send':             'Sending email…',
  '/job/analyse':           'Analysing job fit…',
  '/chat':                  'Thinking…',
  '/generate/mail_details': 'Extracting job details…',
  '/resume/upload':         'Parsing resume…',
};

async function broadcastToActiveTab(status, label = '') {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, { type: 'TAB_STATUS', status, label }).catch(() => {});
    }
  } catch {}
}

// ── Resume helpers ────────────────────────────────────────────────────────────

async function getStoredResume() {
  const { storedResume } = await getStorage(['storedResume']);
  return storedResume || null;
}

// ── Job page detection ────────────────────────────────────────────────────────

const EXCLUDED_DOMAINS = [
  'google.com','bing.com','yahoo.com','duckduckgo.com','baidu.com','yandex.com',
  'search.brave.com','ecosia.org','chat.openai.com','chatgpt.com','claude.ai',
  'gemini.google.com','copilot.microsoft.com','perplexity.ai','character.ai',
  'poe.com','you.com','mistral.ai','deepseek.com','twitter.com','x.com',
  'reddit.com','facebook.com','instagram.com','threads.net','quora.com',
  'pinterest.com','medium.com','substack.com','news.ycombinator.com',
  'techcrunch.com','forbes.com','businessinsider.com','mail.google.com',
  'outlook.live.com','notion.so','docs.google.com','drive.google.com',
  'trello.com','slack.com',
];

const EXCLUDED_PATH_PATTERNS = [
  /^\/search/,
  /[?&]q=/,
  /[?&]query=/,
  /\/jobs\/?$/,
  /\/careers\/?$/,
];

const JOB_PLATFORM_DOMAINS = [
  'linkedin.com','indeed.com','naukri.com','glassdoor.com',
  'myworkdayjobs.com','lever.co','greenhouse.io','jobs.ashbyhq.com',
  'wellfound.com','angellist.com','monster.com','ziprecruiter.com',
  'dice.com','simplyhired.com','internshala.com','unstop.com',
  'hirist.com','instahyre.com','foundit.in',
];

const JOB_KEYWORDS = [
  'job','career','careers','position','vacancy','vacancies',
  'hiring','apply','opening','internship','recruit','employment',
  'work-with-us','join-us','jobs','join-our-team',
];

function extractDomain(url = '') {
  try { return new URL(url).hostname.replace('www.', ''); } catch { return ''; }
}

function extractPath(url = '') {
  try { return new URL(url).pathname + new URL(url).search; } catch { return ''; }
}

function isJobPage(url = '', title = '') {
  const domain = extractDomain(url);
  const path   = extractPath(url);
  const corpus = (url + ' ' + title).toLowerCase();
  if (EXCLUDED_DOMAINS.some(d => domain === d || domain.endsWith('.' + d))) return false;
  if (EXCLUDED_PATH_PATTERNS.some(p => p.test(path))) return false;
  if (JOB_PLATFORM_DOMAINS.some(d => domain === d || domain.endsWith('.' + d))) {
    const hasDetailPath = /\/(job|jobs|position|view|details?|posting|apply)\/\S+/i.test(path);
    return hasDetailPath || path.split('/').filter(Boolean).length >= 2;
  }
  return JOB_KEYWORDS.some(k => corpus.includes(k));
}

// ── Commands & context menu ───────────────────────────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'open-extension') return;

  // chrome.action.openPopup() is the correct MV3 way to open the popup from
  // a keyboard shortcut. It is available in Chrome 99+ when the extension has
  // a focused browser window. We fall back to opening popup.html as a tab only
  // if openPopup() is unavailable (older Chrome) or throws (no focused window).
  if (chrome.action?.openPopup) {
    try {
      await chrome.action.openPopup();
      return;
    } catch (e) {
      // openPopup() can throw if there is no focused browser window (e.g. the
      // user is in a different app). Fall through to the tab fallback below.
      console.warn('[SentinelX] openPopup() failed, falling back to tab:', e.message);
    }
  }

  // Fallback: open / focus popup.html as a standalone tab
  const url = chrome.runtime.getURL('popup.html');
  chrome.tabs.query({ url }, (tabs) => {
    if (tabs.length > 0) {
      // Popup tab already open — bring it to focus
      chrome.tabs.update(tabs[0].id, { active: true });
      chrome.windows.update(tabs[0].windowId, { focused: true });
    } else {
      chrome.tabs.create({ url, active: true });
    }
  });
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id:       'extract_job',
    title:    'Generate Mail',
    contexts: ['selection']
  });
  // Initialize sentinel on install
  ensureSentinel().catch(console.error);
});

// Re-initialize sentinel on service worker startup (after browser restart, etc.)
ensureSentinel().catch(console.error);

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== 'extract_job') return;
  const jobData = await extractJobFields(info.selectionText);
  await setStorage({ latestJobData: jobData, openTab: 'mail' });
  chrome.windows.create({
    url:    chrome.runtime.getURL('popup.html'),
    type:   'popup',
    width:  480,
    height: 640
  });
});

// ── Message router ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handlers = {
    RESUME_UPLOAD:            () => resumeUpload(msg.file, msg.fileName),
    RESUME_GET:               () => resumeGet(),
    RESUME_CLEAR:             () => resumeClear(),
    SCAN_TABS:                () => scanTabs(),
    PROCESS_TAB:              () => processTab(msg.tabId),
    PROCESS_ALL:              () => processAll(),
    GET_QUEUE:                () => getQueue(),
    CLEAR_QUEUE:              () => clearQueue(),
    // NOTE: FILL_FORM / fillForm removed — "Fill CL only" feature has been
    // removed. Cover letter injection is handled by the Easy Apply engine.
    // ── Profile (local only — never sent to server) ─────────────────────
    PROFILE_GET:              () => getProfile(),
    PROFILE_SAVE:             () => saveProfile(msg.updates),
    PROFILE_CLEAR:            () => clearProfile().then(() => ({ success: true })),
    OLLAMA_CHECK:             () => checkOllama(),
    // ── Easy Apply ─────────────────────────────────────────────────────
    EASY_APPLY_TAB:           () => easyApplyTab(msg.tabId),
    // FAST_APPLY_CLICKED is sent by the injected Fast Apply button in content.js.
    // The sender tab ID is resolved from the message sender automatically.
    FAST_APPLY_CLICKED:       () => easyApplyTab(sender.tab?.id),
    // ── EasyApply Dump (persistent Q&A cache) ──────────────────────────
    // EA_DUMP_GET   — returns the full dump object from chrome.storage
    // EA_DUMP_SAVE  — merges entries from msg.dump into the stored dump
    // EA_DUMP_RESET — clears all learned entries (keeps visa_policy)
    EA_DUMP_GET:   () => getStorage('eaDump').then(({ eaDump }) => ({ dump: eaDump || null })),
    EA_DUMP_SAVE:  () => saveDump(msg.dump),
    EA_DUMP_RESET: () => resetDump(),
    MAIL_GENERATE:            () => mailGenerate(msg.data),
    MAIL_TONE_CHECK:          () => mailToneCheck(msg.data),
    MAIL_SEND:                () => mailSend(msg.data),
    ENCRYPT_APP_PASSWORD:     () => encryptAppPassword(msg.plaintext),
    HR_LOG_GET:               () => hrLogGet(),
    CHAT_SEND:                () => chatSend(msg.data),
    CHAT_CLEAR:               () => chatClear(),
    CHAT_HISTORY:             () => chatHistory(),
    OPEN_EXTENSION_WITH_DATA: () => openExtensionWithData(msg),
    GET_SENTINEL:             () => ensureSentinel().then(sx => ({ sentinelX: sx })),
    CHECK_SERVER:             () => checkServerHealth(),
    USE_DEFAULT_KEY:          () => clearGroqKey(),
  };

  const handler = handlers[msg.type];
  if (!handler) return false;
  handler().then(sendResponse).catch(e => sendResponse(err(e.message)));
  return true;
});

// ── Server health check ───────────────────────────────────────────────────────
async function clearGroqKeyFromServer() {
  try {
    const sentinelX = await ensureSentinel();
    const { serverUrl = DEFAULT_SERVER, sentinelToken = '' } = await getStorage(['serverUrl', 'sentinelToken']);
    const base = (serverUrl || DEFAULT_SERVER).replace(/\/$/, '');
    const headers = { 'X-Sentinel-Id': sentinelX };
    if (sentinelToken) headers['Authorization'] = `Bearer ${sentinelToken}`;
    await fetch(`${base}/clear_groq_key`, { method: 'POST', headers });
  } catch (e) {
    console.error('Failed to clear Groq key from server:', e);
  }
}

async function checkServerHealth() {
  try {
    const { serverUrl = DEFAULT_SERVER, groqKey = '' } =
      await getStorage(['serverUrl', 'groqKey']);
    const base      = (serverUrl || DEFAULT_SERVER).replace(/\/$/, '');
    const sentinelX = await ensureSentinel();

    const headers = {
      'Content-Type':  'application/json',
      'X-Sentinel-Id': sentinelX,
    };

    // Upload encrypted groq key if user has one
    if (groqKey && groqKey.trim()) {
      try {
        const encryptedKey = await encryptForServer(groqKey.trim(), sentinelX);
        headers['X-Groq-Key'] = encryptedKey;
        await setStorage({ groqKey: encryptedKey }); // Ensure trimmed key is saved
      } catch {
        console.error('Failed to encrypt Groq key for health check. Proceeding without it.');
      }
    }

    const { sentinelToken = '' } = await getStorage(['sentinelToken']);
    if (sentinelToken) headers['Authorization'] = `Bearer ${sentinelToken}`;

    const res  = await fetch(`${base}/health`, { headers });
    const data = await res.json();

    if (data.sentinel_token) {
      await setStorage({ sentinelToken: data.sentinel_token });
    }

    await setStorage({ serverStatus: 'connected' });
    return {
      status:        'connected',
      groq_key_valid: data.groq_key_valid === true,
      resume_present: data.resume_present === true,
    };
  } catch {
    await setStorage({ serverStatus: 'disconnected' });
    return { status: 'disconnected' };
  }
}

async function clearGroqKey() {
  await setStorage({ groqKey: '', sentinelToken: '',serverUrl:'https://sentinel-x-delta.vercel.app' });
  await clearGroqKeyFromServer();
  await checkServerHealth();
  return { success: true };
}

// ── Resume ────────────────────────────────────────────────────────────────────

async function resumeUpload(base64Data, fileName) {
  try {
    const binary = atob(base64Data);
    const bytes  = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const ext  = fileName.split('.').pop().toLowerCase();
    const mime = ext === 'pdf' ? 'application/pdf' : 'application/json';
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: mime }), fileName);

    const sentinelX = await ensureSentinel();
    const { serverUrl = DEFAULT_SERVER, sentinelToken = '', groqKey = '' } =
      await getStorage(['serverUrl', 'sentinelToken', 'groqKey']);
    const base = (serverUrl || DEFAULT_SERVER).replace(/\/$/, '');

    const headers = { 'X-Sentinel-Id': sentinelX };
    if (sentinelToken) headers['Authorization'] = `Bearer ${sentinelToken}`;
    if (groqKey && groqKey.trim()) headers['X-GROQ-KEY'] = groqKey.trim();

    const res = await fetch(`${base}/resume/upload`, { method: 'POST', body: form, headers });

    if (res.status === 401) return err('API key invalid. Update your Groq key in Settings or use the default key.');
    if (res.status === 500) return err('Server error (500). Please retry.');
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      return err(e.detail || 'Upload failed');
    }

    const parsed = await res.json();
    const payload = {
      status:         'stored',
      resume_present: true,
      last_updated:   new Date().toISOString(),
      resume:         parsed.resume,
      file_b64:       base64Data,
      file_name:      fileName
    };
    await setStorage({ storedResume: payload, resumeUploaded: true });

    // Auto-update profile: years of experience computed from resume dates
    const yearsComputed = computeYearsFromResume(parsed.resume);
    if (yearsComputed != null) {
      const existing = await getProfile();
      // Only update if user hasn't manually set it
      if (existing.total_years_experience == null) {
        await saveProfile({ total_years_experience: yearsComputed });
      }
    }

    return payload;
  } catch (e) {
    return err('Cannot reach server. Check server URL in Settings.');
  }
}

async function resumeGet() {
  const stored = await getStoredResume();
  if (stored && stored.resume_present) return { ...stored, status: 'retrieved' };
  return { status: 'not_found', resume_present: false, last_updated: null, resume: 'NO_RESUME_FOUND' };
}

async function resumeClear() {
  await setStorage({ storedResume: null, resumeUploaded: false });
  return { status: 'cleared', resume_present: false };
}

// ── Job extraction ────────────────────────────────────────────────────────────

async function extractJobFields(raw_job_description) {
  try {
    return await apiFetch('/generate/mail_details', {
      method: 'POST',
      body:   JSON.stringify({ sentinel_x: await ensureSentinel(), raw_job_description })
    });
  } catch (e) {
    console.error('Error extracting job fields:', e);
    return {};
  }
}

async function openExtensionWithData(msg) {
  const rawText = msg.payload?.text || '';
  const jobData = await extractJobFields(rawText);
  await setStorage({ latestJobData: jobData, openTab: 'mail' });
  await chrome.windows.create({
    url:    chrome.runtime.getURL('popup.html'),
    type:   'popup',
    width:  480,
    height: 640
  });
  return { success: true };
}

// ── Tab scanning & analysis ───────────────────────────────────────────────────

async function scanTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs
    .filter(t => t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('edge://') && isJobPage(t.url, t.title))
    .map(t => ({ id: t.id, url: t.url, title: t.title }));
}

async function extractJobData(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => window.__jobAgent?.extractJobData?.() ?? null,
    });
    return results?.[0]?.result ?? null;
  } catch (e) {
    console.error('[JobAgent] extractJobData error:', e);
    return null;
  }
}

async function processTab(tabId) {
  try {
    const resumeData = await resumeGet();
    if (!resumeData.resume_present) return err('No resume found. Upload your resume in the Resume tab first.');

    const jobData = await extractJobData(tabId);
    if (!jobData) return err('Could not extract job data from this page. Make sure the page is fully loaded.');
    if (jobData.error) return err(jobData.error);  // surfaced from jobextractor.js validation
    if (!jobData.title && !jobData.description) return err('This page does not appear to contain a job description.');

    let aiResult;
    try {
      aiResult = await apiFetch('/job/analyse', {
        method: 'POST',
        body:   JSON.stringify({ job: jobData, resume: resumeData.resume })
      });
    } catch (e) {
      return err('Analysis failed: ' + (e.message || 'Server unreachable'));
    }

    if (aiResult?.status === 'error') return err(aiResult.error || 'Analysis failed');

    const entry = { tabId, jobData, aiResult, status: 'ready', timestamp: Date.now() };
    const { queue = [] } = await getStorage('queue');
    const idx = queue.findIndex(q => q.tabId === tabId);
    if (idx >= 0) queue[idx] = entry; else queue.push(entry);
    await setStorage({ queue });
    return { success: true, entry };
  } catch (e) {
    return err(e.message || 'Unexpected error during analysis');
  }
}

async function processAll() {
  const tabs    = await scanTabs();
  const results = [];
  for (const tab of tabs) {
    const result = await processTab(tab.id);
    results.push({ tabId: tab.id, ...result });
  }
  return results;
}

async function getQueue() {
  const { queue = [] } = await getStorage('queue');
  return queue;
}

async function clearQueue() {
  await setStorage({ queue: [] });
  return { success: true };
}

// ── Easy Apply ────────────────────────────────────────────────────────────────
// NOTE: fillForm() was removed alongside the "Fill CL only" feature.
// Cover letter injection is now handled entirely within easyApplyTab().

// ── EasyApply dump helpers ────────────────────────────────────────────────────

/**
 * Merge new entries into the stored dump.
 * Incoming entries with source 'user' always win over existing entries.
 * 'model' entries only overwrite if there's no existing entry or existing is
 * also 'model'. 'heuristic' entries overwrite 'model' but not 'user'.
 */
async function saveDump(incoming) {
  if (!incoming || typeof incoming !== 'object') return { success: false, error: 'Invalid dump' };
  const { eaDump = {} } = await getStorage('eaDump');
  const base = eaDump || { entries: {}, visa_policy: {}, location_preferences: [] };

  // Merge entries
  const srcPriority = { user: 3, heuristic: 2, model: 1 };
  for (const [key, val] of Object.entries(incoming.entries || {})) {
    const existing = base.entries[key];
    const inPri    = srcPriority[val.source]      || 0;
    const exPri    = srcPriority[existing?.source] || 0;
    if (!existing || inPri >= exPri) {
      base.entries[key] = val;
    }
  }

  // Merge visa_policy and location_preferences if provided
  if (incoming.visa_policy && Object.keys(incoming.visa_policy).length) {
    base.visa_policy = { ...base.visa_policy, ...incoming.visa_policy };
  }
  if (Array.isArray(incoming.location_preferences) && incoming.location_preferences.length) {
    base.location_preferences = incoming.location_preferences;
  }

  await setStorage({ eaDump: base });
  return { success: true, entry_count: Object.keys(base.entries).length };
}

/**
 * Reset all learned model/heuristic entries but keep visa_policy and
 * user-supplied entries (source === 'user') intact.
 */
async function resetDump() {
  const { eaDump = {} } = await getStorage('eaDump');
  if (!eaDump) return { success: true, cleared: 0 };

  const before = Object.keys(eaDump.entries || {}).length;
  eaDump.entries = Object.fromEntries(
    Object.entries(eaDump.entries || {}).filter(([, v]) => v.source === 'user')
  );
  await setStorage({ eaDump });
  const after   = Object.keys(eaDump.entries).length;
  return { success: true, cleared: before - after, kept: after };
}

// ── EasyApply automation ──────────────────────────────────────────────────────

async function easyApplyTab(tabId) {
  try {
    // 1. Get resume
    const resumeData = await resumeGet();
    if (!resumeData.resume_present) {
      return err('Upload your resume first (Resume tab).');
    }

    // 2. Get profile — the ground truth the model uses
    const profile = await getProfile();

    // 3. Get job data + cover letter from queue
    const { queue = [] } = await getStorage('queue');
    const entry       = queue.find(q => q.tabId === tabId);
    const coverLetter = entry?.aiResult?.cover_letter || '';
    const jobContext  = entry?.jobData ? {
      title:       entry.jobData.title,
      company:     entry.jobData.company,
      location:    entry.jobData.location,
      description: (entry.jobData.description || '').slice(0, 1200),
    } : {};

    // 4. Load the persistent Q&A dump from storage
    const { eaDump = null } = await getStorage('eaDump');

    // 5. Inject eadump.js FIRST — it must be present before easyapply.js runs
    await chrome.scripting.executeScript({ target: { tabId }, files: ['eadump.js'] });
    // Seed the dump into the tab's window so eadump.js can initialise from it
    await chrome.scripting.executeScript({
      target: { tabId },
      func:   (dump) => { window.__eaDumpInit = dump; },
      args:   [eaDump || { entries: {}, visa_policy: {}, location_preferences: [] }],
    });

    // 6. Inject easyapply.js
    await chrome.scripting.executeScript({ target: { tabId }, files: ['easyapply.js'] });
    await new Promise(r => setTimeout(r, 300));

    // 7. Run the automation inside the tab
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (prof, res, jobCtx, cl) => {
        return await window.__sentinelEasyApply.run(prof, res, jobCtx, cl);
      },
      args: [profile, resumeData.resume, jobContext, coverLetter],
    });

    const result = results?.[0]?.result;
    if (!result) return err('Easy Apply script returned no result. Try reloading the job tab.');

    // 8. Persist the dump snapshot so learned answers survive across sessions
    if (result.__dumpSnapshot) {
      await setStorage({ eaDump: result.__dumpSnapshot });
      console.info('[EasyApply] dump saved —',
        Object.keys(result.__dumpSnapshot.entries || {}).length, 'entries,',
        result._stats?.from_cache || 0, 'cache hits this session');
    }

    // 9. Update queue status
    if (result.success) {
      const { queue: q = [] } = await getStorage('queue');
      const idx = q.findIndex(x => x.tabId === tabId);
      if (idx >= 0) {
        q[idx].status   = result.submitted ? 'applied' : 'review';
        q[idx].eaResult = { flagged: result.flagged, steps: result.steps, stats: result._stats };
        await setStorage({ queue: q });
      }
    }

    return result;
  } catch (e) {
    console.error('[EasyApply]', e);
    return err('Easy Apply failed: ' + (e.message || 'Unknown error'));
  }
}

// ── Mail ──────────────────────────────────────────────────────────────────────

async function encryptAppPassword(plaintext) {
  try {
    const sentinelX  = await ensureSentinel();
    const encrypted  = await encryptForServer(plaintext, sentinelX);
    return { encrypted };
  } catch (e) {
    return err('Encryption failed: ' + e.message);
  }
}

async function mailGenerate(data) {
  try {
    const sentinelX = await ensureSentinel();
    const resume    = (await resumeGet()).resume;
    return await apiFetch('/mail/generate', {
      method: 'POST',
      body:   JSON.stringify({ ...data, sentinel_x: sentinelX, resume })
    });
  } catch (e) { return err(e.message); }
}

async function mailToneCheck(data) {
  try {
    return await apiFetch('/mail/tone-check', { method: 'POST', body: JSON.stringify(data) });
  } catch (e) { return err(e.message); }
}

async function mailSend(data) {
  try {
    const sentinelX = await ensureSentinel();
    const stored    = await getStoredResume();
    const file_b64  = data.custom_file_b64  || stored?.file_b64  || '';
    const file_name = data.custom_file_name || stored?.file_name || '';
    return await apiFetch('/mail/send', {
      method: 'POST',
      body:   JSON.stringify({
        ...data,
        sentinel_x:            sentinelX,
        encrypted_app_password: data.app_password || '',
        app_password:           undefined,
        resume:                 stored?.resume || {},
        custom_file_b64:        file_b64,
        custom_file_name:       file_name
      })
    });
  } catch (e) { return err(e.message); }
}

async function hrLogGet() {
  try {
    return await apiFetch('/mail/hr_log');
  } catch { return []; }
}

// ── Chat ──────────────────────────────────────────────────────────────────────

async function chatSend(data) {
  try {
    const sentinelX = await ensureSentinel();
    const resume    = (await resumeGet()).resume || {};
    const { queue = [] } = await getStorage('queue');
    const hrLog     = await hrLogGet();
    return await apiFetch('/chat', {
      method: 'POST',
      body:   JSON.stringify({
        sentinel_x:  sentinelX,
        resume,
        message:     data.message,
        job_queue:   queue,
        hr_contacts: hrLog
      })
    });
  } catch (e) { return err(e.message); }
}

async function chatClear() {
  try {
    return await apiFetch('/chat/clear', { method: 'DELETE' });
  } catch { return err('Server not reachable'); }
}

async function chatHistory() {
  try {
    return await apiFetch('/chat/history');
  } catch { return { history: [] }; }
}

// ── SPA navigation listener for LinkedIn (and other SPAs) ─────────────────────
// LinkedIn never triggers a full page reload when navigating between sections.
// content.js patches pushState/replaceState to fire 'locationchange', but that
// only works if the content script is already injected. This webNavigation
// listener catches SPA-style history updates from the background side and
// re-injects / pings the content script so the pill appears without a reload.

chrome.webNavigation.onHistoryStateUpdated.addListener(async (details) => {
  if (details.frameId !== 0) return; // top-level frame only

  const url = details.url || '';
  const lower = url.toLowerCase();

  // Only act on known job-related SPAs
  const isTracked =
    lower.includes('linkedin.com') ||
    lower.includes('indeed.com') ||
    lower.includes('glassdoor.com') ||
    lower.includes('naukri.com');

  if (!isTracked) return;

  // Inject content.js if not already injected (idempotent — guard is inside the IIFE)
  try {
    await chrome.scripting.executeScript({
      target: { tabId: details.tabId },
      files: ['content.js'],
    });
  } catch (_) {
    // Script already running — that's fine. Send a manual locationchange instead.
    chrome.tabs.sendMessage(details.tabId, { type: 'SPA_NAVIGATE', url: details.url }).catch(() => {});
  }
});