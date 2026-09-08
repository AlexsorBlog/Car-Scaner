"""
CarSense API Server (FastAPI/Python port)
Start: python run.py   (or: uvicorn app.main:app --reload)
"""

import os
import time
from contextlib import asynccontextmanager

from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from .db import close_db, init_db
from .rate_limit import limiter
from .routers import admin, auth, chat, perf, summary


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()

    # Promote the phones listed in ADMIN_PHONES (comma-separated) to admin.
    # This is the ONLY route to privilege — there is deliberately no self-serve
    # way to become an admin, so the first one must come from server config.
    admin_phones = [p.strip() for p in os.environ.get("ADMIN_PHONES", "").split(",") if p.strip()]
    if admin_phones:
        from . import queries
        try:
            promoted = await queries.bootstrap_admins(admin_phones)
            print(f"[admin] promoted: {promoted or 'none matched'}")
            missing = set(admin_phones) - set(promoted)
            if missing:
                print(f"[admin] NOT FOUND (register these accounts first): {sorted(missing)}")
        except Exception as err:
            print("[admin] bootstrap failed:", err)

    yield
    await close_db()


app = FastAPI(lifespan=lifespan)

# ── Rate limiting — 200 req/15min globally, 10 req/15min for auth endpoints ──
app.state.limiter = limiter
app.add_middleware(SlowAPIMiddleware)


@app.exception_handler(RateLimitExceeded)
async def rate_limit_handler(request: Request, exc: RateLimitExceeded):
    return JSONResponse(status_code=429, content={"error": "Too many requests"})


# ── Error shape — always { error: "..." }, matching what the mobile client's
# services/api.js reads (data.error), instead of FastAPI's default {detail:} ─

@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    first = exc.errors()[0] if exc.errors() else None
    message = first["msg"] if first else "Invalid request"
    return JSONResponse(status_code=400, content={"error": message})


# ── Security middleware ───────────────────────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "capacitor://localhost",  # iOS Capacitor
        "http://localhost",       # Android Capacitor
        "https://truecar.systems",
        "https://www.truecar.systems",
    ],
    # Vite's dev port isn't fixed (5173, 5174, ... depending on what's free),
    # so allow any localhost port for dev instead of chasing one at a time.
    allow_origin_regex=r"^http://localhost:\d+$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def basic_security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    return response


# Unlike Multer (which enforced fileSize during the multipart stream itself),
# FastAPI/Starlette don't cap request body size by default — a huge upload
# would get fully buffered into memory before any route-level check runs.
# Reject oversized requests up front based on Content-Length instead.
_MAX_BODY_BYTES = (int(os.environ.get("MAX_UPLOAD_MB", "10")) + 1) * 1024 * 1024  # +1MB for form overhead


@app.middleware("http")
async def limit_body_size(request: Request, call_next):
    content_length = request.headers.get("content-length")
    if content_length and int(content_length) > _MAX_BODY_BYTES:
        return JSONResponse(status_code=413, content={"error": "Request body too large"})
    return await call_next(request)


# ── Routes ────────────────────────────────────────────────────────────────────
app.include_router(auth.router, prefix="/api/auth")
app.include_router(perf.router, prefix="/api/perf")
app.include_router(summary.router, prefix="/api/summary")
app.include_router(chat.router, prefix="/api/chat")
app.include_router(admin.router, prefix="/api/admin")


# ── Admin panel page ─────────────────────────────────────────────────────────
# Served from the API itself so it lives on the same origin as the endpoints it
# calls — no CORS, no separate deploy, no extra hosting. It is a plain static
# file with no secrets in it: all access is gated by the admin JWT the page
# obtains at login, enforced server-side on every /api/admin/* call.
_ADMIN_PAGE = os.path.join(os.path.dirname(__file__), "static", "admin.html")


@app.get("/admin", include_in_schema=False)
async def admin_page():
    return FileResponse(_ADMIN_PAGE, media_type="text/html")


# ── Health check ──────────────────────────────────────────────────────────────
@app.get("/api/health")
async def health():
    return {"status": "ok", "ts": int(time.time() * 1000)}


# ── 404 ───────────────────────────────────────────────────────────────────────
@app.exception_handler(404)
async def not_found_handler(request: Request, exc):
    return JSONResponse(status_code=404, content={"error": "Not found"})
