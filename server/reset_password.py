#!/usr/bin/env python3
"""
reset_password.py — set a user's password directly, from the server.

Passwords are bcrypt-hashed and cannot be read back, so a forgotten password
can only be RESET, never recovered. There is no self-serve reset flow (no SMS
or email provider wired up), and the admin panel can't help if the account you
lost access to IS the admin — hence this script.

Usage (run on the server, from the `server/` directory):

    venv/bin/python reset_password.py +380970416212

It prompts for the new password twice, without echoing. To see who exists
first:

    venv/bin/python reset_password.py --list

Passing the password as an argument is supported but discouraged — it lands in
your shell history and is visible in `ps` to other users on the box:

    venv/bin/python reset_password.py +380970416212 --password 'NewPass123'
"""

import argparse
import asyncio
import getpass
import os
import sys

import asyncpg
import bcrypt
from dotenv import load_dotenv

load_dotenv()

# User names are Ukrainian, so listing accounts prints Cyrillic. Windows
# consoles default to cp1252 and raise UnicodeEncodeError on it; Linux is
# already UTF-8, so this is a no-op there.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass  # non-reconfigurable stream (piped/redirected) — leave as-is

MIN_LENGTH = 6


def db_config():
    try:
        return {
            "user": os.environ["DB_USER"],
            "password": os.environ["DB_PASSWORD"],
            "host": os.environ["DB_HOST"],
            "port": int(os.environ["DB_PORT"]),
            "database": os.environ["DB_NAME"],
        }
    except KeyError as missing:
        sys.exit(f"Missing {missing} in .env — run this from the server/ directory.")


async def list_users():
    conn = await asyncpg.connect(**db_config())
    try:
        rows = await conn.fetch(
            """SELECT id, phone, name, is_admin, is_blocked, last_seen_at
                 FROM users ORDER BY id"""
        )
        if not rows:
            print("No users registered yet.")
            return
        print(f"{'ID':>4}  {'PHONE':<18} {'NAME':<22} FLAGS")
        for r in rows:
            flags = " ".join(
                f for f in (
                    "ADMIN" if r["is_admin"] else "",
                    "BLOCKED" if r["is_blocked"] else "",
                ) if f
            )
            print(f"{r['id']:>4}  {r['phone']:<18} {(r['name'] or '-'):<22} {flags}")
    finally:
        await conn.close()


async def reset(phone: str, password: str):
    conn = await asyncpg.connect(**db_config())
    try:
        user = await conn.fetchrow(
            "SELECT id, name, is_admin FROM users WHERE phone = $1", phone
        )
        if not user:
            # Deliberately explicit here — unlike the login endpoint, this is a
            # local admin tool, so being vague helps nobody.
            sys.exit(f"No user with phone {phone}. Run with --list to see accounts.")

        # Same cost factor the app uses (app/auth.py), so hashes stay uniform.
        password_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt(10)).decode()
        await conn.execute(
            "UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1",
            user["id"], password_hash,
        )

        # Leave a trail, same as an admin-initiated reset would.
        try:
            await conn.execute(
                """INSERT INTO activity_log (user_id, action, detail)
                   VALUES ($1, 'auth.password_reset_cli', 'reset via reset_password.py')""",
                user["id"],
            )
        except Exception:
            pass  # activity_log may not exist on an older schema — not fatal

        who = user["name"] or phone
        admin_note = " (admin)" if user["is_admin"] else ""
        print(f"OK: password updated for {who}{admin_note} - id {user['id']}")
        print("  Log in with the new password; existing tokens remain valid.")
    finally:
        await conn.close()


def main():
    parser = argparse.ArgumentParser(description="Reset a CarSense user's password.")
    parser.add_argument("phone", nargs="?", help="Phone number, e.g. +380970416212")
    parser.add_argument("--password", help="New password (discouraged — ends up in shell history)")
    parser.add_argument("--list", action="store_true", help="List accounts and exit")
    args = parser.parse_args()

    if args.list:
        asyncio.run(list_users())
        return

    if not args.phone:
        parser.error("phone is required (or use --list)")

    password = args.password
    if not password:
        password = getpass.getpass("New password: ")
        if password != getpass.getpass("Repeat password: "):
            sys.exit("Passwords do not match.")

    if len(password) < MIN_LENGTH:
        sys.exit(f"Password must be at least {MIN_LENGTH} characters.")

    asyncio.run(reset(args.phone, password))


if __name__ == "__main__":
    main()
