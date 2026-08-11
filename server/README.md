# CarSense API Server

FastAPI + PostgreSQL backend for CarSense mobile app. (Ported from an
earlier Express/Node version — routes, request/response shapes and the SQL
schema are unchanged, so the mobile app needed zero changes.)

## Setup

```bash
cd server
python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
# Edit .env: set DB_*, JWT_SECRET and OPENAI_API_KEY
python run.py
```

For local dev with auto-reload: `RELOAD=true python run.py`.

## Environment variables

| Variable | Description |
|---|---|
| `PORT` | Server port (default 3000) |
| `DB_USER` / `DB_PASSWORD` / `DB_HOST` / `DB_PORT` / `DB_NAME` | PostgreSQL connection |
| `JWT_SECRET` | Long random string for JWT signing |
| `OPENAI_API_KEY` | Your OpenAI API key (for GPT-4o) |
| `MAX_UPLOAD_MB` | Max image upload size (default 10) |

## API endpoints

### Auth
- `POST /api/auth/register` — `{ phone, password, name, car_brand?, car_model?, car_year?, vin?, email? }`
- `POST /api/auth/login`    — `{ phone, password }` → `{ token, user }`
- `GET  /api/auth/profile`  — requires Bearer token
- `PUT  /api/auth/profile`  — `{ name, car_brand?, car_model?, car_year?, vin?, email? }` (omitted fields keep their current value)

### Performance
- `POST /api/perf`                    — `{ filter_key, time_ms, distance_m, telemetry[] }`
- `GET  /api/perf/mine`               — own records
- `GET  /api/perf/leaderboard?filter=0-100&brand=BMW&offset=0&limit=20` — paginated global board

### Daily summary
- `POST /api/summary` — `{ date, avg_speed, max_speed, avg_rpm, avg_temp, avg_fuel, error_codes[], distance_km }`
- `GET  /api/summary` — own last 90 days

### Chat (GPT-4o)
- `POST /api/chat`         — `{ message, chat_type }` or multipart with `image` file
- `GET  /api/chat?type=main|issue|photo`
- `DELETE /api/chat?type=main`

All error responses are `{ "error": "message" }` (matching what the mobile
app's `services/api.js` reads), regardless of whether the failure came from
validation, auth, rate limiting, or a 404.

## Deploy to a VPS

```bash
# Install Python 3.11+
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt

# Run with a process manager, e.g. systemd or pm2:
pm2 start "venv/bin/python run.py" --name carsense-api --interpreter none

# Nginx/tunnel proxy → this process on $PORT
```

## Client setup

Add to mobile app `.env`:
```
VITE_API_URL=https://your-server.com
```
