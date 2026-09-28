"""
app/routers/places.py — nearby car services, searched server-side.

Why this lives on the server rather than in the app:

  * One IP instead of thousands. Photon and Overpass are free public services
    with fair-use limits. During development, a laptop firing ~7 searches at a
    time got blocked outright by Photon (every request then failing at the
    connection level for minutes). Every phone doing that independently is both
    rude and fragile.
  * One shared cache. The second person to search a district gets the first
    person's answer instantly.
  * One request from the phone instead of up to fifteen (searches + per-shop
    phone lookups), which matters on mobile data.
  * The fallback chain and its timeouts live in one place we can fix without
    shipping a new build through the App Store.

Deliberately stdlib-only (urllib + asyncio.to_thread) so the deployment gains no
new dependency.
"""

import asyncio
import json
import time
import urllib.parse
import urllib.request
from typing import Any

from fastapi import APIRouter, Depends, Query

from .. import db
from ..auth import require_auth

router = APIRouter()

PHOTON_URL = "https://photon.komoot.io/reverse"
OSM_API = "https://api.openstreetmap.org/api/0.6"
OVERPASS_URLS = [
    "https://lz4.overpass-api.de/api/interpreter",
    "https://z.overpass-api.de/api/interpreter",
    "https://overpass-api.de/api/interpreter",
]

# A User-Agent is not optional: overpass-api.de answers an instant HTTP 406
# from Apache without one. Measured — same query, 200 with, 406 without.
UA = "CarSense/1.0 (+https://truecar.systems)"

# Photon caps `limit` at 50 server-side, and several osm_tag values in one
# request AND together instead of OR — so it is one request per kind.
PHOTON_LIMIT = 50

# Split by urgency. Measured: seven concurrent Photon requests from one IP take
# 4.8-10.1s because Photon throttles the burst, while the phone lookups that
# follow take only 0.1-0.6s. Four is what a driver looking for a garage needs;
# the rest arrive in the background and land in the cache.
PRIMARY_TAGS = [
    ("shop:car_repair", "repair", "СТО"),
    ("craft:car_repair", "repair", "СТО"),
    ("shop:tyres", "tyres", "Шиномонтаж"),
    ("shop:car_parts", "parts", "Автозапчастини"),
]

SECONDARY_TAGS = [
    ("shop:car", "dealer", "Автосалон"),
    ("amenity:car_wash", "wash", "Автомийка"),
    ("shop:motorcycle_repair", "moto", "Мотосервіс"),
]

SERVICE_TAGS = PRIMARY_TAGS + SECONDARY_TAGS

# A hung mirror must not dominate the wall time when other tags already answered.
PHOTON_TIMEOUT = 5.0

OSM_TYPE = {"N": "node", "W": "way", "R": "relation"}

# Phone lookups are split in two. A small head is fetched before responding so
# the first screen already shows numbers; the rest continues in the background
# and lands in the cache, because enriching 45 shops inline measured 5-6s —
# over the "under 5 seconds" bar — while the search itself takes ~1.5s.
ENRICH_INLINE = 10
ENRICH_BACKGROUND = 45

CACHE_TTL_SECONDS = 24 * 60 * 60
# L1: in-process, instant. L2: Postgres, so a deploy or restart does not throw
# the day's searches away — which it did, sending already-searched areas back to
# the slow provider after every restart.
_cache: dict[str, tuple[float, list[dict]]] = {}
# Bounded so a busy day cannot grow the process without limit.
_CACHE_MAX = 500

CACHE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS places_cache (
  key        TEXT PRIMARY KEY,
  shops      JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_places_cache_time ON places_cache(created_at);
"""
_table_ready = False


async def _ensure_table() -> None:
    global _table_ready
    if _table_ready or db.pool is None:
        return
    try:
        async with db.pool.acquire() as conn:
            await conn.execute(CACHE_TABLE_SQL)
        _table_ready = True
    except Exception:
        pass   # caching is an optimisation, never a hard dependency


async def _db_cache_get(key: str) -> list[dict] | None:
    if db.pool is None:
        return None
    await _ensure_table()
    try:
        async with db.pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT shops FROM places_cache "
                "WHERE key = $1 AND created_at > now() - ($2 || ' seconds')::interval",
                key, str(CACHE_TTL_SECONDS),
            )
        return json.loads(row["shops"]) if row else None
    except Exception:
        return None


async def _db_cache_put(key: str, shops: list[dict]) -> None:
    if db.pool is None:
        return
    await _ensure_table()
    try:
        async with db.pool.acquire() as conn:
            await conn.execute(
                "INSERT INTO places_cache (key, shops, created_at) VALUES ($1, $2, now()) "
                "ON CONFLICT (key) DO UPDATE SET shops = $2, created_at = now()",
                key, json.dumps(shops, ensure_ascii=False),
            )
            # Keep the table from growing forever.
            await conn.execute(
                "DELETE FROM places_cache WHERE created_at < now() - interval '7 days'")
    except Exception:
        pass


def _cache_key(lat: float, lon: float, radius_m: int) -> str:
    # ~1.1km granularity: searching from a few streets away reuses the answer.
    return f"{lat:.2f},{lon:.2f}@{radius_m}"


def _cache_get(key: str) -> list[dict] | None:
    hit = _cache.get(key)
    if not hit:
        return None
    ts, shops = hit
    if time.time() - ts > CACHE_TTL_SECONDS:
        _cache.pop(key, None)
        return None
    return shops


def _cache_put(key: str, shops: list[dict]) -> None:
    if len(_cache) >= _CACHE_MAX:
        # Drop the oldest third rather than clearing everything.
        for old in sorted(_cache, key=lambda k: _cache[k][0])[: _CACHE_MAX // 3]:
            _cache.pop(old, None)
    _cache[key] = (time.time(), shops)


def _get_json(url: str, timeout: float) -> Any:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _post_json(url: str, data: str, timeout: float) -> Any:
    req = urllib.request.Request(
        url,
        data=data.encode("utf-8"),
        headers={
            "User-Agent": UA,
            "Accept": "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _photon_one(lat: float, lon: float, radius_m: int, tag: str, timeout: float) -> Any:
    params = urllib.parse.urlencode({
        "lat": lat,
        "lon": lon,
        # Photon takes kilometres, and it matters: a rural point returns nothing
        # without a radius and 28 results with radius=50.
        "radius": max(1, round(radius_m / 1000)),
        "limit": PHOTON_LIMIT,
        "osm_tag": tag,
    })
    return _get_json(f"{PHOTON_URL}?{params}", timeout)


def _map_photon(payload: Any, category: str, label: str) -> list[dict]:
    out = []
    for feat in (payload or {}).get("features", []):
        coords = (feat.get("geometry") or {}).get("coordinates") or []
        if len(coords) < 2:
            continue
        props = feat.get("properties") or {}
        try:
            lon, lat = float(coords[0]), float(coords[1])
        except (TypeError, ValueError):
            continue
        osm_type = OSM_TYPE.get(props.get("osm_type"), "node")
        osm_id = props.get("osm_id")
        street = " ".join(x for x in [props.get("street"), props.get("housenumber")] if x)
        out.append({
            "id": f"{osm_type}/{osm_id}",
            "osmType": osm_type,
            "osmId": osm_id,
            "name": props.get("name") or f"{label} без назви",
            "lat": lat,
            "lon": lon,
            "category": category,
            "categoryLabel": label,
            "address": street or props.get("district") or props.get("city"),
            "phone": None,
            "website": None,
            "opening": None,
            "isPartner": False,
        })
    return out


def _extract_contact(tags: dict) -> dict:
    raw = (tags.get("phone") or tags.get("contact:phone") or tags.get("contact:mobile")
           or tags.get("mobile") or tags.get("phone:mobile"))
    phone = None
    if raw:
        # OSM allows several numbers in one value; a tel: link needs one.
        phone = raw.replace(",", ";").split(";")[0].strip() or None
    return {
        "phone": phone,
        "website": tags.get("website") or tags.get("contact:website"),
        "opening": tags.get("opening_hours"),
    }


def _osm_tags(osm_type: str, osm_id: Any, timeout: float) -> dict:
    try:
        data = _get_json(f"{OSM_API}/{osm_type}/{osm_id}.json", timeout)
        return (data.get("elements") or [{}])[0].get("tags") or {}
    except Exception:
        return {}


def _overpass(lat: float, lon: float, radius_m: int, timeout: float) -> list[dict]:
    """Fallback. Slower (queue-bound) but a different operator, and it returns
    tags — including phone numbers — directly."""
    clauses = "".join(
        f'nwr["{t.split(":")[0]}"="{t.split(":")[1]}"](around:{radius_m},{lat},{lon});'
        for t, _c, _l in SERVICE_TAGS
    )
    query = f"[out:json][timeout:25];({clauses});out center 200;"
    body = urllib.parse.urlencode({"data": query})
    last = None
    for url in OVERPASS_URLS:
        try:
            payload = _post_json(url, body, timeout)
            break
        except Exception as err:      # try the next mirror
            last = err
            payload = None
    if payload is None:
        raise RuntimeError(f"all overpass mirrors failed: {last}")

    by_tag = {f"{c}:{v}": (cat, lab) for (c_v, cat, lab) in
              ((t, c, l) for t, c, l in SERVICE_TAGS)
              for c, v in [c_v.split(":")]}
    out = []
    for el in payload.get("elements", []):
        lat_v = el.get("lat") or (el.get("center") or {}).get("lat")
        lon_v = el.get("lon") or (el.get("center") or {}).get("lon")
        if lat_v is None or lon_v is None:
            continue
        tags = el.get("tags") or {}
        cat, lab = "other", "Автосервіс"
        for key in ("shop", "craft", "amenity"):
            if tags.get(key) and f"{key}:{tags[key]}" in by_tag:
                cat, lab = by_tag[f"{key}:{tags[key]}"]
                break
        contact = _extract_contact(tags)
        out.append({
            "id": f"{el.get('type')}/{el.get('id')}",
            "osmType": el.get("type"),
            "osmId": el.get("id"),
            "name": tags.get("name") or f"{lab} без назви",
            "lat": lat_v,
            "lon": lon_v,
            "category": cat,
            "categoryLabel": lab,
            "address": tags.get("addr:street"),
            "phone": contact["phone"],
            "website": contact["website"],
            "opening": contact["opening"],
            "isPartner": False,
        })
    return out


def _dedupe(lists: list[list[dict]]) -> list[dict]:
    seen, out = set(), []
    for shop in (s for group in lists for s in group):
        if shop["id"] in seen:
            continue
        seen.add(shop["id"])
        out.append(shop)
    return out


@router.get("/nearby")
async def nearby(
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=180),
    radius_m: int = Query(5000, ge=500, le=50000),
    _user: dict = Depends(require_auth),
):
    started = time.time()
    key = _cache_key(lat, lon, radius_m)

    cached = _cache_get(key)
    if cached is None:
        cached = await _db_cache_get(key)
        if cached is not None:
            _cache_put(key, cached)          # promote into the in-process cache
    if cached is not None:
        return {"shops": cached, "source": "cache", "ms": int((time.time() - started) * 1000)}

    # ── Photon first: it is a search index, so it answers in ~0.2-1.3s, where
    #    Overpass is queue-bound and measured 2.8s at best, 97s at worst.
    shops: list[dict] = []
    source = "photon"
    t_photon = time.time()
    try:
        results = await asyncio.gather(*[
            asyncio.to_thread(_photon_one, lat, lon, radius_m, tag, PHOTON_TIMEOUT)
            for tag, _cat, _lab in PRIMARY_TAGS
        ], return_exceptions=True)

        groups = []
        for (tag, cat, lab), res in zip(PRIMARY_TAGS, results):
            if isinstance(res, Exception):
                continue
            groups.append(_map_photon(res, cat, lab))
        shops = _dedupe(groups)
    except Exception:
        shops = []
    photon_ms = int((time.time() - t_photon) * 1000)

    if not shops:
        # Photon unreachable or empty — fall back to the other provider.
        source = "overpass"
        try:
            shops = await asyncio.to_thread(_overpass, lat, lon, radius_m, 25.0)
        except Exception as err:
            return {"shops": [], "source": "unavailable", "error": str(err),
                    "ms": int((time.time() - started) * 1000)}

    # Nearest first, so the head we enrich is the head the user sees.
    def _dist2(s):
        return (s["lat"] - lat) ** 2 + (s["lon"] - lon) ** 2
    shops.sort(key=_dist2)

    # ── Phone numbers. Photon carries no OSM tags, so they come from the OSM
    #    API — ~0.3s per element versus ~4.3s for the equivalent Overpass query.
    t_enrich = time.time()
    if source == "photon":
        await _enrich(shops[:ENRICH_INLINE])
    enrich_ms = int((time.time() - t_enrich) * 1000)

    _cache_put(key, shops)
    await _db_cache_put(key, shops)

    # Finish the rest without making the caller wait. The result replaces the
    # cache entry, so the next request for this area (including the app's own
    # background refresh) already has the numbers.
    if source == "photon":
        asyncio.create_task(_finish_in_background(key, lat, lon, radius_m, shops))

    return {
        "shops": shops, "source": source,
        "ms": int((time.time() - started) * 1000),
        "timing": {"search_ms": photon_ms, "phones_ms": enrich_ms},
    }


async def _enrich(shops: list[dict]) -> None:
    """Fill phone/website/opening in place, best-effort."""
    if not shops:
        return
    tags_list = await asyncio.gather(*[
        asyncio.to_thread(_osm_tags, s["osmType"], s["osmId"], 6.0) for s in shops
    ], return_exceptions=True)
    for shop, tags in zip(shops, tags_list):
        if isinstance(tags, Exception) or not tags:
            continue
        contact = _extract_contact(tags)
        shop["phone"] = contact["phone"] or shop["phone"]
        shop["website"] = contact["website"] or shop["website"]
        shop["opening"] = contact["opening"] or shop["opening"]
        if tags.get("name") and shop["name"].endswith("без назви"):
            shop["name"] = tags["name"]


async def _finish_in_background(key: str, lat: float, lon: float,
                                radius_m: int, shops: list[dict]) -> None:
    """The half of the work the caller should not wait for: the less urgent
    categories, and phone numbers beyond the first screen."""
    try:
        extra = await asyncio.gather(*[
            asyncio.to_thread(_photon_one, lat, lon, radius_m, tag, PHOTON_TIMEOUT)
            for tag, _cat, _lab in SECONDARY_TAGS
        ], return_exceptions=True)
        groups = [shops]
        for (tag, cat, lab), res in zip(SECONDARY_TAGS, extra):
            if not isinstance(res, Exception):
                groups.append(_map_photon(res, cat, lab))
        merged = _dedupe(groups)

        def _d2(s):
            return (s["lat"] - lat) ** 2 + (s["lon"] - lon) ** 2
        merged.sort(key=_d2)

        await _enrich(merged[ENRICH_INLINE:ENRICH_BACKGROUND])
        _cache_put(key, merged)
        await _db_cache_put(key, merged)
    except Exception:
        pass   # the list already works without the extras
