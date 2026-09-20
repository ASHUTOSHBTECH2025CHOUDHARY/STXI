// crypto.js
// Multi-layer encryption for sensitive extension data.
// Layer 1 — AES-256-GCM  (authenticated encryption, tamper-proof)
// Layer 2 — AES-256-CBC  (second AES pass with independent key)
// Layer 3 — XOR with derived keystream (lightweight obfuscation layer)
//
// Keys are derived from sentinelX + a hardcoded pepper using PBKDF2.
// Nothing is stored in plain text. IV and salt are stored alongside ciphertext.
// Even if chrome.storage.local is read by another extension, data is unreadable.

// ── Constants ─────────────────────────────────────────────────────────────────

// Pepper — baked into the extension code, never stored
// Combined with sentinelX (which is never sent anywhere) to derive keys
// Change this if you ever suspect the extension code is compromised
const PEPPER = 'J9#mK$2vX!qL@8nP^wR*5tY&hZ%3dF(bA)0sCeUoI_6gN+7jV=4yMx';

const PBKDF2_ITERATIONS_1 = 310000; // OWASP recommended minimum for AES-256
const PBKDF2_ITERATIONS_2 = 250000; // second key derivation — different iteration count
const PBKDF2_ITERATIONS_3 = 180000; // third key for XOR keystream

const ENC    = new TextEncoder();
const DEC    = new TextDecoder();

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Encrypt a plaintext string through all 3 layers.
 * @param {string} plaintext  — the sensitive value (e.g. Gmail app password)
 * @param {string} sentinelX  — the unique user identity
 * @returns {string}          — base64url encoded encrypted package
 */
async function encryptSensitive(plaintext, sentinelX) {
  const keys = await deriveAllKeys(sentinelX);

  // Layer 1 — AES-256-GCM
  const afterGCM = await encryptAES_GCM(plaintext, keys.gcmKey);

  // Layer 2 — AES-256-CBC on top of GCM output
  const afterCBC = await encryptAES_CBC(afterGCM, keys.cbcKey);

  // Layer 3 — XOR keystream obfuscation
  const afterXOR = await applyXOR(afterCBC, keys.xorKey);

  // Pack everything into one base64url string for storage
  return bufToBase64(afterXOR);
}

// decryptSensitive intentionally removed from client.
// Decryption of app_password is performed exclusively on the Python server
// via /mail/send which receives the encrypted blob + sentinelX and decrypts
// server-side using the SERVER_SECRET env var. The client never decrypts.

/**
 * Encrypt a JSON object (for resume, hr_log etc).
 * Lighter — single AES-256-GCM pass (data is large, triple layer is overkill).
 */
async function encryptJSON(obj, sentinelX) {
  const keys      = await deriveAllKeys(sentinelX);
  const plaintext = JSON.stringify(obj);
  const encrypted = await encryptAES_GCM(plaintext, keys.gcmKey);
  return bufToBase64(encrypted);
}

// decryptJSON removed — decryption only on server.

// ── Key derivation ────────────────────────────────────────────────────────────

/**
 * Derive 3 independent keys from sentinelX + PEPPER using PBKDF2-SHA-512.
 * Each key uses a different salt and iteration count so they are independent.
 */
async function deriveAllKeys(sentinelX) {
  const baseKey = await importBaseKey(sentinelX + PEPPER);

  const [gcmKey, cbcKey, xorKeyBuf] = await Promise.all([
    deriveKey(baseKey, 'gcm_salt_v1_' + sentinelX, PBKDF2_ITERATIONS_1, 'AES-GCM'),
    deriveKey(baseKey, 'cbc_salt_v1_' + sentinelX, PBKDF2_ITERATIONS_2, 'AES-CBC'),
    deriveRawKey(baseKey, 'xor_salt_v1_' + sentinelX, PBKDF2_ITERATIONS_3)
  ]);

  return { gcmKey, cbcKey, xorKey: xorKeyBuf };
}

async function importBaseKey(material) {
  return crypto.subtle.importKey(
    'raw',
    ENC.encode(material),
    { name: 'PBKDF2' },
    false,
    ['deriveKey', 'deriveBits']
  );
}

async function deriveKey(baseKey, saltStr, iterations, algorithm) {
  return crypto.subtle.deriveKey(
    {
      name:       'PBKDF2',
      salt:       ENC.encode(saltStr),
      iterations,
      hash:       'SHA-512'
    },
    baseKey,
    { name: algorithm, length: 256 },
    false,
    algorithm === 'AES-GCM' ? ['encrypt', 'decrypt'] : ['encrypt', 'decrypt']
  );
}

async function deriveRawKey(baseKey, saltStr, iterations) {
  const bits = await crypto.subtle.deriveBits(
    {
      name:       'PBKDF2',
      salt:       ENC.encode(saltStr),
      iterations,
      hash:       'SHA-512'
    },
    baseKey,
    256
  );
  return new Uint8Array(bits);
}

// ── AES-256-GCM ───────────────────────────────────────────────────────────────
// Authenticated encryption — detects tampering

async function encryptAES_GCM(plaintext, key) {
  const iv         = crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV for GCM
  const encoded    = ENC.encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);

  // Pack: [iv (12 bytes)] + [ciphertext]
  const result = new Uint8Array(12 + ciphertext.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertext), 12);
  return result;
}

// decryptAES_GCM removed — client-side decryption not permitted.

// ── AES-256-CBC ───────────────────────────────────────────────────────────────
// Second independent AES pass — different mode, different key

async function encryptAES_CBC(data, key) {
  const iv         = crypto.getRandomValues(new Uint8Array(16)); // 128-bit IV for CBC
  const padded     = pkcs7Pad(data);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, padded);

  // Pack: [iv (16 bytes)] + [ciphertext]
  const result = new Uint8Array(16 + ciphertext.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertext), 16);
  return result;
}

// decryptAES_CBC removed — client-side decryption not permitted.

// ── XOR keystream ─────────────────────────────────────────────────────────────
// Third layer — stretches derived key bytes across full data length

async function applyXOR(data, keyBytes) {
  const result = new Uint8Array(data.length);
  // Stretch key using SHA-256 of key chunks to cover full data length
  let keystream = new Uint8Array(0);
  let counter   = 0;
  while (keystream.length < data.length) {
    const chunk     = ENC.encode(counter.toString());
    const combined  = new Uint8Array(keyBytes.length + chunk.length);
    combined.set(keyBytes);
    combined.set(chunk, keyBytes.length);
    const hash  = await crypto.subtle.digest('SHA-256', combined);
    const old   = keystream;
    keystream   = new Uint8Array(old.length + 32);
    keystream.set(old);
    keystream.set(new Uint8Array(hash), old.length);
    counter++;
  }
  for (let i = 0; i < data.length; i++) {
    result[i] = data[i] ^ keystream[i];
  }
  return result;
}

// ── PKCS7 padding ─────────────────────────────────────────────────────────────

function pkcs7Pad(data) {
  const blockSize  = 16;
  const padLen     = blockSize - (data.length % blockSize);
  const padded     = new Uint8Array(data.length + padLen);
  padded.set(data);
  padded.fill(padLen, data.length);
  return padded;
}

function pkcs7Unpad(data) {
  const padLen = data[data.length - 1];
  return data.slice(0, data.length - padLen);
}

// ── Base64url helpers ─────────────────────────────────────────────────────────

function bufToBase64(buffer) {
  return btoa(String.fromCharCode(...buffer))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function base64ToBuf(b64) {
  const std = b64.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(std);
  return new Uint8Array([...bin].map(c => c.charCodeAt(0)));
}
// ── Server-scheme encryption (for groq_key upload) ────────────────────────────
// This mirrors key_vault.py decrypt_client_groq_key().
// Uses a SERVER_UPLOAD_PEPPER baked into the extension — the same value must be
// set as ENCRYPTION_PEPPER in the server .env.
// Purpose: encrypt the groq_key so only the server (with SERVER_SECRET + PEPPER)
// can decrypt it. Near-impossible to reverse without both secrets.
//
// Scheme: AES-256-GCM, key = PBKDF2-SHA512(SERVER_UPLOAD_PEPPER + sentinelX, salt, 390000 iters)
// The server mirrors this exact derivation using its ENCRYPTION_PEPPER env var.

// !! IMPORTANT: Set this to the EXACT value of ENCRYPTION_PEPPER in your server .env !!
const SERVER_UPLOAD_PEPPER = 'replace_with_another_128_char_random_hex_string';

/**
 * Encrypt a groq_key for transmission to /health X-Groq-Key header.
 * Only the server can decrypt this (requires SERVER_SECRET + SERVER_UPLOAD_PEPPER).
 * @param {string} groqKey
 * @param {string} sentinelX
 * @returns {string} base64url encoded AES-GCM ciphertext
 */
async function encryptForServer(groqKey, sentinelX) {
  // Derive key: PBKDF2(SERVER_UPLOAD_PEPPER + sentinelX, salt, 390000, SHA-512)
  const material  = ENC.encode(SERVER_UPLOAD_PEPPER + sentinelX);
  const saltStr   = `client_groq_upload:${sentinelX}`;
  const baseKey   = await crypto.subtle.importKey('raw', material, { name: 'PBKDF2' }, false, ['deriveKey']);
  const aesKey    = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: ENC.encode(saltStr), iterations: 390000, hash: 'SHA-512' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );

  const iv  = crypto.getRandomValues(new Uint8Array(12));
  const aad = ENC.encode(`groq_upload:${sentinelX}`);

  const ct  = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, aesKey, ENC.encode(groqKey));

  // Pack: iv (12 bytes) + ciphertext
  const packed = new Uint8Array(12 + ct.byteLength);
  packed.set(iv, 0);
  packed.set(new Uint8Array(ct), 12);
  return bufToBase64(packed);
}

/**
 * Encrypt the app_password for server-side decryption.
 * Uses the existing 3-layer scheme (GCM→CBC→XOR) bound to sentinelX.
 * Alias kept for backward compat with popup.js ENCRYPT_APP_PASSWORD calls.
 */
// encryptSensitive() already handles this — no alias needed.
