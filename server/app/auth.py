"""
app/auth.py — password hashing + JWT issuing/verification.
"""

import os
import time

import bcrypt
import jwt
from fastapi import Header, HTTPException

JWT_SECRET = os.environ["JWT_SECRET"]
TOKEN_TTL_SECONDS = 90 * 24 * 3600  # 90 days, matches the old Node server


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt(10)).decode()


def verify_password(password: str, password_hash: str) -> bool:
    if not password_hash:
        return False
    return bcrypt.checkpw(password.encode(), password_hash.encode())


def sign_token(user_id: int) -> str:
    now = int(time.time())
    return jwt.encode(
        {"id": user_id, "iat": now, "exp": now + TOKEN_TTL_SECONDS},
        JWT_SECRET,
        algorithm="HS256",
    )


async def require_auth(authorization: str | None = Header(default=None)) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing token")
    token = authorization[len("Bearer "):]
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    return payload
