# crypto_utils.py
# Multi-layer AES-256-GCM encryption for the client Groq API key.
#
# Flow (replaces JWT approach):
#   1. /health receives sentinel_x + groq_key (query param, HTTPS only, one time)
#   2. Server validates the key (test Groq call)
#   3. Key is triple-AES-GCM encrypted with three independently derived keys
#   4. Encrypted blob stored in Redis under groq:<sentinel_x> with 8-hour TTL
#   5. Client sends  Authorization: Bearer <sentinel_x>  on every request
#   6. Server reads bearer, fetches blob from Redis, decrypts → groq_key
#   7. If Redis entry absent/expired → fall back to server's default GROQ_API_KEY
#
# Why 3 layers?
#   Each layer uses a key derived from a different combination of secrets +
#   sentinel_x, so compromising one secret does not expose the plaintext.
#
# Layer derivation:
#   L1 key = PBKDF2-SHA512( SERVER_SECRET,    salt=sha256("L1" + PEPPER + sentinel_x) )
#   L2 key = PBKDF2-SHA512( ENCRYPTION_PEPPER, salt=sha256("L2" + SECRET + sentinel_x) )
#   L3 key = PBKDF2-SHA512( SECRET + PEPPER,   salt=sha256("L3" + sentinel_x) )
#
# Encryption order:  plaintext → L3(·) → L2(·) → L1(·) = ciphertext stored in Redis
# Decryption order:  ciphertext → L1⁻¹(·) → L2⁻¹(·) → L3⁻¹(·) = plaintext
#
# Each layer prepends its own random 12-byte nonce; total overhead ≈ 36 + GCM tags.

import os, base64, hashlib
from typing import Optional

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2   import PBKDF2HMAC
from cryptography.hazmat.primitives              import hashes
from cryptography.hazmat.backends                import default_backend

from dotenv import load_dotenv
load_dotenv()

# ── Secrets ───────────────────────────────────────────────────────────────────

_SERVER_SECRET     = os.environ.get("SERVER_SECRET",     "CHANGE_ME_SERVER_SECRET")
_ENCRYPTION_PEPPER = os.environ.get("ENCRYPTION_PEPPER", "CHANGE_ME_PEPPER")

GROQ_KEY_TTL = 60 * 60 * 8   # 8 hours in seconds

# ── Internal key derivation ───────────────────────────────────────────────────

def _derive_key(ikm: str, salt_data: str) -> bytes:
    """Derive a 256-bit AES key via PBKDF2-SHA512."""
    salt = hashlib.sha256(salt_data.encode()).digest()
    kdf  = PBKDF2HMAC(
        algorithm  = hashes.SHA512(),
        length     = 32,
        salt       = salt,
        iterations = 100_000,          # lower than resume keys — called on every request
        backend    = default_backend()
    )
    return kdf.derive(ikm.encode())


def _layer_keys(sentinel_x: str) -> tuple[bytes, bytes, bytes]:
    """Return (L1_key, L2_key, L3_key) for the given sentinel_x."""
    l1 = _derive_key(
        _SERVER_SECRET,
        f"L1::{_ENCRYPTION_PEPPER}::{sentinel_x}"
    )
    l2 = _derive_key(
        _ENCRYPTION_PEPPER,
        f"L2::{_SERVER_SECRET}::{sentinel_x}"
    )
    l3 = _derive_key(
        _SERVER_SECRET + _ENCRYPTION_PEPPER,
        f"L3::{sentinel_x}"
    )
    return l1, l2, l3


def _aes_encrypt(key: bytes, plaintext: bytes, aad: bytes) -> bytes:
    """Single AES-256-GCM encrypt; returns nonce‖ciphertext."""
    nonce = os.urandom(12)
    ct    = AESGCM(key).encrypt(nonce, plaintext, aad)
    return nonce + ct


def _aes_decrypt(key: bytes, blob: bytes, aad: bytes) -> bytes:
    """Single AES-256-GCM decrypt; expects nonce‖ciphertext input."""
    nonce = blob[:12]
    ct    = blob[12:]
    return AESGCM(key).decrypt(nonce, ct, aad)


# ── Public API ─────────────────────────────────────────────────────────────────

def encrypt_groq_key(groq_key: str, sentinel_x: str) -> str:
    """
    Triple-AES-GCM encrypt a Groq API key.
    Returns a base64-encoded blob safe for Redis storage.
    Encryption order: L3 → L2 → L1  (outermost = L1)
    """
    aad  = sentinel_x.encode()          # authenticated context — binds blob to user
    l1, l2, l3 = _layer_keys(sentinel_x)

    step1 = _aes_encrypt(l3, groq_key.encode(), aad)
    step2 = _aes_encrypt(l2, step1,              aad)
    step3 = _aes_encrypt(l1, step2,              aad)

    return base64.b64encode(step3).decode()


def decrypt_groq_key(blob_b64: str, sentinel_x: str) -> str:
    """
    Reverse of encrypt_groq_key.
    Raises ValueError (propagated from AESGCM) on tampered / wrong sentinel_x.
    Decryption order: L1⁻¹ → L2⁻¹ → L3⁻¹
    """
    aad  = sentinel_x.encode()
    l1, l2, l3 = _layer_keys(sentinel_x)
    raw = base64.b64decode(blob_b64)

    step1 = _aes_decrypt(l1, raw,   aad)
    step2 = _aes_decrypt(l2, step1, aad)
    step3 = _aes_decrypt(l3, step2, aad)

    return step3.decode()
