# jwt_utils.py
# Wraps the client's Groq API key in a signed JWT so it is never stored
# server-side and is not exposed in plain-text query strings after the
# initial /health handshake.
#
# Flow:
#   1. Client sends groq_key to /health
#   2. Server validates the key (test Groq call), then returns a signed JWT
#   3. Client stores the JWT and attaches it as  X-Groq-Token: <jwt>
#      on every subsequent request
#   4. Server verifies JWT and extracts the key; falls back to its own key
#      if the header is absent or invalid

import os
from datetime import datetime, timezone, timedelta
from typing   import Optional

import jwt  # PyJWT

JWT_SECRET       = os.environ.get("JWT_SECRET", "CHANGE_ME_set_JWT_SECRET_in_env")
JWT_ALGO         = "HS256"
JWT_EXPIRE_HOURS = 24 * 7   # tokens last 7 days


def create_groq_token(groq_key: str) -> str:
    """Sign a JWT that carries the client's Groq API key."""
    payload = {
        "groq_key": groq_key,
        "iat": datetime.now(timezone.utc),
        "exp": datetime.now(timezone.utc) + timedelta(hours=JWT_EXPIRE_HOURS),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGO)


def verify_groq_token(token: str) -> Optional[str]:
    """
    Verify the JWT and return the groq_key it contains.
    Returns None if the token is missing, expired, or tampered with.
    """
    if not token:
        return None
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGO])
        return payload.get("groq_key")
    except jwt.ExpiredSignatureError:
        return None
    except jwt.InvalidTokenError:
        return None
