"""
POST /api/auth/register  — phone + password + basic profile
POST /api/auth/login     — phone + password → JWT
GET  /api/auth/profile   — get own profile
PUT  /api/auth/profile   — update own profile
"""

import base64
import re

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from pydantic import BaseModel

from .. import queries
from ..auth import hash_password, require_auth, sign_token, verify_password
from ..rate_limit import limiter

router = APIRouter()

PHONE_RE = re.compile(r"^\+?[0-9]{7,15}$")
MAX_AVATAR_BYTES = 3 * 1024 * 1024  # 3MB — client compresses to well under this before upload


def _safe_user(user: dict) -> dict:
    return {k: v for k, v in user.items() if k != "password_hash"}


# ── Register ──────────────────────────────────────────────────────────────────

class RegisterBody(BaseModel):
    phone: str
    password: str
    name: str
    car_brand: str = ""
    car_model: str = ""
    car_year: int | None = None
    vin: str = ""
    email: str = ""


@router.post("/register", status_code=201)
@limiter.limit("10/15minutes")
async def register(request: Request, body: RegisterBody):
    if not PHONE_RE.match(body.phone):
        raise HTTPException(400, "Invalid phone")
    if len(body.password) < 6:
        raise HTTPException(400, "Password min 6 chars")
    if not body.name.strip():
        raise HTTPException(400, "Name required")

    existing = await queries.get_user_by_phone(body.phone)
    if existing:
        raise HTTPException(409, "Phone already registered")

    password_hash = hash_password(body.password)
    try:
        user = await queries.create_user(
            phone=body.phone, password_hash=password_hash, name=body.name,
            car_brand=body.car_brand, car_model=body.car_model, car_year=body.car_year,
            vin=body.vin, email=body.email,
        )
    except Exception as err:
        print("[auth] register:", err)
        raise HTTPException(500, "Server error")

    token = sign_token(user["id"])
    return {
        "token": token,
        "user": {
            "id": user["id"], "phone": body.phone, "name": body.name,
            "car_brand": body.car_brand, "car_model": body.car_model,
            "car_year": body.car_year, "vin": body.vin, "email": body.email,
        },
    }


# ── Login ─────────────────────────────────────────────────────────────────────

class LoginBody(BaseModel):
    phone: str
    password: str


@router.post("/login")
@limiter.limit("10/15minutes")
async def login(request: Request, body: LoginBody):
    user = await queries.get_user_by_phone(body.phone)
    if not user:
        raise HTTPException(401, "Invalid credentials")

    if not verify_password(body.password, user["password_hash"]):
        raise HTTPException(401, "Invalid credentials")

    token = sign_token(user["id"])
    return {"token": token, "user": _safe_user(user)}


# ── Get profile ───────────────────────────────────────────────────────────────

@router.get("/profile")
async def get_profile(auth_user: dict = Depends(require_auth)):
    user = await queries.get_user_by_id(auth_user["id"])
    if not user:
        raise HTTPException(404, "User not found")
    return _safe_user(user)


# ── Update profile ────────────────────────────────────────────────────────────
# Fields the client omits keep their current value instead of being cleared
# (the UI doesn't always send every column, e.g. car_year).

class UpdateProfileBody(BaseModel):
    name: str
    car_brand: str | None = None
    car_model: str | None = None
    car_year: int | None = None
    vin: str | None = None
    email: str | None = None


@router.put("/profile")
async def update_profile(body: UpdateProfileBody, auth_user: dict = Depends(require_auth)):
    if not body.name.strip():
        raise HTTPException(400, "Name required")

    existing = await queries.get_user_by_id(auth_user["id"])
    if not existing:
        raise HTTPException(404, "User not found")

    updated = await queries.update_user(
        id=auth_user["id"],
        name=body.name,
        car_brand=body.car_brand if body.car_brand is not None else existing["car_brand"],
        car_model=body.car_model if body.car_model is not None else existing["car_model"],
        car_year=body.car_year if body.car_year is not None else existing["car_year"],
        vin=body.vin if body.vin is not None else existing["vin"],
        email=body.email if body.email is not None else existing["email"],
    )
    return {"ok": True, "user": _safe_user(updated)}


# ── Update avatar ─────────────────────────────────────────────────────────────

@router.put("/avatar")
async def update_avatar(avatar: UploadFile = File(...), auth_user: dict = Depends(require_auth)):
    if not (avatar.content_type or "").startswith("image/"):
        raise HTTPException(400, "Uploaded file must be an image")
    raw = await avatar.read()
    if len(raw) > MAX_AVATAR_BYTES:
        raise HTTPException(413, "Avatar image too large")

    avatar_base64 = base64.b64encode(raw).decode()
    updated = await queries.update_avatar(id=auth_user["id"], avatar_base64=avatar_base64, avatar_mime=avatar.content_type)
    return {"ok": True, "user": _safe_user(updated)}
