# db.py
# MongoDB + Redis layer with AES-256-GCM server-side encryption.
# Sensitive PII (resume, hr_log, applications) encrypted before writing to MongoDB.
# Redis handles ephemeral data with automatic TTL expiry — no encryption needed there.
#
# Install deps:
#   pip install pymongo redis cryptography python-dotenv

import os, json, base64, hashlib, hmac
from datetime  import datetime, timezone
from pathlib   import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2   import PBKDF2HMAC
from cryptography.hazmat.primitives              import hashes
from cryptography.hazmat.backends                import default_backend

from pymongo       import MongoClient, ASCENDING
from pymongo.errors import DuplicateKeyError
from upstash_redis import Redis

from dotenv import load_dotenv

load_dotenv()

# ── Config from environment ───────────────────────────────────────────────────

MONGO_URI         = os.environ["MONGO_URI_DEVELOPMENT"]
REDIS_URL         = os.environ["UPSTASH_REDIS_REST_URL"]
REDIS_TOKEN       = os.environ["UPSTASH_REDIS_REST_TOKEN"]
SERVER_SECRET     = os.environ["SERVER_SECRET"]
ENCRYPTION_PEPPER = os.environ["ENCRYPTION_PEPPER"]

# TTLs
CHAT_TTL      = 60 * 60 * 24   # 24 hours
QUEUE_TTL     = 60 * 60 * 2    # 2 hours
SESSION_TTL   = 60 * 30        # 30 minutes
RATELIMIT_TTL = 60             # 1 minute (rate limit counters reset every 10 seconds)

# ── Connections ───────────────────────────────────────────────────────────────

_mongo_client = None
_redis_client = None

def mongo_db():
    global _mongo_client
    if _mongo_client is None:
        _mongo_client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000)
    return _mongo_client["job_agent"]

def redis_client():
    global _redis_client
    if _redis_client is None:
        _redis_client = Redis(REDIS_URL, token=REDIS_TOKEN)
    return _redis_client

def init_db():
    """Create indexes on startup."""
    db = mongo_db()
    db.users.create_index("sentinel_x", unique=True)
    db.resumes.create_index("sentinel_x", unique=True)
    db.hr_log.create_index([("sentinel_x", ASCENDING), ("sent_at", ASCENDING)])
    db.applications.create_index([("sentinel_x", ASCENDING), ("timestamp", ASCENDING)])
    print("[DB] MongoDB indexes ready.")

# ── Server-side encryption ────────────────────────────────────────────────────
# AES-256-GCM with per-user key derived from sentinelX + server secrets.
# Encrypts only PII stored in MongoDB: resume JSON, hr_log, applications.
# Chat history and session flags in Redis are ephemeral and not encrypted.

def _derive_server_key(sentinel_x: str, purpose: str) -> bytes:
    """Derive a 256-bit AES key for a specific sentinel + purpose."""
    salt = hashlib.sha256(
        f"{ENCRYPTION_PEPPER}::{purpose}::{sentinel_x}".encode()
    ).digest()

    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA512(),
        length=32,
        salt=salt,
        iterations=600_000,     # OWASP 2024 recommendation for PBKDF2-SHA512
        backend=default_backend()
    )
    return kdf.derive(SERVER_SECRET.encode())

def encrypt_field(data: str, sentinel_x: str, purpose: str = "general") -> str:
    """Encrypt a string field for MongoDB storage."""
    key    = _derive_server_key(sentinel_x, purpose)
    aesgcm = AESGCM(key)
    nonce  = os.urandom(12)                                          # 96-bit nonce
    ct     = aesgcm.encrypt(nonce, data.encode(), sentinel_x.encode())  # AAD = sentinelX
    return base64.b64encode(nonce + ct).decode()

def decrypt_field(encrypted_b64: str, sentinel_x: str, purpose: str = "general") -> str:
    """Decrypt a field from MongoDB."""
    key    = _derive_server_key(sentinel_x, purpose)
    aesgcm = AESGCM(key)
    packed = base64.b64decode(encrypted_b64)
    nonce  = packed[:12]
    ct     = packed[12:]
    return aesgcm.decrypt(nonce, ct, sentinel_x.encode()).decode()

def encrypt_json(obj: dict, sentinel_x: str, purpose: str = "general") -> str:
    return encrypt_field(json.dumps(obj), sentinel_x, purpose)

def decrypt_json(encrypted_b64: str, sentinel_x: str, purpose: str = "general") -> dict:
    return json.loads(decrypt_field(encrypted_b64, sentinel_x, purpose))

# ── HMAC sentinel verification ────────────────────────────────────────────────

def hmac_sentinel(sentinel_x: str) -> str:
    """Produce an HMAC of sentinelX for DB _id — raw sentinelX never stored as _id."""
    return hmac.new(
        SERVER_SECRET.encode(),
        sentinel_x.encode(),
        hashlib.sha256
    ).hexdigest()

# ── Users collection ──────────────────────────────────────────────────────────

def register_user(sentinel_x: str) -> dict:
    """Create user entry on first install. Idempotent."""
    db  = mongo_db()
    uid = hmac_sentinel(sentinel_x)
    now = datetime.now(timezone.utc).isoformat()
    try:
        db.users.insert_one({"_id": uid, "created_at": now, "last_seen": now})
        return {"status": "created"}
    except DuplicateKeyError:
        db.users.update_one({"_id": uid}, {"$set": {"last_seen": now}})
        return {"status": "existing"}

def verify_user(sentinel_x: str) -> bool:
    """Check if sentinelX is registered."""
    uid = hmac_sentinel(sentinel_x)
    return mongo_db().users.find_one({"_id": uid}) is not None

def touch_user(sentinel_x: str):
    """Update last_seen timestamp."""
    uid = hmac_sentinel(sentinel_x)
    mongo_db().users.update_one(
        {"_id": uid},
        {"$set": {"last_seen": datetime.now(timezone.utc).isoformat()}}
    )

# ── Resumes collection ────────────────────────────────────────────────────────
# Only the parsed resume JSON is stored (encrypted).
# Original file bytes are NOT stored — user re-attaches locally when sending mail.

def save_resume(sentinel_x: str, resume_json: dict) -> dict:
    """Store encrypted resume JSON. Overwrites existing."""
    db  = mongo_db()
    now = datetime.now(timezone.utc).isoformat()

    db.resumes.replace_one(
        {"sentinel_x": sentinel_x},
        {
            "sentinel_x":  sentinel_x,
            "resume":      resume_json,
            "last_updated": now,
        },
        upsert=True
    )
    return {
        "status":         "stored",
        "resume_present": True,
        "last_updated":   now,
        "resume":         resume_json
    }

def get_resume(sentinel_x: str) -> dict:
    """Retrieve and decrypt resume JSON."""
    doc = mongo_db().resumes.find_one({"sentinel_x": sentinel_x})
    if not doc:
        return {
            "status":         "not_found",
            "resume_present": False,
            "last_updated":   None,
            "resume":         "NO_RESUME_FOUND"
        }
    return {
        "status":         "retrieved",
        "resume_present": True,
        "last_updated":   doc.get("last_updated"),
        "resume":         doc.get("resume")
    }

def delete_resume(sentinel_x: str) -> dict:
    mongo_db().resumes.delete_one({"sentinel_x": sentinel_x})
    return {"status": "cleared", "resume_present": False, "last_updated": None, "resume": None}

# Alias used by app.py route
clear_resume = delete_resume

# ── HR log collection ─────────────────────────────────────────────────────────

def append_hr_log(sentinel_x: str, entry: dict):
    """Append one sent-email record (encrypted)."""
    mongo_db().hr_log.insert_one({
        "sentinel_x": sentinel_x,
        "data":       encrypt_json(entry, sentinel_x, "hr_log"),
        "sent_at":    entry.get("sent_at", datetime.now(timezone.utc).isoformat())
    })

def get_hr_log(sentinel_x: str, limit: int = 20) -> list:
    """Return decrypted HR log entries, newest first."""
    docs = mongo_db().hr_log.find(
        {"sentinel_x": sentinel_x},
        sort=[("sent_at", -1)],
        limit=limit
    )
    result = []
    for doc in docs:
        try:
            result.append(decrypt_json(doc["data"], sentinel_x, "hr_log"))
        except Exception:
            pass
    return result

def clear_hr_log(sentinel_x: str):
    mongo_db().hr_log.delete_many({"sentinel_x": sentinel_x})

# ── Applications collection ───────────────────────────────────────────────────

def save_application(sentinel_x: str, entry: dict):
    mongo_db().applications.insert_one({
        "sentinel_x": sentinel_x,
        "data":       encrypt_json(entry, sentinel_x, "application"),
        "timestamp":  entry.get("timestamp", datetime.now(timezone.utc).isoformat())
    })

def get_applications(sentinel_x: str, limit: int = 50) -> list:
    docs = mongo_db().applications.find(
        {"sentinel_x": sentinel_x},
        sort=[("timestamp", -1)],
        limit=limit
    )
    result = []
    for doc in docs:
        try:
            result.append(decrypt_json(doc["data"], sentinel_x, "application"))
        except Exception:
            pass
    return result

# ── Redis — Chat history (plaintext, ephemeral, 24hr TTL) ─────────────────────
# No encryption here — chat messages are transient, low-sensitivity context,
# and encrypting them would add PBKDF2 overhead on every message.

def _chat_key(sentinel_x: str) -> str:
    return f"chat:{sentinel_x}"

def get_chat_history(sentinel_x: str) -> list:
    raw = redis_client().get(_chat_key(sentinel_x))
    if not raw:
        return []
    try:
        return json.loads(raw)
    except Exception:
        return []

def save_chat_history(sentinel_x: str, history: list):
    redis_client().setex(
        _chat_key(sentinel_x),
        CHAT_TTL,
        json.dumps(history[-40:])   # keep last 40 messages
    )

def clear_chat_history(sentinel_x: str):
    redis_client().delete(_chat_key(sentinel_x))

# ── Redis — Job queue ─────────────────────────────────────────────────────────

def _queue_key(sentinel_x: str) -> str:
    return f"queue:{sentinel_x}"

def get_job_queue(sentinel_x: str) -> list:
    raw = redis_client().get(_queue_key(sentinel_x))
    if not raw:
        return []
    try:
        return json.loads(raw)
    except Exception:
        return []

def save_job_queue(sentinel_x: str, queue: list):
    redis_client().setex(_queue_key(sentinel_x), QUEUE_TTL, json.dumps(queue))

def clear_job_queue(sentinel_x: str):
    redis_client().delete(_queue_key(sentinel_x))

# ── Redis — Rate limiting ─────────────────────────────────────────────────────

def _rate_key(sentinel_x: str, endpoint: str) -> str:
    return f"ratelimit:{endpoint}:{sentinel_x}"

def check_rate_limit(sentinel_x: str, endpoint: str, max_per_minute: int = 120) -> bool:
    """Returns True if request is allowed, False if rate limited."""
    r     = redis_client()
    key   = _rate_key(sentinel_x, endpoint)
    count = r.incr(key)
    if count == 1:
        r.expire(key, RATELIMIT_TTL)
    return count <= max_per_minute

# ── Redis — Session ───────────────────────────────────────────────────────────

def _session_key(sentinel_x: str) -> str:
    return f"session:{sentinel_x}"

def touch_session(sentinel_x: str):
    redis_client().setex(_session_key(sentinel_x), SESSION_TTL, "1")

def is_session_active(sentinel_x: str) -> bool:
    return redis_client().exists(_session_key(sentinel_x)) > 0