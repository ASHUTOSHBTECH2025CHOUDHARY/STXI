// popup.js — SentinelX popup controller

let queue        = [];
let tabs         = [];
let selectedEntry = null;
let storedResume  = null;
let resumeReady   = false;
let customFileB64  = '';
let customFileName = '';

const LOCKED_TABS = ['agent','mail','chat'];

// ── Bootstrap ─────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  await loadResume();
  await refreshQueue();

  setupNav();
  setupResumeTab();
  setupProfileTab();
  setupAgentTab();
  setupFilterTab();
  setupSettingsTab();
  setupMailTab();
  setupChatTab();
  setupDumpTab();   // Q&A cache / visa policy panel

  updateTabLocks();
  checkServerStatus();
  checkOllamaStatus();   // non-blocking

  await openRequestedTab();
});

// ── Server status (non-blocking, real-time) ───────────────────────────────────

async function checkServerStatus() {
  setBadge('connecting');
  const result = await send('CHECK_SERVER');
  if (result?.status === 'connected') {
    setBadge('ok');
    setGroqBadge(result.groq_key_valid === true);
  } else {
    setBadge('off');
    setGroqBadge(false);
  }
}

function setBadge(state) {
  const b    = document.getElementById('server-badge');
  const text = document.getElementById('server-badge-text');
  b.className = 'server-badge ';
  if (state === 'ok')         { b.className += 'sb-ok';         text.textContent = 'Connected'; }
  else if (state === 'connecting') { b.className += 'sb-connecting'; text.textContent = 'Connecting'; }
  else                        { b.className += 'sb-off';        text.textContent = 'Disconnected'; }
}

function setGroqBadge(valid) {
  const b = document.getElementById('groq-badge');
  if (!b) return;
  b.className   = 'server-badge ' + (valid ? 'sb-ok' : 'sb-off');
  b.textContent = valid ? 'own key ✓' : 'server key';
}

// ── Resume gate — lock/unlock tabs ───────────────────────────────────────────

function updateTabLocks() {
  LOCKED_TABS.forEach(tab => {
    const el = document.getElementById('nav-' + tab) ||
               document.querySelector(`.nt[data-tab="${tab}"]`);
    if (!el) return;
    if (resumeReady) {
      el.classList.remove('nt-disabled', 'nt-lock');
    } else {
      el.classList.add('nt-disabled', 'nt-lock');
    }
  });
}

// ── Nav ───────────────────────────────────────────────────────────────────────

function setupNav() {
  document.querySelectorAll('.nt').forEach(t => {
    t.addEventListener('click', () => {
      if (t.classList.contains('nt-disabled')) {
        toast('Upload your resume first to access this feature', true);
        return;
      }
      document.querySelectorAll('.nt').forEach(x => x.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      document.getElementById('tab-' + t.dataset.tab).classList.add('active');
      // filter tab has no on-show logic needed
    });
  });
}

async function openRequestedTab() {
  const { openTab } = await getStorage(['openTab']);
  if (!openTab) return;
  await setStorage({ openTab: null });
  if (LOCKED_TABS.includes(openTab) && !resumeReady) return;
  document.querySelectorAll('.nt').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(x => x.classList.remove('active'));
  const tabBtn   = document.querySelector(`.nt[data-tab="${openTab}"]`);
  const tabPanel = document.getElementById('tab-' + openTab);
  if (tabBtn && tabPanel) {
    tabBtn.classList.add('active');
    tabPanel.classList.add('active');
  }
}

// ── Resume tab ────────────────────────────────────────────────────────────────

function setupResumeTab() {
  const drop  = document.getElementById('drop');
  const input = document.getElementById('file-input');

  drop.addEventListener('dragover',  e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => {
    e.preventDefault(); drop.classList.remove('over');
    if (e.dataTransfer.files[0]) processFile(e.dataTransfer.files[0]);
  });
  input.addEventListener('change', () => { if (input.files[0]) processFile(input.files[0]); });

  document.getElementById('btn-clear-resume').addEventListener('click', async () => {
    await send('RESUME_CLEAR');
    storedResume = null;
    resumeReady  = false;
    document.getElementById('rcard').classList.remove('show');
    document.getElementById('jsprev').classList.remove('show');
    document.getElementById('btn-clear-resume').disabled = true;
    document.getElementById('btn-copy-resume').disabled  = true;
    updateTabLocks();
    toast('Resume cleared');
  });

  document.getElementById('btn-copy-resume').addEventListener('click', () => {
    if (!storedResume) return;
    navigator.clipboard.writeText(JSON.stringify(storedResume, null, 2));
    toast('Copied!');
  });

  document.getElementById('jstoggle').addEventListener('click', () => {
    const body = document.getElementById('jsbody');
    const open = body.classList.toggle('open');
    document.getElementById('jsarrow').textContent = open ? '▾' : '▸';
  });
}

async function processFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (!['pdf', 'json', 'docx'].includes(ext)) { showResumeErr('Only PDF, DOCX, or JSON files supported.'); return; }
  hideResumeErr();
  setProgress('Reading file…', 15);
  const base64 = await toBase64(file);
  setProgress('Parsing with Groq…', 45);
  const result = await send('RESUME_UPLOAD', { file: base64, fileName: file.name });
  if (result.status === 'error') {
    showResumeErr(result.error);
    hideProgress();
    return;
  }
  setProgress('Storing…', 90);
  await sleep(300);
  hideProgress();
  renderResume(result);
  toast('Resume saved!');
}

async function loadResume() {
  const result = await send('RESUME_GET');
  if (result.status === 'retrieved') {
    renderResume(result);
  }
}

function renderResume(result) {
  storedResume = result;
  const r = result.resume;
  if (!r || r === 'NO_RESUME_FOUND') return;

  resumeReady = true;
  document.getElementById('rc-name').textContent   = r.basic_info?.name || 'Unknown';
  document.getElementById('rc-time').textContent   = result.last_updated ? new Date(result.last_updated).toLocaleString() : '—';
  document.getElementById('rc-exp').textContent    = (r.experience?.length || 0) + ' roles';
  document.getElementById('rc-skills').textContent = countSkills(r.skills) + ' items';
  document.getElementById('rc-edu').textContent    = (r.education?.length || 0) + ' entries';
  document.getElementById('rc-proj').textContent   = (r.projects?.length || 0) + ' items';
  document.getElementById('rc-certs').textContent  = (r.professional_certifications?.length || 0) + ' certs';

  document.getElementById('rcard').classList.add('show');
  document.getElementById('jsbody').textContent = JSON.stringify(r, null, 2);
  document.getElementById('jsprev').classList.add('show');
  document.getElementById('btn-clear-resume').disabled = false;
  document.getElementById('btn-copy-resume').disabled  = false;

  updateTabLocks();
}

function countSkills(s) {
  if (!s) return 0;
  return ['technical', 'soft', 'languages', 'tools'].reduce((n, k) => n + (s[k]?.length || 0), 0);
}

// ── Agent tab ─────────────────────────────────────────────────────────────────

function setupAgentTab() {
  document.getElementById('btn-scan').addEventListener('click', doScan);
  document.getElementById('btn-process-all').addEventListener('click', doProcessAll);
  document.getElementById('btn-clear-q').addEventListener('click', doClearQueue);
  document.getElementById('btn-back').addEventListener('click', showList);
  // NOTE: "Fill CL only" (btn-fill / doFill) removed — cover letter injection
  // is now handled exclusively by the Easy Apply engine (doEasyApply).
  document.getElementById('btn-skip').addEventListener('click', doSkip);
  document.getElementById('btn-easy-apply').addEventListener('click', doEasyApply);
  document.getElementById('btn-copy-cl').addEventListener('click', () => {
    navigator.clipboard.writeText(document.getElementById('d-cover').value);
    toast('Copied!');
  });
}

// ── Profile tab ───────────────────────────────────────────────────────────────

const PF_FIELDS = [
  ['pf-name',        'full_name'],
  ['pf-email',       'email'],
  ['pf-phone',       'phone'],
  ['pf-linkedin',    'linkedin_url'],
  ['pf-github',      'github_url'],
  ['pf-website',     'website'],
  ['pf-city',        'city'],
  ['pf-state',       'state'],
  ['pf-country',     'country'],
  ['pf-zip',         'zip'],
  ['pf-notice',      'notice_period_days'],
  ['pf-yoe',         'total_years_experience'],
  ['pf-ctc-current', 'current_ctc'],
  ['pf-ctc-expected','expected_ctc'],
  ['pf-currency',    'current_ctc_currency'],
  ['pf-workauth',    'work_authorization'],
];

async function setupProfileTab() {
  // Load and render existing profile.
  // Guard against undefined: the service worker may return undefined if it is
  // inactive at the time of the message (e.g. first popup open after browser
  // restart). Falling back to {} prevents TypeError on profile[key] access.
  const profile = (await send('PROFILE_GET')) ?? {};
  PF_FIELDS.forEach(([id, key]) => {
    const el = document.getElementById(id);
    if (!el) return;
    const val = profile[key];
    if (val != null && val !== '') el.value = val;
  });
  if (profile.currently_employed)  document.getElementById('pf-employed').checked  = true;
  if (profile.open_to_relocation)  document.getElementById('pf-relocation').checked = true;

  document.getElementById('btn-save-profile').addEventListener('click', async () => {
    const updates = {};
    PF_FIELDS.forEach(([id, key]) => {
      const el = document.getElementById(id);
      if (!el) return;
      const raw = el.value.trim();
      // Numeric fields
      if (['notice_period_days','total_years_experience','current_ctc','expected_ctc'].includes(key)) {
        updates[key] = raw === '' ? null : Number(raw);
      } else {
        updates[key] = raw === '' ? null : raw;
      }
    });
    updates.currently_employed = document.getElementById('pf-employed').checked;
    updates.open_to_relocation = document.getElementById('pf-relocation').checked;
    updates.expected_ctc_currency = updates.current_ctc_currency; // mirror

    await send('PROFILE_SAVE', { updates });
    document.getElementById('profile-err').classList.remove('show');
    toast('Profile saved ✓');
  });

  document.getElementById('btn-clear-profile').addEventListener('click', async () => {
    await send('PROFILE_CLEAR');
    PF_FIELDS.forEach(([id]) => { const el = document.getElementById(id); if(el) el.value = ''; });
    document.getElementById('pf-employed').checked  = false;
    document.getElementById('pf-relocation').checked = false;
    toast('Profile cleared');
  });

  document.getElementById('btn-check-ollama').addEventListener('click', checkOllamaStatus);
}

async function checkOllamaStatus() {
  const badge = document.getElementById('ollama-badge');
  if (!badge) return;
  badge.className = 'ollama-badge ollama-off';
  badge.innerHTML = '<span style="width:6px;height:6px;border-radius:50%;background:currentColor;display:inline-block"></span> Checking…';
  const result = await send('OLLAMA_CHECK');
  if (result?.available) {
    badge.className = 'ollama-badge ollama-ok';
    const models = result.models?.length ? result.models[0] : 'running';
    badge.innerHTML = `<span style="width:6px;height:6px;border-radius:50%;background:currentColor;display:inline-block"></span> Ollama · ${models}`;
  } else {
    badge.className = 'ollama-badge ollama-off';
    badge.innerHTML = '<span style="width:6px;height:6px;border-radius:50%;background:currentColor;display:inline-block"></span> Ollama offline';
  }
}

async function doScan() {
  const btn = document.getElementById('btn-scan');
  btn.innerHTML = '<span class="spin"></span> Scanning…'; btn.disabled = true;
  hideAgentErr();
  tabs = await send('SCAN_TABS');
  renderTabList();
  document.getElementById('btn-process-all').disabled = tabs.length === 0;
  document.getElementById('st-tabs').textContent = tabs.length;
  toast(tabs.length ? `Found ${tabs.length} job tab${tabs.length > 1 ? 's' : ''}` : 'No job tabs found');
  btn.innerHTML = '⟳ Scan tabs'; btn.disabled = false;
}

async function doProcessAll() {
  const btn = document.getElementById('btn-process-all');
  btn.innerHTML = '<span class="spin"></span> Processing…'; btn.disabled = true;
  hideAgentErr();
  const results = await send('PROCESS_ALL');
  // Check for any errors in results
  if (Array.isArray(results)) {
    const errs = results.filter(r => r.error);
    if (errs.length) showAgentErr(errs[0].error);
  }
  queue = await send('GET_QUEUE');
  renderTabList(); updateStats();
  toast('Done!');
  btn.innerHTML = '▶ Process all'; btn.disabled = false;
}

async function doClearQueue() {
  await send('CLEAR_QUEUE');
  queue = [];
  renderTabList(); updateStats();
  toast('Queue cleared');
}

function renderTabList() {
  const list = document.getElementById('tlist');
  if (!tabs.length) {
    list.innerHTML = `<div class="empty"><div class="empty-ico">⧉</div><div>Open job pages then click Scan tabs</div></div>`;
    return;
  }
  list.innerHTML = tabs.map(t => {
    const entry = queue.find(q => q.tabId === t.id);
    const sc    = entry?.aiResult?.fit_score;
    const scCls = sc >= 7 ? 'sc-hi' : sc >= 5 ? 'sc-md' : 'sc-lo';
    const statusClass = entry?.status ? 's-' + entry.status : 's-idle';
    return `
      <div class="titem">
        <span class="tdot ${statusClass}"></span>
        <div class="tinfo">
          <div class="ttitle">${esc(entry?.jobData?.title || t.title || t.url)}</div>
          ${entry?.jobData?.company ? `<div class="tco">${esc(entry.jobData.company)}</div>` : ''}
        </div>
        ${sc != null ? `<span class="tscore ${scCls}">${sc}/10</span>` : ''}
        <button class="btn btn-secondary" style="font-size:10px;padding:4px 9px" data-tid="${t.id}">
          ${entry?.status === 'ready' ? 'View' : 'Analyse'}
        </button>
      </div>`;
  }).join('');

  list.querySelectorAll('[data-tid]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const tabId = parseInt(btn.dataset.tid);
      const ex = queue.find(q => q.tabId === tabId);
      if (ex?.status === 'ready') { showDetail(ex); return; }
      btn.innerHTML = '<span class="spin"></span>'; btn.disabled = true;
      hideAgentErr();
      const result = await send('PROCESS_TAB', { tabId });
      if (result?.status === 'error' || result?.error) {
        showAgentErr(result.error || 'Analysis failed. Try reloading the job page.');
        btn.innerHTML = 'Analyse'; btn.disabled = false;
        return;
      }
      queue = await send('GET_QUEUE');
      renderTabList(); updateStats();
      const fresh = queue.find(q => q.tabId === tabId);
      if (fresh?.status === 'ready') showDetail(fresh);
      else toast('Analysis complete');
    });
  });
}

function showAgentErr(msg) {
  const e = document.getElementById('agent-err');
  if (!e) return;
  e.textContent = msg; e.classList.add('show');
}
function hideAgentErr() {
  const e = document.getElementById('agent-err');
  if (e) e.classList.remove('show');
}

function showDetail(entry) {
  selectedEntry = entry;
  document.getElementById('listv').classList.add('hidden');
  document.getElementById('detail').classList.add('open');
  const ai = entry.aiResult || {}, job = entry.jobData || {};
  document.getElementById('d-title').textContent = job.title || '—';
  document.getElementById('d-meta').textContent  = [job.company, job.location].filter(Boolean).join(' · ') || '—';
  const sc  = ai.fit_score || 0;
  const cls = sc >= 7 ? 'fb-hi' : sc >= 5 ? 'fb-md' : 'fb-lo';
  document.getElementById('d-fit').innerHTML    = `<span class="fitbadge ${cls}">● ${sc}/10 — ${esc(ai.fit_reason || '')}</span>`;
  document.getElementById('d-skills').innerHTML = (ai.key_skills_match || []).map(s => `<span class="spill">${esc(s)}</span>`).join('') || '<span style="color:var(--muted)">—</span>';
  document.getElementById('d-skills-missed').innerHTML = (ai.missing_skills || []).map(s => `<span class="spill">${esc(s)}</span>`).join('') || '<span style="color:var(--muted)">—</span>';
  document.getElementById('d-cover').value = ai.cover_letter || '';
}

function showList() {
  document.getElementById('listv').classList.remove('hidden');
  document.getElementById('detail').classList.remove('open');
  selectedEntry = null;
}

async function doSkip() {
  if (!selectedEntry) return;
  const { queue: q = [] } = await getStorage('queue');
  const idx = q.findIndex(x => x.tabId === selectedEntry.tabId);
  if (idx >= 0) { q[idx].status = 'skipped'; await setStorage({ queue: q }); }
  queue = await send('GET_QUEUE');
  toast('Skipped'); showList(); renderTabList();
}

async function doEasyApply() {
  if (!selectedEntry) return;

  const btn       = document.getElementById('btn-easy-apply');
  const statusBox = document.getElementById('ea-status');
  const flaggedEl = document.getElementById('ea-flagged');
  const flaggedList = document.getElementById('ea-flagged-list');

  btn.innerHTML = '<span class="spin"></span> Running…'; btn.disabled = true;
  statusBox.className = 'ea-status'; statusBox.textContent = ''; statusBox.classList.remove('show');
  flaggedEl.style.display = 'none';

  const result = await send('EASY_APPLY_TAB', { tabId: selectedEntry.tabId });

  btn.innerHTML = '⚡ Easy Apply'; btn.disabled = false;

  if (!result) {
    showEaStatus('err', '✕ No response from Easy Apply engine. Reload the job tab and try again.');
    return;
  }

  if (result.error && !result.needsReview) {
    showEaStatus('err', '✕ ' + result.error);
    return;
  }

  if (result.success) {
    const msg = result.message || 'All fields filled — review and click Submit in the LinkedIn tab.';
    showEaStatus('warn', '⚠ ' + msg);

    // Update status dot
    queue = await send('GET_QUEUE');
    updateStats(); renderTabList();
  } else if (result.needsReview) {
    showEaStatus('warn', '⚠ Stopped at step ' + (result.step || '?') + ': ' + (result.error || 'Needs manual review.'));
  }

  // Show flagged fields that need review
  if (result.flagged?.length) {
    flaggedList.innerHTML = result.flagged.map(f => `
      <div class="flag-item">
        <div class="flag-hint">${esc(f.hint || 'Unknown field')}</div>
        <div class="flag-reason">${esc(f.reason || f.status)}</div>
      </div>`).join('');
    flaggedEl.style.display = 'block';
  }
}

function showEaStatus(type, msg) {
  const el = document.getElementById('ea-status');
  el.className = 'ea-status show ea-' + (type === 'ok' ? 'ok' : type === 'warn' ? 'warn' : 'err');
  el.textContent = msg;
}

function updateStats() {
  document.getElementById('st-tabs').textContent    = tabs.length;
  document.getElementById('st-ready').textContent   = queue.filter(q => q.status === 'ready').length;
  document.getElementById('st-applied').textContent = queue.filter(q => q.status === 'applied').length;
}

async function refreshQueue() {
  queue = await send('GET_QUEUE');
  updateStats();
}

// ── Filter tab ───────────────────────────────────────────────────────────────────

function setupFilterTab() {
  const toggle = document.getElementById('toggle-hide-viewed');
  if (!toggle) return;

  // Load persisted state and reflect in UI
  getStorage(['hideViewedJobs']).then(({ hideViewedJobs = false }) => {
    toggle.checked = hideViewedJobs;
  });

  // Persist on change and notify active LinkedIn tab immediately
  toggle.addEventListener('change', async () => {
    const enabled = toggle.checked;
    await setStorage({ hideViewedJobs: enabled });
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, {
        type: 'FILTER_TOGGLE',
        hideViewedJobs: enabled,
      }).catch(() => {});
    }
    toast(enabled ? 'Viewed jobs will be hidden' : 'Filter disabled');
  });
}

// ── Settings tab ──────────────────────────────────────────────────────────────

async function loadSettings() {
  const { serverUrl = 'http://sentinel-x-delta.vercel.app', minScore = 5, groqKey = '' } =
    await getStorage(['serverUrl', 'minScore', 'groqKey']);
  document.getElementById('s-server').value   = serverUrl;
  document.getElementById('s-minscore').value = minScore;
  const gk = document.getElementById('s-groqkey');
  if (gk) gk.value = groqKey;
}

function setupSettingsTab() {
  document.getElementById('btn-save-settings').addEventListener('click', async () => {
    hideSettingsErr(); hideSettingsInfo();
    const newGroqKey = (document.getElementById('s-groqkey')?.value || '').trim();
    const serverUrl  = document.getElementById('s-server').value.trim() || 'http://sentinel-x-delta.vercel.app';
    const updates = {
      serverUrl,
      minScore:  parseInt(document.getElementById('s-minscore').value) || 5,
      groqKey:   newGroqKey,
    };
    if (!newGroqKey) updates.sentinelToken = '';
    await setStorage(updates);
    const btn = document.getElementById('btn-save-settings');
    btn.innerHTML = '<span class="spin"></span> Saving…'; btn.disabled = true;
    const result = await send('CHECK_SERVER');
    btn.innerHTML = 'Save settings'; btn.disabled = false;
    if (result?.status === 'connected') {
      setBadge('ok');
      setGroqBadge(result.groq_key_valid === true);
      showSettingsInfo(result.groq_key_valid ? 'Settings saved. Your Groq key is active.' : 'Settings saved. Using backend default key.');
    } else {
      setBadge('off');
      showSettingsErr('Server unreachable. Check the URL and try again.');
    }
    toast('Settings saved!');
  });

  document.getElementById('btn-use-default-key').addEventListener('click', async () => {
    document.getElementById('s-groqkey').value = '';
    await send('USE_DEFAULT_KEY');
    await setStorage({ groqKey: '', sentinelToken: '' });
    setGroqBadge(false);
    toast('Cleared — using backend default key');
    hideSettingsErr();
    showSettingsInfo('Now using the backend default Groq key.');
  });
}

function showSettingsErr(msg)  { const e = document.getElementById('settings-err');  if(e){e.textContent=msg;e.classList.add('show');} }
function hideSettingsErr()     { const e = document.getElementById('settings-err');  if(e) e.classList.remove('show'); }
function showSettingsInfo(msg) { const e = document.getElementById('settings-info'); if(e){e.textContent=msg;e.classList.add('show');} }
function hideSettingsInfo()    { const e = document.getElementById('settings-info'); if(e) e.classList.remove('show'); }

// ── Mail tab ──────────────────────────────────────────────────────────────────

function setupMailTab() {
  getStorage(['gmailAddress']).then(({ gmailAddress = '' }) => {
    const gmailEl = document.getElementById('m-gmail');
    if (gmailEl) gmailEl.value = gmailAddress;
  });

  getStorage(['appPassword']).then(({ appPassword = '' }) => {
    const pwEl = document.getElementById('m-app-password');
    if (pwEl) pwEl.value = appPassword;
  });

  document.getElementById('btn-clear-mail').addEventListener('click', () => {
    clearMailForm(); hideToneResult(); hideMailErr(); toast('Mail form cleared');
  });

  const mailFileInput = document.getElementById('mail-file-input');
  const mailFileDrop  = document.getElementById('mail-file-drop');
  mailFileDrop.addEventListener('dragover',  e => { e.preventDefault(); mailFileDrop.classList.add('over'); });
  mailFileDrop.addEventListener('dragleave', () => mailFileDrop.classList.remove('over'));
  mailFileDrop.addEventListener('drop', e => {
    e.preventDefault(); mailFileDrop.classList.remove('over');
    if (e.dataTransfer.files[0]) loadCustomFile(e.dataTransfer.files[0]);
  });
  mailFileInput.addEventListener('change', () => { if (mailFileInput.files[0]) loadCustomFile(mailFileInput.files[0]); });

  document.getElementById('btn-generate-mail').addEventListener('click', async () => {
    const hrName   = document.getElementById('m-hrname').value.trim();
    const hrEmail  = document.getElementById('m-hremail').value.trim();
    const jobTitle = document.getElementById('m-jobtitle').value.trim();
    const company  = document.getElementById('m-company').value.trim();
    const jd       = document.getElementById('m-jd').value.trim();
    const jobId    = document.getElementById('m-jobid').value.trim();
    if (!hrName || !hrEmail || !jobTitle || !company) { showMailErr('Fill in HR name, email, job title and company first.'); return; }
    hideMailErr(); hideToneResult();
    const btn = document.getElementById('btn-generate-mail');
    btn.innerHTML = '<span class="spin"></span>'; btn.disabled = true;
    const result = await send('MAIL_GENERATE', { data: {job_id: jobId, hr_name: hrName, hr_email: hrEmail, job_title: jobTitle, company, job_description: jd } });
    if (result.error) {
      if (result.error.includes('401') || result.error.includes('API key')) {
        showMailErr(result.error + ' Go to Settings to update your key.');
      } else if (result.error.includes('500')) {
        showMailErr(result.error + ' Please retry.');
      } else {
        showMailErr(result.error);
      }
    } else {
      document.getElementById('m-subject').value = result.subject || '';
      document.getElementById('m-body').value    = result.body    || '';
      document.getElementById('btn-tone-check').disabled = false;
      toast('Mail generated!');
    }
    btn.innerHTML = '✦ Generate'; btn.disabled = false;
  });

  document.getElementById('btn-tone-check').addEventListener('click', async () => {
    const subject  = document.getElementById('m-subject').value.trim();
    const body     = document.getElementById('m-body').value.trim();
    const hrName   = document.getElementById('m-hrname').value.trim();
    const jobTitle = document.getElementById('m-jobtitle').value.trim();
    const company  = document.getElementById('m-company').value.trim();
    if (!subject || !body) { showMailErr('Generate the email first before checking tone.'); return; }
    const btn = document.getElementById('btn-tone-check');
    btn.innerHTML = '<span class="spin"></span>'; btn.disabled = true;
    const result = await send('MAIL_TONE_CHECK', { data: { subject, body, hr_name: hrName, job_title: jobTitle, company } });
    btn.innerHTML = '⚑ Check Tone'; btn.disabled = false;
    if (result.error) { showMailErr(result.error); return; }
    renderToneResult(result);
  });

document.getElementById('btn-send-mail').addEventListener('click', async () => {
    const gmail    = document.getElementById('m-gmail').value.trim();
    const appPass  = document.getElementById('m-apppass').value.trim();
    const hrEmail  = document.getElementById('m-hremail').value.trim();
    const hrName   = document.getElementById('m-hrname').value.trim();
    const subject  = document.getElementById('m-subject').value.trim();
    const body     = document.getElementById('m-body').value.trim();
    const jobTitle = document.getElementById('m-jobtitle').value.trim();
    const company  = document.getElementById('m-company').value.trim();
    const attach   = document.getElementById('m-attach').checked;

    if (!gmail)                         { showMailErr('Enter your Gmail address.'); return; }
    if (!hrEmail || !subject || !body)  { showMailErr('HR email, subject and body are required.'); return; }

    const { appPassword: storedEnc = '' } = await getStorage(['appPassword']);
    if (!appPass && !storedEnc)         { showMailErr('Enter your App Password.'); return; }

    hideMailErr();

    let encryptedBlob;
    if (appPass) {
      const encResult = await send('ENCRYPT_APP_PASSWORD', { plaintext: appPass });
      if (encResult?.error) { showMailErr('Encryption failed: ' + encResult.error); return; }
      encryptedBlob = encResult.encrypted;
      await setStorage({ gmailAddress: gmail, appPassword: encryptedBlob });
    } else {
      encryptedBlob = storedEnc;
      await setStorage({ gmailAddress: gmail });
    }

    const btn = document.getElementById('btn-send-mail');
    btn.innerHTML = '<span class="spin"></span> Sending…'; btn.disabled = true;

    const result = await send('MAIL_SEND', { data: {
      gmail_address:    gmail,
      app_password:     encryptedBlob,
      hr_email:         hrEmail,
      hr_name:          hrName,
      subject,
      body,
      job_title:        jobTitle,
      company,
      attach_resume:    attach,
      custom_file_b64:  customFileB64,
      custom_file_name: customFileName
    }});

    if (result?.error) { showMailErr(result.error); }
    else { toast('Email sent to ' + hrEmail + '!'); renderHrLog(); clearMailForm(); }

    btn.innerHTML = '⬆ Send Email'; btn.disabled = false;
  });

  const draftFields = ['m-hrname','m-hremail','m-jobtitle','m-company','m-jd','m-subject','m-body'];
  draftFields.forEach(id => document.getElementById(id).addEventListener('input', saveMailDraft));

  restoreMailTab();
  renderHrLog();
}

async function restoreMailTab() {
  const { mailDraft = null, latestJobData = null } = await getStorage(['mailDraft', 'latestJobData']);
  if (mailDraft) {
    document.getElementById('m-hrname').value   = mailDraft.hrname   || '';
    document.getElementById('m-hremail').value  = mailDraft.hremail  || '';
    // document.getElementById('m-jobtitle').value = mailDraft.jobtitle || '';
    // document.getElementById('m-company').value  = mailDraft.company  || '';
    // document.getElementById('m-jd').value       = mailDraft.jd       || '';
    // document.getElementById('m-subject').value  = mailDraft.subject  || '';
    // document.getElementById('m-body').value     = mailDraft.body     || '';
  }
  if (latestJobData) {
    const setIfEmpty = (id, val) => { const el = document.getElementById(id); if (!el.value && val) el.value = val; };
    setIfEmpty('m-jobtitle', latestJobData.job_title);
    setIfEmpty('m-company',  latestJobData.company);
    setIfEmpty('m-hremail',  latestJobData.email);
    setIfEmpty('m-hrname',   latestJobData.hr_name);
    setIfEmpty('m-jd',       latestJobData.job_description || latestJobData.description || '');
    setIfEmpty('m-jobid',    latestJobData.job_id);
    const subjEl = document.getElementById('m-subject');
    if (!subjEl.value && latestJobData.job_title) {
      subjEl.value = `Application for ${latestJobData.job_title}${latestJobData.company ? ' - ' + latestJobData.company : ''}`;
    }
    await setStorage({ latestJobData: null });
  }
}

async function saveMailDraft() {
  await setStorage({
    mailDraft: {
      hrname:   document.getElementById('m-hrname').value,
      hremail:  document.getElementById('m-hremail').value,
      jobtitle: document.getElementById('m-jobtitle').value,
      company:  document.getElementById('m-company').value,
      jd:       document.getElementById('m-jd').value,
      subject:  document.getElementById('m-subject').value,
      body:     document.getElementById('m-body').value
    }
  });
}

async function loadCustomFile(file) {
  customFileName = file.name;
  customFileB64  = await toBase64(file);
  document.getElementById('custom-file-name').textContent = '📎 ' + file.name;
  toast('Custom file loaded: ' + file.name);
}

function renderToneResult(r) {
  const el    = document.getElementById('tone-result');
  const ok    = r.overall === 'approved';
  const warn  = r.overall === 'needs_revision';
  const color  = ok ? 'rgba(0,230,118,.15)'  : warn ? 'rgba(255,179,0,.12)'  : 'rgba(255,82,82,.1)';
  const bcolor = ok ? 'rgba(0,230,118,.4)'   : warn ? 'rgba(255,179,0,.4)'   : 'rgba(255,82,82,.4)';
  const icon   = ok ? '✓' : warn ? '⚠' : '✕';
  const status = ok ? 'Approved — looks good' : warn ? 'Needs revision' : 'Issues found — do not send yet';
  let html = `<div style="font-weight:500;margin-bottom:5px;color:${ok ? 'var(--green)' : warn ? 'var(--amber)' : 'var(--red)'}">${icon} ${status}</div>`;
  if (r.issues?.length)      html += `<div style="color:var(--muted);margin-bottom:3px">Issues: ${r.issues.join('; ')}</div>`;
  if (r.suggestions?.length) html += `<div style="color:var(--muted)">Fix: ${r.suggestions.join('; ')}</div>`;
  if (r.has_abuse)           html += `<div style="color:var(--red);margin-top:4px">⚠ Abusive language detected — please remove before sending.</div>`;
  el.style.background  = color;
  el.style.borderColor = bcolor;
  el.style.color       = 'var(--text)';
  el.style.display     = 'block';
  el.innerHTML         = html;
}

function hideToneResult() { document.getElementById('tone-result').style.display = 'none'; }

async function renderHrLog() {
  const log = await send('HR_LOG_GET');
  const el  = document.getElementById('hr-log-list');
  if (!log?.length) { el.innerHTML = '<div style="font-size:11px;color:var(--muted)">No emails sent yet</div>'; return; }
  el.innerHTML = log.slice(0, 5).map(h => `
    <div class="hritem">
      <div class="hritem-top">
        <span class="hritem-name">${esc(h.hr_name)} &lt;${esc(h.hr_email)}&gt;</span>
        <span class="hritem-date">${h.sent_at ? h.sent_at.slice(0, 10) : ''}</span>
      </div>
      <div class="hritem-meta">${esc(h.job_title)} @ ${esc(h.company)}</div>
    </div>`).join('');
}

function clearMailForm() {
  ['m-hrname','m-hremail','m-jobtitle','m-company','m-subject','m-body'].forEach(id => {
    document.getElementById(id).value = '';
  });
  customFileB64  = '';
  customFileName = '';
  const fn = document.getElementById('custom-file-name');
  if (fn) fn.textContent = '';
  setStorage({ mailDraft: {} });
}

function showMailErr(msg) { const e = document.getElementById('mail-err'); e.textContent = msg; e.classList.add('show'); }
function hideMailErr()    { document.getElementById('mail-err').classList.remove('show'); }

// ── Chat tab ──────────────────────────────────────────────────────────────────

function setupChatTab() {
  document.getElementById('btn-chat-send').addEventListener('click', doChat);
  document.getElementById('chat-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doChat(); }
  });
  document.getElementById('btn-chat-clear').addEventListener('click', async () => {
    await send('CHAT_CLEAR');
    document.getElementById('chat-messages').innerHTML = '';
    toast('Chat cleared');
  });
  loadChatHistory();
}

async function loadChatHistory() {
  const wrap = document.getElementById('chat-messages');
  wrap.innerHTML = '';
  const result  = await send('CHAT_HISTORY');
  const history = result?.history || [];
  if (history.length === 0) {
    appendChatMsg('bot', "Hi! I know your open job tabs, applications, and HR contacts. Ask me anything about your job search.");
  } else {
    history.forEach(m => appendChatMsg(m.role === 'assistant' ? 'bot' : 'user', m.content));
  }
}

async function doChat() {
  const input = document.getElementById('chat-input');
  const msg   = input.value.trim();
  if (!msg) return;
  input.value = '';
  appendChatMsg('user', msg);
  const thinking = appendChatMsg('bot', 'Thinking…', true);
  const result   = await send('CHAT_SEND', { data: { message: msg } });
  thinking.remove();
  if (result.error) appendChatMsg('bot', '⚠ ' + result.error);
  else appendChatMsg('bot', result.reply);
}

function appendChatMsg(role, text, isThinking = false) {
  const wrap = document.getElementById('chat-messages');
  const el   = document.createElement('div');
  el.className = 'cmsg cmsg-' + role + (isThinking ? ' thinking' : '');
  el.textContent = text;
  wrap.appendChild(el);
  wrap.scrollTop = wrap.scrollHeight;
  return el;
}

// ── Shared helpers ────────────────────────────────────────────────────────────

// ── Dump tab ──────────────────────────────────────────────────────────────────
// Manages the persistent EasyApply Q&A cache (dump.json equivalent in storage).
// Lets the user view learned answers, configure visa/location policy, export
// the dump as dump.json, and reset non-user entries.

function setupDumpTab() {
  loadDump();

  document.getElementById('btn-dump-refresh').addEventListener('click', loadDump);

  document.getElementById('btn-dump-save-policy').addEventListener('click', async () => {
    const h1b      = document.getElementById('dump-h1b').checked;
    const openUs   = document.getElementById('dump-open-us').checked;
    const locRaw   = document.getElementById('dump-locations').value.trim();
    const locations = locRaw ? locRaw.split(',').map(s => s.trim()).filter(Boolean) : [];

    const policy = {
      home_country:                    'India',
      requires_h1b_sponsorship:        h1b,
      open_to_us_roles:                openUs,
      open_to_non_india_roles:         openUs,
      sponsorship_answer_outside_india: h1b ? 'Yes' : 'No',
      sponsorship_answer_inside_india:  'No',
    };

    await send('EA_DUMP_SAVE', {
      dump: { entries: {}, visa_policy: policy, location_preferences: locations },
    });
    toast('Policy saved ✓');
    loadDump();
  });

  document.getElementById('btn-dump-export').addEventListener('click', async () => {
    const { dump } = await send('EA_DUMP_GET');
    if (!dump) { toast('No dump data yet', true); return; }
    const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'dump.json';
    a.click();
    URL.revokeObjectURL(url);
    toast('Exported dump.json');
  });

  document.getElementById('btn-dump-reset').addEventListener('click', async () => {
    if (!confirm('Reset all learned (non-user) answers? Visa policy and user entries are kept.')) return;
    const r = await send('EA_DUMP_RESET');
    toast(`Reset: ${r.cleared || 0} entries removed, ${r.kept || 0} user entries kept`);
    loadDump();
  });
}

async function loadDump() {
  const { dump } = await send('EA_DUMP_GET');

  // Stats
  const entries = dump?.entries || {};
  const allEntries = Object.values(entries);
  document.getElementById('dump-count').textContent = allEntries.length;
  document.getElementById('dump-hits').textContent  =
    allEntries.reduce((n, e) => n + (e.use_count || 0), 0);

  // Policy checkboxes
  const p = dump?.visa_policy || {};
  document.getElementById('dump-h1b').checked    = !!p.requires_h1b_sponsorship;
  document.getElementById('dump-open-us').checked = p.open_to_non_india_roles !== false;
  document.getElementById('dump-locations').value =
    (dump?.location_preferences || []).join(', ');

  // Table
  const tableEl = document.getElementById('dump-table');
  if (!allEntries.length) {
    tableEl.innerHTML = '<div style="color:var(--muted);padding:8px 0">No learned answers yet. Run Easy Apply on a job to start building the cache.</div>';
    return;
  }

  // Sort by use_count desc, then by learned_at desc
  const sorted = allEntries.sort((a, b) =>
    (b.use_count || 0) - (a.use_count || 0) || (b.learned_at || '').localeCompare(a.learned_at || '')
  );

  const srcBadge = { heuristic: '🔵', model: '🟡', user: '🟢' };

  tableEl.innerHTML = `
    <table style="width:100%;border-collapse:collapse">
      <thead>
        <tr style="text-align:left;border-bottom:1px solid var(--border);font-size:10px;color:var(--muted)">
          <th style="padding:3px 4px;width:40%">Question</th>
          <th style="padding:3px 4px;width:30%">Answer</th>
          <th style="padding:3px 4px;width:10%">Src</th>
          <th style="padding:3px 4px;width:10%">Hits</th>
          <th style="padding:3px 4px;width:10%">Del</th>
        </tr>
      </thead>
      <tbody>
        ${sorted.map((e, i) => `
          <tr style="border-bottom:1px solid var(--border)20;${i % 2 === 0 ? '' : 'background:var(--bg2,#f7f7f7)08'}">
            <td style="padding:3px 4px;word-break:break-word">${esc(e.hint || '').slice(0, 60)}</td>
            <td style="padding:3px 4px;word-break:break-word;font-weight:600">${esc(String(e.value || '')).slice(0, 40)}</td>
            <td style="padding:3px 4px;text-align:center">${srcBadge[e.source] || '⚪'}</td>
            <td style="padding:3px 4px;text-align:center">${e.use_count || 0}</td>
            <td style="padding:3px 4px;text-align:center">
              <button data-key="${esc(Object.keys(entries)[Object.values(entries).indexOf(e)] || '')}"
                style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:12px"
                class="btn-dump-del">✕</button>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>
    <div style="margin-top:4px;font-size:10px;color:var(--muted)">
      🟢 user-provided &nbsp; 🔵 heuristic &nbsp; 🟡 model
    </div>`;

  // Wire up per-row delete buttons
  tableEl.querySelectorAll('.btn-dump-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      const key = btn.dataset.key;
      if (!key) return;
      const { dump: d } = await send('EA_DUMP_GET');
      if (d?.entries?.[key]) {
        delete d.entries[key];
        await send('EA_DUMP_SAVE', { dump: d });
        toast('Entry deleted');
        loadDump();
      }
    });
  });
}

function send(type, data = {})  { return chrome.runtime.sendMessage({ type, ...data }); }
function getStorage(keys)       { return new Promise(r => chrome.storage.local.get(keys, r)); }
function setStorage(obj)        { return new Promise(r => chrome.storage.local.set(obj, r)); }
function esc(s)                 { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function toBase64(file)         { return new Promise((res,rej) => { const r = new FileReader(); r.onload = () => res(r.result.split(',')[1]); r.onerror = () => rej(new Error('Read failed')); r.readAsDataURL(file); }); }
function sleep(ms)              { return new Promise(r => setTimeout(r, ms)); }
function timeAgo(ts)            { const d = (Date.now()-ts)/1000; if(d<60) return 'just now'; if(d<3600) return Math.floor(d/60)+'m ago'; if(d<86400) return Math.floor(d/3600)+'h ago'; return Math.floor(d/86400)+'d ago'; }
function setProgress(label,pct) { document.getElementById('prog').classList.add('show'); document.getElementById('prog-step').textContent=label; document.getElementById('prog-pct').textContent=pct+'%'; document.getElementById('prog-fill').style.width=pct+'%'; }
function hideProgress()         { document.getElementById('prog').classList.remove('show'); }
function showResumeErr(msg)     { const e = document.getElementById('resume-err'); e.textContent=msg; e.classList.add('show'); }
function hideResumeErr()        { document.getElementById('resume-err').classList.remove('show'); }
let _tt;
function toast(msg, isErr=false) { const e=document.getElementById('toast'); e.textContent=msg; e.style.borderColor=isErr?'var(--red)':'var(--border)'; e.classList.add('show'); clearTimeout(_tt); _tt=setTimeout(()=>e.classList.remove('show'),2600); }