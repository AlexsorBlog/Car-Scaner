"""
app/routers/admin.py — admin API for the monitoring panel.

Every route is behind require_admin, which re-reads the user row per request
(see auth.py) so revoking admin takes effect immediately rather than when a
90-day token finally expires.

Guard rails that matter, because these endpoints are destructive:
  - an admin cannot delete or block themselves (locking yourself out of the
    only admin account is unrecoverable without database access)
  - the last remaining admin cannot be demoted or deleted
  - password changes are logged to activity_log with the actor's id
"""

import os

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from .. import queries
from ..auth import hash_password, require_admin

router = APIRouter()

# Rough USD per 1M tokens, used only for the cost estimate shown in the panel.
# Override with OPENAI_PRICE_IN / OPENAI_PRICE_OUT when pricing changes so the
# figure doesn't quietly drift from reality.
PRICE_IN_PER_1M = float(os.environ.get("OPENAI_PRICE_IN", "2.50"))
PRICE_OUT_PER_1M = float(os.environ.get("OPENAI_PRICE_OUT", "10.00"))


class PasswordBody(BaseModel):
    password: str = Field(min_length=6, max_length=128)


class FlagBody(BaseModel):
    value: bool


async def _count_admins() -> int:
    stats = await queries.admin_stats()
    return int(stats["users"]["admins"])


@router.get("/stats")
async def stats(_admin: dict = Depends(require_admin)):
    data = await queries.admin_stats()
    t = data["tokens"]
    data["estimated_cost_usd"] = round(
        (int(t["prompt"]) / 1_000_000) * PRICE_IN_PER_1M
        + (int(t["completion"]) / 1_000_000) * PRICE_OUT_PER_1M,
        4,
    )
    data["pricing"] = {"in_per_1m": PRICE_IN_PER_1M, "out_per_1m": PRICE_OUT_PER_1M}
    return data


@router.get("/users")
async def list_users(
    search: str = Query(default=""),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    _admin: dict = Depends(require_admin),
):
    rows = await queries.admin_list_users(search=search, limit=limit, offset=offset)
    total = rows[0]["total_count"] if rows else 0
    for r in rows:
        r.pop("total_count", None)
    return {"users": rows, "total": total, "limit": limit, "offset": offset}


@router.get("/usage")
async def usage(days: int = Query(default=14, ge=1, le=90),
                _admin: dict = Depends(require_admin)):
    return {"series": await queries.admin_usage_series(days)}


@router.get("/activity")
async def activity(limit: int = Query(default=100, ge=1, le=500),
                   _admin: dict = Depends(require_admin)):
    return {"activity": await queries.admin_recent_activity(limit)}


@router.put("/users/{user_id}/password")
async def set_password(user_id: int, body: PasswordBody,
                       admin: dict = Depends(require_admin)):
    target = await queries.get_user_by_id(user_id)
    if not target:
        raise HTTPException(404, "User not found")

    ok = await queries.admin_set_password(user_id, hash_password(body.password))
    if not ok:
        raise HTTPException(500, "Failed to update password")

    # Who changed whose password is exactly the kind of thing you want a trail
    # of; the password itself is of course never recorded.
    await queries.log_activity(
        admin["id"], "admin.password_reset",
        f"target_user={user_id} ({target.get('phone')})",
    )
    return {"ok": True}


@router.put("/users/{user_id}/blocked")
async def set_blocked(user_id: int, body: FlagBody,
                      admin: dict = Depends(require_admin)):
    if user_id == admin["id"]:
        raise HTTPException(400, "Не можна заблокувати власний акаунт")
    if not await queries.get_user_by_id(user_id):
        raise HTTPException(404, "User not found")

    await queries.admin_set_flag(user_id, "is_blocked", body.value)
    await queries.log_activity(
        admin["id"], "admin.block" if body.value else "admin.unblock",
        f"target_user={user_id}",
    )
    return {"ok": True}


@router.put("/users/{user_id}/admin")
async def set_admin(user_id: int, body: FlagBody,
                    admin: dict = Depends(require_admin)):
    target = await queries.get_user_by_id(user_id)
    if not target:
        raise HTTPException(404, "User not found")

    # Removing the last admin would leave the panel permanently unreachable.
    if not body.value and target.get("is_admin") and await _count_admins() <= 1:
        raise HTTPException(400, "Не можна зняти права з останнього адміністратора")

    await queries.admin_set_flag(user_id, "is_admin", body.value)
    await queries.log_activity(
        admin["id"], "admin.grant" if body.value else "admin.revoke",
        f"target_user={user_id}",
    )
    return {"ok": True}


@router.delete("/users/{user_id}")
async def delete_user(user_id: int, admin: dict = Depends(require_admin)):
    if user_id == admin["id"]:
        raise HTTPException(400, "Не можна видалити власний акаунт")

    target = await queries.get_user_by_id(user_id)
    if not target:
        raise HTTPException(404, "User not found")
    if target.get("is_admin") and await _count_admins() <= 1:
        raise HTTPException(400, "Не можна видалити останнього адміністратора")

    await queries.admin_delete_user(user_id)
    await queries.log_activity(
        admin["id"], "admin.delete_user", f"target_user={user_id} ({target.get('phone')})",
    )
    return {"ok": True}
