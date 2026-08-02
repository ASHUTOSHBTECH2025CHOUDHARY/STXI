// sentinelX.js
// Generates a unique permanent user identity (sentinelX) on first install.
// Guards it — if storage is cleared, regenerates and re-registers with server.

const SENTINEL_KEY = '__sentinelX__';
const BASE_SERVER = 'http://sentinel-x-delta.vercel.app';

let SENTINEL_SERVER = BASE_SERVER;

async function loadServer() {
  const { serverUrl } = await chrome.storage.local.get('serverUrl');
  SENTINEL_SERVER = serverUrl || BASE_SERVER;
}

loadServer();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.serverUrl) {
    SENTINEL_SERVER = changes.serverUrl.newValue || BASE_SERVER;
  }
});

// ── Public API ────────────────────────────────────────────────────────────────

async function initSentinel() {
  let sentinelX = await loadSentinel();

  if (!sentinelX) {
    sentinelX = await generateSentinelX();
    await saveSentinel(sentinelX);
    await registerWithServer(sentinelX);
  } else {
    const valid = await verifyWithServer(sentinelX);
    if (!valid) {
      await registerWithServer(sentinelX);
    }
  }

  return sentinelX;
}

async function getSentinel() {
  let sentinelX = await loadSentinel();
  if (!sentinelX) {
    sentinelX = await generateSentinelX();
    await saveSentinel(sentinelX);
    await registerWithServer(sentinelX);
  }
  return sentinelX;
}

// ── Generation ────────────────────────────────────────────────────────────────

async function generateSentinelX() {
  const extensionId = chrome.runtime.id;
  const timestamp   = Date.now().toString();
  const randomBytes = crypto.getRandomValues(new Uint8Array(32));
  const randomHex   = Array.from(randomBytes).map(b => b.toString(16).padStart(2, '0')).join('');
  const browserInfo = navigator.userAgent + navigator.language;
  const raw  = `${extensionId}::${timestamp}::${randomHex}::${browserInfo}`;
  const hash = await sha256(raw);
  return `sntnl_${hash}`;
}

// ── Storage ───────────────────────────────────────────────────────────────────

async function loadSentinel() {
  return new Promise(resolve => {
    chrome.storage.local.get(SENTINEL_KEY, result => {
      resolve(result[SENTINEL_KEY] || null);
    });
  });
}

async function saveSentinel(sentinelX) {
  return new Promise(resolve => {
    chrome.storage.local.set({ [SENTINEL_KEY]: sentinelX }, resolve);
  });
}

// ── Server registration ───────────────────────────────────────────────────────

async function registerWithServer(sentinelX) {
  try {
    const base = (SENTINEL_SERVER || BASE_SERVER).replace(/\/$/, '');
    await fetch(`${base}/identity/register`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ sentinel_x: sentinelX })
    });
  } catch (e) {
    console.warn('[Sentinel] Could not register with server:', e.message);
  }
}

async function verifyWithServer(sentinelX) {
  try {
    const base = (SENTINEL_SERVER || BASE_SERVER).replace(/\/$/, '');
    const res  = await fetch(`${base}/identity/verify`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ sentinel_x: sentinelX })
    });
    const data = await res.json();
    return data.valid === true;
  } catch {
    return true; // assume valid if server unreachable
  }
}

// ── Crypto helper ─────────────────────────────────────────────────────────────

async function sha256(message) {
  const encoded = new TextEncoder().encode(message);
  const hashBuf = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(hashBuf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
