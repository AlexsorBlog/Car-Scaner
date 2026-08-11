"""
app/queries.py — all SQL in one place, mirrors the shape of the previous
Node/pg version 1:1 (same $1,$2... placeholders — asyncpg uses the same
native Postgres numbering as node-postgres, so the SQL barely changed).
Every function returns plain dicts (or lists of dicts), never raw
asyncpg.Record objects, so routers/serialization never has to think about it.
"""

from . import db


def _row(record):
    return dict(record) if record is not None else None


def _rows(records):
    return [dict(r) for r in records]


# ── Users ──────────────────────────────────────────────────────────────────

async def create_user(*, phone, password_hash, name, car_brand, car_model, car_year, vin, email=""):
    async with db.pool.acquire() as conn:
        record = await conn.fetchrow(
            """INSERT INTO users (phone, password_hash, name, car_brand, car_model, car_year, vin, email)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *""",
            phone, password_hash, name, car_brand, car_model, car_year, vin, email,
        )
        return _row(record)


async def get_user_by_phone(phone):
    async with db.pool.acquire() as conn:
        record = await conn.fetchrow("SELECT * FROM users WHERE phone = $1", phone)
        return _row(record)


async def get_user_by_id(user_id):
    async with db.pool.acquire() as conn:
        record = await conn.fetchrow("SELECT * FROM users WHERE id = $1", user_id)
        return _row(record)


async def update_user(*, id, name, car_brand, car_model, car_year, vin, email=""):
    async with db.pool.acquire() as conn:
        record = await conn.fetchrow(
            """UPDATE users SET name=$2, car_brand=$3, car_model=$4, car_year=$5, vin=$6, email=$7, updated_at=now()
               WHERE id=$1 RETURNING *""",
            id, name, car_brand, car_model, car_year, vin, email,
        )
        return _row(record)


# ── Perf records ─────────────────────────────────────────────────────────────

async def insert_perf_record(*, user_id, filter_key, car_brand, car_model, time_ms, distance_m, telemetry_json):
    async with db.pool.acquire() as conn:
        await conn.execute(
            """INSERT INTO perf_records (user_id,filter_key,car_brand,car_model,time_ms,distance_m,telemetry_json)
               VALUES ($1,$2,$3,$4,$5,$6,$7)""",
            user_id, filter_key, car_brand, car_model, time_ms, distance_m, telemetry_json,
        )


async def get_user_perf_records(user_id):
    async with db.pool.acquire() as conn:
        records = await conn.fetch(
            "SELECT * FROM perf_records WHERE user_id=$1 ORDER BY time_ms ASC LIMIT 50", user_id
        )
        return _rows(records)


async def prune_old_perf_records(user_id):
    async with db.pool.acquire() as conn:
        await conn.execute(
            """DELETE FROM perf_records WHERE user_id=$1 AND id NOT IN
               (SELECT id FROM perf_records WHERE user_id=$1 ORDER BY recorded_at DESC LIMIT 50)""",
            user_id,
        )


# ── Leaderboard — paginates over the same top-100-by-user set every time
# (limit/offset just page through it), brand is a partial/ILIKE search. ──────

async def leaderboard(*, filter_key, brand, limit=20, offset=0):
    async with db.pool.acquire() as conn:
        records = await conn.fetch(
            """WITH ranked AS (
                 SELECT
                   p.id, p.time_ms, p.distance_m, p.car_brand, p.car_model, p.filter_key,
                   p.recorded_at, p.telemetry_json,
                   u.id   AS user_id,
                   u.name AS user_name,
                   u.car_brand AS user_car_brand,
                   u.car_model AS user_car_model
                 FROM (
                   SELECT user_id, filter_key, MIN(time_ms) AS best_time
                   FROM perf_records
                   WHERE filter_key = $1
                     AND ($2 = '' OR car_brand ILIKE '%' || $2 || '%')
                   GROUP BY user_id, filter_key
                 ) best
                 JOIN perf_records p
                   ON  p.user_id    = best.user_id
                   AND p.filter_key = best.filter_key
                   AND p.time_ms    = best.best_time
                 JOIN users u ON u.id = p.user_id
                 ORDER BY p.time_ms ASC
                 LIMIT 100
               )
               SELECT *, COUNT(*) OVER() AS total_count
               FROM ranked
               ORDER BY time_ms ASC
               LIMIT $3 OFFSET $4""",
            filter_key, brand, limit, offset,
        )
        return _rows(records)


async def user_rank(*, filter_key, brand, user_id):
    async with db.pool.acquire() as conn:
        record = await conn.fetchrow(
            """SELECT COUNT(*) + 1 AS rank
               FROM (
                 SELECT user_id, MIN(time_ms) AS best_time
                 FROM perf_records
                 WHERE filter_key = $1
                   AND ($2 = '' OR car_brand ILIKE '%' || $2 || '%')
                 GROUP BY user_id
               ) ranked
               WHERE best_time < (
                 SELECT MIN(time_ms) FROM perf_records
                 WHERE user_id = $3 AND filter_key = $1
               )""",
            filter_key, brand, user_id,
        )
        return _row(record)


# ── Daily summaries ───────────────────────────────────────────────────────────

async def upsert_summary(*, user_id, date, avg_speed, max_speed, avg_rpm, avg_temp, avg_fuel,
                          error_codes, top_errors, distance_km):
    async with db.pool.acquire() as conn:
        await conn.execute(
            """INSERT INTO daily_summaries
                 (user_id,date,avg_speed,max_speed,avg_rpm,avg_temp,avg_fuel,error_codes,top_errors,distance_km)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
               ON CONFLICT (user_id,date) DO UPDATE SET
                 avg_speed   = excluded.avg_speed,
                 max_speed   = excluded.max_speed,
                 avg_rpm     = excluded.avg_rpm,
                 avg_temp    = excluded.avg_temp,
                 avg_fuel    = excluded.avg_fuel,
                 error_codes = excluded.error_codes,
                 top_errors  = excluded.top_errors,
                 distance_km = excluded.distance_km""",
            user_id, date, avg_speed, max_speed, avg_rpm, avg_temp, avg_fuel,
            error_codes, top_errors, distance_km,
        )


async def get_summaries(user_id):
    async with db.pool.acquire() as conn:
        records = await conn.fetch(
            "SELECT * FROM daily_summaries WHERE user_id=$1 ORDER BY date DESC LIMIT 90", user_id
        )
        return _rows(records)


# ── Chat ──────────────────────────────────────────────────────────────────────

async def insert_message(*, user_id, chat_type, role, content, content_json):
    async with db.pool.acquire() as conn:
        await conn.execute(
            """INSERT INTO chat_messages (user_id, chat_type, role, content, content_json)
               VALUES ($1,$2,$3,$4,$5)""",
            user_id, chat_type, role, content, content_json,
        )


async def get_chat_history(user_id, chat_type):
    async with db.pool.acquire() as conn:
        records = await conn.fetch(
            """SELECT * FROM chat_messages WHERE user_id=$1 AND chat_type=$2
               ORDER BY created_at ASC LIMIT 200""",
            user_id, chat_type,
        )
        return _rows(records)


async def get_all_chat_history(user_id):
    async with db.pool.acquire() as conn:
        records = await conn.fetch(
            """SELECT * FROM chat_messages WHERE user_id=$1
               ORDER BY chat_type, created_at ASC LIMIT 500""",
            user_id,
        )
        return _rows(records)


async def delete_chat_history(user_id, chat_type):
    async with db.pool.acquire() as conn:
        await conn.execute(
            "DELETE FROM chat_messages WHERE user_id=$1 AND chat_type=$2", user_id, chat_type
        )
