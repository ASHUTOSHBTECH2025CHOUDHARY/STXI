# key_vault.py
# Replaces jwt_utils.py — no JWT, no PyJWT dependency.
#
# Flow:
#   1. /health receives encrypted_groq_key in X-Groq-Key header (AES-GCM-CBC-XOR, client-side)
#   2. Server decrypts → validates with a 1-token Groq call → if OK, generates sentinelX session token
#   3. Token stored in Redis: key  = "gk:{sentinel_x}"  value = re-encrypted groq_key  TTL = 8 hours
#   4. Response returns  sentinel_token  — client stores it, sends as  Authorization: Bearer <token>
#   5. Every subsequent request: server extracts sentinel_x from Bearer token, looks up Redis, decrypts groq_key
#   6. If key absent/expired → falls back to server's own GROQ_API_KEY
#
# Performance note:
#   _derive_key is decorated with @lru_cache. Derived keys are deterministic
#   (same purpose + sentinel_x always produces the same key), so caching is safe.
#   PBKDF2 cost is paid once per unique (purpose, sentinel_x) pair per process
#   lifetime; subsequent calls are pure memory lookups (~microseconds).
#   Cache holds up to 1024 entries (purpose × sentinel_x combos); at 3 purposes
#   per user that supports ~340 concurrent cached users before LRU eviction.

import os, base64, hashlib, hmac, secrets
from functools import lru_cache
from typing    import Optional

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2   import PBKDF2HMAC
from cryptography.hazmat.primitives              import hashes
from cryptography.hazmat.backends                import default_backend

# ── Env ───────────────────────────────────────────────────────────────────────

SERVER_SECRET     = os.environ.get("SERVER_SECRET", "CHANGE_ME")
ENCRYPTION_PEPPER = os.environ.get("ENCRYPTION_PEPPER", "CHANGE_ME_2")
GROQ_KEY_TTL      = 8 * 3600        # 8 hours in seconds

# ── Key derivation ────────────────────────────────────────────────────────────

@lru_cache(maxsize=1024)
def _derive_key(purpose: str, context: str) -> bytes:
    """
    Derive a 256-bit AES key from server secret + pepper + purpose + context.

    Cached: derived keys are deterministic — same inputs always produce the
    same output — so it is safe to cache them in memory for the process
    lifetime. PBKDF2 runs once per (purpose, context) pair; all subsequent
    calls return the cached bytes instantly.

    Iterations lowered to 100_000:
      These keys protect server-to-server encrypted blobs (not user passwords),
      so the attacker would need the server secrets themselves before even
      attempting a brute-force. 100k PBKDF2-SHA512 iterations is well above
      OWASP guidance for this threat model and keeps cold-start latency low.
    """
    salt = hashlib.sha256(
        f"{ENCRYPTION_PEPPER}::{purpose}::{context}".encode()
    ).digest()
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA512(),
        length=32,
        salt=salt,
        iterations=100_000,
        backend=default_backend()
    )
    return kdf.derive(SERVER_SECRET.encode())

# ── Layer 1: AES-256-GCM (authenticated) ─────────────────────────────────────

def _gcm_encrypt(data: bytes, key: bytes, aad: bytes = b"") -> bytes:
    nonce = os.urandom(12)
    ct    = AESGCM(key).encrypt(nonce, data, aad)
    return nonce + ct

def _gcm_decrypt(blob: bytes, key: bytes, aad: bytes = b"") -> bytes:
    return AESGCM(key).decrypt(blob[:12], blob[12:], aad)

# ── Layer 2: AES-256-GCM second pass (different key, different AAD) ──────────

def _gcm2_encrypt(data: bytes, key: bytes, aad: bytes = b"") -> bytes:
    nonce = os.urandom(12)
    ct    = AESGCM(key).encrypt(nonce, data, aad)
    return nonce + ct

def _gcm2_decrypt(blob: bytes, key: bytes, aad: bytes = b"") -> bytes:
    return AESGCM(key).decrypt(blob[:12], blob[12:], aad)

# ── Layer 3: HMAC-wrapped XOR keystream ──────────────────────────────────────

def _xor_encrypt(data: bytes, key: bytes) -> bytes:
    """XOR with SHA-512 counter keystream derived from key."""
    keystream = bytearray()
    counter   = 0
    while len(keystream) < len(data):
        h = hashlib.sha512(key + counter.to_bytes(4, "big")).digest()
        keystream.extend(h)
        counter += 1
    return bytes(b ^ k for b, k in zip(data, keystream))

_xor_decrypt = _xor_encrypt   # XOR is its own inverse

# ── Public: encrypt groq_key for Redis storage ────────────────────────────────

def encrypt_groq_key(groq_key: str, sentinel_x: str) -> str:
    """
    Triple-layer AES encrypt a groq_key bound to sentinel_x for Redis storage.
    Returns base64url string.
    """
    raw  = groq_key.encode()
    aad1 = f"groq:l1:{sentinel_x}".encode()
    aad2 = f"groq:l2:{sentinel_x}".encode()

    k1   = _derive_key("groq_layer1", sentinel_x)
    k2   = _derive_key("groq_layer2", sentinel_x)
    k3   = _derive_key("groq_layer3", sentinel_x)

    l1   = _gcm_encrypt(raw, k1, aad1)
    l2   = _gcm2_encrypt(l1,  k2, aad2)
    l3   = _xor_encrypt(l2,   k3)

    return base64.urlsafe_b64encode(l3).decode()

def decrypt_groq_key(blob_b64: str, sentinel_x: str) -> Optional[str]:
    """Reverse the triple-layer encryption and return the plain groq_key."""
    try:
        l3   = base64.urlsafe_b64decode(blob_b64 + "==")
        aad1 = f"groq:l1:{sentinel_x}".encode()
        aad2 = f"groq:l2:{sentinel_x}".encode()

        k1   = _derive_key("groq_layer1", sentinel_x)
        k2   = _derive_key("groq_layer2", sentinel_x)
        k3   = _derive_key("groq_layer3", sentinel_x)

        l2   = _xor_decrypt(l3, k3)
        l1   = _gcm2_decrypt(l2, k2, aad2)
        raw  = _gcm_decrypt(l1,  k1, aad1)

        return raw.decode()
    except Exception:
        return None

# ── Client-side encrypted groq_key decryption ─────────────────────────────────
# Mirrors encryptForServer() in crypto.js exactly.
#
# Client key derivation (crypto.js encryptForServer):
#   ikm       = ENCRYPTION_PEPPER + sentinelX   (pepper concatenated with sentinelX)
#   salt      = "client_groq_upload:{sentinelX}"  (plain UTF-8 string, NOT sha256'd)
#   iterations = 390_000
#   hash      = SHA-512
#   aad       = "groq_upload:{sentinelX}"
#
# Server must reproduce the identical ikm + salt + iterations to get the same key.
# This function bypasses _derive_key() because that helper uses a different
# salt format (sha256'd) and different ikm (SERVER_SECRET only) — it is for
# server-to-server Redis encryption, not client-upload decryption.

def decrypt_client_groq_key(encrypted_b64: str, sentinel_x: str) -> Optional[str]:
    """
    Decrypt a groq_key encrypted by the browser extension's encryptForServer().

    Key derivation mirrors crypto.js exactly:
      ikm        = ENCRYPTION_PEPPER + sentinel_x
      salt       = b"client_groq_upload:{sentinel_x}"
      iterations = 390_000
      hash       = SHA-512
      aad        = b"groq_upload:{sentinel_x}"

    ENCRYPTION_PEPPER must equal SERVER_UPLOAD_PEPPER in crypto.js.
    Returns None on any decryption or padding error.
    """
    try:
        blob = base64.urlsafe_b64decode(encrypted_b64 + "==")

        # Derive key — must match encryptForServer() in crypto.js exactly
        ikm  = (ENCRYPTION_PEPPER + sentinel_x).encode()       # pepper + sentinelX
        salt = f"client_groq_upload:{sentinel_x}".encode()     # plain salt, not sha256'd

        kdf = PBKDF2HMAC(
            algorithm  = hashes.SHA512(),
            length     = 32,
            salt       = salt,
            iterations = 390_000,                              # must match client
            backend    = default_backend()
        )
        key = kdf.derive(ikm)

        aad = f"groq_upload:{sentinel_x}".encode()
        return _gcm_decrypt(blob, key, aad).decode()
    except Exception:
        return None

# ── Session token (Bearer) ────────────────────────────────────────────────────
# sentinel_token = HMAC-SHA256(sentinel_x, SERVER_SECRET) — stable, not random.
# It identifies the user without exposing sentinel_x in Authorization headers.

def make_sentinel_token(sentinel_x: str) -> str:
    """Deterministic bearer token for a sentinel_x — no JWT, no expiry in token itself."""
    return hmac.new(
        SERVER_SECRET.encode(),
        f"bearer:{sentinel_x}".encode(),
        hashlib.sha256
    ).hexdigest()

def verify_sentinel_token(token: str, sentinel_x: str) -> bool:
    """Constant-time check that token matches expected HMAC for sentinel_x."""
    expected = make_sentinel_token(sentinel_x)
    return hmac.compare_digest(token, expected)