"""
POST /api/summary   — upsert today's summary (called once per day from app)
GET  /api/summary   — get own summaries (last 90 days)
"""

import re
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import queries
from ..auth import require_auth

router = APIRouter()

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class SummaryBody(BaseModel):
    date: str
    avg_speed: float | None = None
    max_speed: float | None = None
    avg_rpm: float | None = None
    avg_temp: float | None = None
    avg_fuel: float | None = None
    error_codes: list[Any] = []
    top_errors: list[Any] = []
    distance_km: float = 0


@router.post("")
async def save_summary(body: SummaryBody, auth_user: dict = Depends(require_auth)):
    if not DATE_RE.match(body.date):
        raise HTTPException(400, "date must be YYYY-MM-DD")

    await queries.upsert_summary(
        user_id=auth_user["id"],
        date=body.date,
        avg_speed=body.avg_speed,
        max_speed=body.max_speed,
        avg_rpm=body.avg_rpm,
        avg_temp=body.avg_temp,
        avg_fuel=body.avg_fuel,
        error_codes=body.error_codes,
        top_errors=body.top_errors,
        distance_km=body.distance_km,
    )

    return {"ok": True}


@router.get("")
async def get_summaries(auth_user: dict = Depends(require_auth)):
    rows = await queries.get_summaries(auth_user["id"])
    return [
        {**r, "error_codes": r["error_codes"] or [], "top_errors": r["top_errors"] or []}
        for r in rows
    ]
