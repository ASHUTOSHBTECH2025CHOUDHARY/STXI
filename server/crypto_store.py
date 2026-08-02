# crypto_store.py
# Triple-layer AES encryption for Groq API keys stored in Redis.
#
# Encryption pipeline (encrypt):
#   Plaintext (groq_key)
#     → Layer 1 : AES-256-GCM  (key ← SERVER_SECRET  + sentinel_x, purpose "L1")
#     → Layer 2 : AES-256-CBC  (key ← ENCRYPTION_PEPPER + sentinel_x, purpose "L2")
#     → Layer 3 : AES-256-GCM  (key ← SHA-512(SERVER_SECRET:ENCRYPTION_PEPPER:sentinel_x), purpose "L3")
#     → base64url blob  ← stored in Redis
#
# Decryption reverses in strict order: L3 → L2 → L1.
# Any tampered or wrong-sentinel_x blob raises ValueError and is rejected.
#
# Usage
# -----
#   from crypto_store import encrypt_groq_key, decrypt_groq_key
#   blob = encrypt_groq_key(raw_key, sentinel_x)
#   raw  = decrypt_groq_key(blob,    sentinel_x)

import os
import base64
import hashlib
import secrets
from typing import Optional

from cryptography.hazmat.primitives.ciphers      import Cipher, algorithms, modes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2   import PBKDF2HMAC
from cryptography.hazmat.primitives              import hashes, padding as sym_padding
from cryptography.hazmat.backends                import default_backend
from cryptography.exceptions                     import InvalidTag

SERVER_SECRET     = os.environ.get("SERVER_SECRET",     "CHANGE_ME_SERVER_SECRET")
ENCRYPTION_PEPPER = os.environ.get("ENCRYPTION_PEPPER", "CHANGE_ME_ENCRYPTION_PEPPER")

# Redis TTL for stored groq keys
GROQ_KEY_TTL = 60 * 60 * 8   # 8 hours


# ── Internal key-derivation ───────────────────────────────────────────────────

def _derive_key(ikm: str, salt: bytes, length: int = 32) -> bytes:
    """PBKDF2-SHA512, 200 000 iterations → 256-bit AES key."""
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA512(),
        length=length,
        salt=salt,
        iterations=200_000,
        backend=default_backend(),
    )
    return kdf.derive(ikm.encode())


def _layer1_key(sentinel_x: str) -> bytes:
    salt = hashlib.sha256(f"L1:{SERVER_SECRET}:{sentinel_x}".encode()).digest()
    return _derive_key(f"{SERVER_SECRET}{sentinel_x}", salt)


def _layer2_key(sentinel_x: str) -> bytes:
    salt = hashlib.sha256(f"L2:{ENCRYPTION_PEPPER}:{sentinel_x}".encode()).digest()
    return _derive_key(f"{ENCRYPTION_PEPPER}{sentinel_x}", salt)


def _layer3_key(sentinel_x: str) -> bytes:
    combined = hashlib.sha512(
        f"{SERVER_SECRET}:{ENCRYPTION_PEPPER}:{sentinel_x}".encode()
    ).hexdigest()
    salt = hashlib.sha256(f"L3:{combined}".encode()).digest()
    return _derive_key(combined, salt)


# ── Primitive encrypt / decrypt helpers ──────────────────────────────────────

def _gcm_encrypt(key: bytes, plaintext: bytes, aad: bytes = b"") -> bytes:
    """AES-256-GCM: returns  nonce(12) ‖ ciphertext ‖ tag(16)."""
    nonce = secrets.token_bytes(12)
    ct    = AESGCM(key).encrypt(nonce, plaintext, aad or None)
    return nonce + ct


def _gcm_decrypt(key: bytes, data: bytes, aad: bytes = b"") -> bytes:
    """Raises cryptography.exceptions.InvalidTag on failure."""
    nonce, ct = data[:12], data[12:]
    return AESGCM(key).decrypt(nonce, ct, aad or None)


def _cbc_encrypt(key: bytes, plaintext: bytes) -> bytes:
    """AES-256-CBC with PKCS7: returns  iv(16) ‖ ciphertext."""
    iv      = secrets.token_bytes(16)
    padder  = sym_padding.PKCS7(128).padder()
    padded  = padder.update(plaintext) + padder.finalize()
    cipher  = Cipher(algorithms.AES(key), modes.CBC(iv), backend=default_backend())
    enc     = cipher.encryptor()
    return iv + enc.update(padded) + enc.finalize()


def _cbc_decrypt(key: bytes, data: bytes) -> bytes:
    """Raises ValueError on bad padding; caller maps to ValueError."""
    iv, ct   = data[:16], data[16:]
    cipher   = Cipher(algorithms.AES(key), modes.CBC(iv), backend=default_backend())
    dec      = cipher.decryptor()
    padded   = dec.update(ct) + dec.finalize()
    unpadder = sym_padding.PKCS7(128).unpadder()
    return unpadder.update(padded) + unpadder.finalize()


# ── Public API ────────────────────────────────────────────────────────────────

def encrypt_groq_key(groq_key: str, sentinel_x: str) -> str:
    """
    Triple-layer AES encrypt *groq_key* bound to *sentinel_x*.
    Returns a base64url-safe string ready to store in Redis.

    Layer order:
      L1  AES-256-GCM  – keyed on SERVER_SECRET  + sentinel_x
      L2  AES-256-CBC  – keyed on ENCRYPTION_PEPPER + sentinel_x
      L3  AES-256-GCM  – keyed on SHA-512(SERVER_SECRET:ENCRYPTION_PEPPER:sentinel_x)

    AAD for both GCM layers is the sentinel_x bytes, binding the blob
    to the identity it was created for.
    """
    aad       = sentinel_x.encode()
    plaintext = groq_key.encode()

    step1 = _gcm_encrypt(_layer1_key(sentinel_x), plaintext, aad)
    step2 = _cbc_encrypt(_layer2_key(sentinel_x), step1)
    step3 = _gcm_encrypt(_layer3_key(sentinel_x), step2, aad)

    return base64.urlsafe_b64encode(step3).decode()


def decrypt_groq_key(encrypted_blob: str, sentinel_x: str) -> str:
    """
    Reverse the triple-layer decryption.
    Raises ValueError if the blob is tampered, expired, or belongs to a
    different sentinel_x (GCM tag check catches identity mismatch).
    """
    aad = sentinel_x.encode()
    try:
        raw   = base64.urlsafe_b64decode(encrypted_blob.encode())
        step2 = _gcm_decrypt(_layer3_key(sentinel_x), raw,   aad)
        step1 = _cbc_decrypt(_layer2_key(sentinel_x), step2)
        plain = _gcm_decrypt(_layer1_key(sentinel_x), step1, aad)
        return plain.decode()
    except (InvalidTag, ValueError, Exception) as exc:
        raise ValueError(f"Groq key decryption failed: {exc}") from exc
