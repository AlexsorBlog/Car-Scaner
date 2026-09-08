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


async def update_avatar(*, id, avatar_base64, avatar_mime):
    async with db.pool.acquire() as conn:
        record = await conn.fetchrow(
            """UPDATE users SET avatar_base64=$2, avatar_mime=$3, updated_at=now()
               WHERE id=$1 RETURNING *""",
            id, avatar_base64, avatar_mime,
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


# Best (lowest time_ms) run per filter_key for one user — used by the public
# profile view so every leaderboard entry can show a full breakdown, not just
# the top-3 the leaderboard list itself keeps light.
async def get_user_best_records(user_id):
    async with db.pool.acquire() as conn:
        records = await conn.fetch(
            """SELECT DISTINCT ON (filter_key) *
               FROM perf_records
               WHERE user_id = $1
               ORDER BY filter_key, time_ms ASC""",
            user_id,
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


# ── Activity / usage tracking ──────────────────────────────────────────────

async def touch_last_seen(user_id):
    """Cheap per-request activity stamp — drives 'active users' in the panel."""
    async with db.pool.acquire() as conn:
        await conn.execute(
            "UPDATE users SET last_seen_at = now() WHERE id = $1", user_id
        )


async def log_activity(user_id, action, detail=None):
    async with db.pool.acquire() as conn:
        await conn.execute(
            "INSERT INTO activity_log (user_id, action, detail) VALUES ($1, $2, $3)",
            user_id, action, detail,
        )


async def record_api_usage(*, user_id, model, prompt_tokens, completion_tokens,
                           total_tokens, had_image=False, kind="chat"):
    async with db.pool.acquire() as conn:
        await conn.execute(
            """INSERT INTO api_usage
                 (user_id, kind, model, prompt_tokens, completion_tokens,
                  total_tokens, had_image)
               VALUES ($1,$2,$3,$4,$5,$6,$7)""",
            user_id, kind, model, prompt_tokens, completion_tokens,
            total_tokens, had_image,
        )


# ── Admin ──────────────────────────────────────────────────────────────────

async def admin_stats():
    """Everything the dashboard header needs, in one round trip per metric."""
    async with db.pool.acquire() as conn:
        users = await conn.fetchrow(
            """SELECT
                 count(*)                                                   AS total,
                 count(*) FILTER (WHERE last_seen_at > now() - interval '24 hours') AS active_24h,
                 count(*) FILTER (WHERE last_seen_at > now() - interval '7 days')    AS active_7d,
                 count(*) FILTER (WHERE created_at   > now() - interval '7 days')    AS new_7d,
                 count(*) FILTER (WHERE is_blocked)                                  AS blocked,
                 count(*) FILTER (WHERE is_admin)                                    AS admins
               FROM users"""
        )
        tokens = await conn.fetchrow(
            """SELECT
                 coalesce(sum(total_tokens), 0)                                          AS total,
                 coalesce(sum(total_tokens) FILTER (WHERE created_at > now() - interval '24 hours'), 0) AS today,
                 coalesce(sum(total_tokens) FILTER (WHERE created_at > now() - interval '7 days'), 0)   AS week,
                 coalesce(sum(prompt_tokens), 0)                                         AS prompt,
                 coalesce(sum(completion_tokens), 0)                                     AS completion,
                 count(*)                                                                AS requests
               FROM api_usage"""
        )
        content = await conn.fetchrow(
            """SELECT
                 (SELECT count(*) FROM chat_messages)  AS messages,
                 (SELECT count(*) FROM perf_records)   AS perf_records,
                 (SELECT count(*) FROM activity_log
                    WHERE created_at > now() - interval '24 hours') AS actions_24h"""
        )
        return {
            "users": dict(users),
            "tokens": dict(tokens),
            "content": dict(content),
        }


async def admin_list_users(*, search="", limit=50, offset=0):
    """
    One row per user with their usage rolled up. LEFT JOINs so a user with no
    chat/usage history still appears (they'd vanish with inner joins).
    """
    async with db.pool.acquire() as conn:
        records = await conn.fetch(
            """
            SELECT u.id, u.phone, u.name, u.email, u.car_brand, u.car_model,
                   u.car_year, u.vin, u.is_admin, u.is_blocked,
                   u.created_at, u.last_seen_at,
                   coalesce(t.total_tokens, 0) AS total_tokens,
                   coalesce(t.requests, 0)     AS ai_requests,
                   coalesce(m.messages, 0)     AS messages,
                   coalesce(p.runs, 0)         AS perf_runs,
                   count(*) OVER()             AS total_count
              FROM users u
              LEFT JOIN (SELECT user_id, sum(total_tokens) AS total_tokens,
                                count(*) AS requests
                           FROM api_usage GROUP BY user_id) t ON t.user_id = u.id
              LEFT JOIN (SELECT user_id, count(*) AS messages
                           FROM chat_messages GROUP BY user_id) m ON m.user_id = u.id
              LEFT JOIN (SELECT user_id, count(*) AS runs
                           FROM perf_records GROUP BY user_id) p ON p.user_id = u.id
             WHERE ($1 = '' OR u.phone ILIKE '%'||$1||'%' OR u.name ILIKE '%'||$1||'%'
                    OR u.email ILIKE '%'||$1||'%')
             ORDER BY u.last_seen_at DESC NULLS LAST, u.id DESC
             LIMIT $2 OFFSET $3
            """,
            search, limit, offset,
        )
        return _rows(records)


async def admin_set_password(user_id, password_hash):
    async with db.pool.acquire() as conn:
        result = await conn.execute(
            "UPDATE users SET password_hash=$2, updated_at=now() WHERE id=$1",
            user_id, password_hash,
        )
        return result.endswith("1")


async def admin_set_flag(user_id, field, value):
    if field not in ("is_admin", "is_blocked"):
        raise ValueError("unsupported flag")
    async with db.pool.acquire() as conn:
        result = await conn.execute(
            f"UPDATE users SET {field}=$2, updated_at=now() WHERE id=$1",
            user_id, value,
        )
        return result.endswith("1")


async def admin_delete_user(user_id):
    async with db.pool.acquire() as conn:
        result = await conn.execute("DELETE FROM users WHERE id=$1", user_id)
        return result.endswith("1")


async def admin_usage_series(days=14):
    """Daily token spend + request counts, for the trend chart."""
    async with db.pool.acquire() as conn:
        records = await conn.fetch(
            """SELECT date_trunc('day', created_at) AS day,
                      sum(total_tokens)             AS tokens,
                      count(*)                      AS requests
                 FROM api_usage
                WHERE created_at > now() - ($1 || ' days')::interval
                GROUP BY 1 ORDER BY 1""",
            str(days),
        )
        return _rows(records)


async def admin_recent_activity(limit=100):
    async with db.pool.acquire() as conn:
        records = await conn.fetch(
            """SELECT a.id, a.action, a.detail, a.created_at,
                      u.id AS user_id, u.name, u.phone
                 FROM activity_log a
                 LEFT JOIN users u ON u.id = a.user_id
                ORDER BY a.created_at DESC LIMIT $1""",
            limit,
        )
        return _rows(records)


async def bootstrap_admins(phones):
    """
    Promote the phone numbers listed in ADMIN_PHONES to admin on startup.
    This is the only way the first admin can exist — there is no self-serve
    path to privilege, by design.
    """
    if not phones:
        return []
    async with db.pool.acquire() as conn:
        records = await conn.fetch(
            "UPDATE users SET is_admin = TRUE WHERE phone = ANY($1::text[]) RETURNING phone",
            phones,
        )
        return [r["phone"] for r in records]
