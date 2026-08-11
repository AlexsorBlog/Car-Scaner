"""
POST /api/perf            — save a new perf run
GET  /api/perf/mine       — get own records
GET  /api/perf/leaderboard— global leaderboard (?filter=0-100&brand=BMW&offset=&limit=)
"""

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from .. import queries
from ..auth import require_auth

router = APIRouter()


# ── Save run ──────────────────────────────────────────────────────────────────

class SaveRunBody(BaseModel):
    filter_key: str
    time_ms: int
    distance_m: float = 0
    telemetry: list[Any] = []


@router.post("", status_code=201)
async def save_run(body: SaveRunBody, auth_user: dict = Depends(require_auth)):
    if not body.filter_key:
        raise HTTPException(400, "filter_key required")
    if body.time_ms < 1:
        raise HTTPException(400, "time_ms must be >= 1")
    if body.distance_m < 0:
        raise HTTPException(400, "distance_m must be >= 0")

    user = await queries.get_user_by_id(auth_user["id"])

    # Cap telemetry at 2000 points to keep DB lean
    capped_telemetry = body.telemetry[:2000]

    await queries.insert_perf_record(
        user_id=auth_user["id"],
        filter_key=body.filter_key,
        car_brand=(user or {}).get("car_brand") or "",
        car_model=(user or {}).get("car_model") or "",
        time_ms=body.time_ms,
        distance_m=body.distance_m,
        telemetry_json=capped_telemetry,
    )

    # Prune to keep only 50 per user
    await queries.prune_old_perf_records(auth_user["id"])

    return {"ok": True}


# ── Own records ───────────────────────────────────────────────────────────────

@router.get("/mine")
async def get_mine(auth_user: dict = Depends(require_auth)):
    rows = await queries.get_user_perf_records(auth_user["id"])
    return [{**r, "telemetry": r["telemetry_json"] or []} for r in rows]


# ── Leaderboard ───────────────────────────────────────────────────────────────

@router.get("/leaderboard")
async def get_leaderboard(
    filter: str = Query(..., min_length=1),
    brand: str = Query(""),
    offset: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=50),
    auth_user: dict = Depends(require_auth),
):
    rows = await queries.leaderboard(filter_key=filter, brand=brand, limit=limit, offset=offset)

    rank_row = await queries.user_rank(filter_key=filter, brand=brand, user_id=auth_user["id"])
    my_rank = rank_row["rank"] if rank_row else None

    total_count = rows[0]["total_count"] if rows else 0

    board = []
    for i, r in enumerate(rows):
        rank = offset + i + 1
        entry = {
            "rank": rank,
            "user_id": r["user_id"],
            "name": r["user_name"],
            "car_brand": r["car_brand"] or r["user_car_brand"],
            "car_model": r["car_model"] or r["user_car_model"],
            "time_ms": r["time_ms"],
            "distance_m": r["distance_m"],
            "filter_key": r["filter_key"],
            "is_me": r["user_id"] == auth_user["id"],
        }
        # Only top-3 overall get telemetry attached (graph previews) — keeps
        # every other page's payload light.
        if rank <= 3:
            entry["telemetry"] = r["telemetry_json"] or []
        board.append(entry)

    return {
        "board": board,
        "my_rank": my_rank,
        "filter_key": filter,
        "brand": brand,
        "offset": offset,
        "limit": limit,
        "has_more": offset + len(rows) < total_count,
    }
