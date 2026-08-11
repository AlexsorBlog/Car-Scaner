"""
app/db.py — PostgreSQL setup via asyncpg.
Schema is created/patched here on startup (no separate migrations for MVP).
"""

import json
import os

import asyncpg

pool: asyncpg.Pool | None = None

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  phone         VARCHAR(20) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL DEFAULT '',
  name          TEXT NOT NULL DEFAULT '',
  car_brand     TEXT NOT NULL DEFAULT '',
  car_model     TEXT NOT NULL DEFAULT '',
  car_year      INTEGER,
  vin           TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Patch columns in case an older users table already exists locally
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS car_brand     TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS car_model     TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS car_year      INTEGER;
ALTER TABLE users ADD COLUMN IF NOT EXISTS vin           TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at    TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE users ADD COLUMN IF NOT EXISTS email         TEXT NOT NULL DEFAULT '';

-- Some environments still have created_at as a leftover TIMESTAMP (no tz)
-- from a much older schema version — CREATE TABLE IF NOT EXISTS never
-- touches an already-existing table, so this self-heals it idempotently.
DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'created_at') = 'timestamp without time zone' THEN
    ALTER TABLE users ALTER COLUMN created_at
      TYPE TIMESTAMPTZ USING created_at AT TIME ZONE current_setting('TIMEZONE');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS perf_records (
  id             SERIAL PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filter_key     TEXT NOT NULL,
  car_brand      TEXT NOT NULL DEFAULT '',
  car_model      TEXT NOT NULL DEFAULT '',
  time_ms        INTEGER NOT NULL,
  distance_m     REAL NOT NULL DEFAULT 0,
  telemetry_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  recorded_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_perf_user   ON perf_records(user_id);
CREATE INDEX IF NOT EXISTS idx_perf_filter ON perf_records(filter_key);
CREATE INDEX IF NOT EXISTS idx_perf_brand  ON perf_records(car_brand);
CREATE INDEX IF NOT EXISTS idx_perf_time   ON perf_records(time_ms);

CREATE TABLE IF NOT EXISTS daily_summaries (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date        TEXT NOT NULL,
  avg_speed   REAL,
  max_speed   REAL,
  avg_rpm     REAL,
  avg_temp    REAL,
  avg_fuel    REAL,
  error_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
  top_errors  JSONB NOT NULL DEFAULT '[]'::jsonb,
  distance_km REAL NOT NULL DEFAULT 0,
  UNIQUE(user_id, date)
);
CREATE INDEX IF NOT EXISTS idx_summary_user ON daily_summaries(user_id, date);

CREATE TABLE IF NOT EXISTS chat_messages (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_type    TEXT NOT NULL DEFAULT 'main',
  role         TEXT NOT NULL,
  content      TEXT NOT NULL,
  content_json JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chat_user ON chat_messages(user_id, chat_type, created_at);
"""


async def _init_connection(conn: asyncpg.Connection) -> None:
    # asyncpg doesn't auto-decode jsonb like node-postgres does — wire up a
    # codec so every jsonb column round-trips as plain Python objects.
    await conn.set_type_codec(
        "jsonb", encoder=json.dumps, decoder=json.loads, schema="pg_catalog"
    )


async def _ensure_database_exists() -> None:
    # A fresh Postgres install has the target database missing entirely
    # (CREATE DATABASE can't run against a database that doesn't exist yet),
    # so check/create it via a connection to the always-present "postgres"
    # maintenance database first.
    db_name = os.environ["DB_NAME"]
    conn = await asyncpg.connect(
        user=os.environ["DB_USER"],
        password=os.environ["DB_PASSWORD"],
        host=os.environ["DB_HOST"],
        port=int(os.environ["DB_PORT"]),
        database="postgres",
    )
    try:
        exists = await conn.fetchval("SELECT 1 FROM pg_database WHERE datname = $1", db_name)
        if not exists:
            await conn.execute(f'CREATE DATABASE "{db_name}"')
            print(f"[DB] Created missing database '{db_name}'")
    finally:
        await conn.close()


async def init_db() -> None:
    global pool
    await _ensure_database_exists()
    pool = await asyncpg.create_pool(
        user=os.environ["DB_USER"],
        password=os.environ["DB_PASSWORD"],
        host=os.environ["DB_HOST"],
        port=int(os.environ["DB_PORT"]),
        database=os.environ["DB_NAME"],
        init=_init_connection,
    )
    async with pool.acquire() as conn:
        await conn.execute(SCHEMA_SQL)
    print("[DB] PostgreSQL ready, schema up to date")


async def close_db() -> None:
    global pool
    if pool is not None:
        await pool.close()
        pool = None
