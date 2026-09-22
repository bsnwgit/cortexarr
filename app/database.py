"""
SQLite async database engine for the Cortexarr app database
(users, settings, monitored service instances, health snapshots, audit log).
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import AsyncGenerator

import aiosqlite

from app.config import get_settings

_settings = get_settings()
DB_PATH = _settings.db_path


async def get_db() -> AsyncGenerator[aiosqlite.Connection, None]:
    """FastAPI dependency — yields an open aiosqlite connection per request."""
    async with aiosqlite.connect(DB_PATH) as conn:
        conn.row_factory = aiosqlite.Row
        await conn.execute("PRAGMA journal_mode=WAL")
        await conn.execute("PRAGMA foreign_keys=ON")
        await conn.execute("PRAGMA busy_timeout=5000")
        yield conn


async def init_db() -> None:
    """Run migrations on startup. Safe to call multiple times (idempotent SQL)."""
    migration_dir = Path(__file__).parent.parent / "migrations"
    migration_files = sorted(migration_dir.glob("*.sql"))

    async with aiosqlite.connect(DB_PATH) as conn:
        await conn.execute("PRAGMA journal_mode=WAL")
        await conn.execute("PRAGMA foreign_keys=ON")

        await conn.execute("""
            CREATE TABLE IF NOT EXISTS _migrations (
                filename TEXT PRIMARY KEY,
                applied_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
        """)
        await conn.commit()

        for mfile in migration_files:
            async with conn.execute(
                "SELECT 1 FROM _migrations WHERE filename = ?", (mfile.name,)
            ) as cur:
                already_applied = await cur.fetchone()

            if not already_applied:
                sql = mfile.read_text()
                await conn.executescript(sql)
                await conn.execute(
                    "INSERT INTO _migrations (filename) VALUES (?)", (mfile.name,)
                )
                await conn.commit()


async def seed_admin() -> None:
    """
    Create the default admin user on first boot.

    Reads the plain-text password from CORTEXARR_ADMIN_PASSWORD (set by
    install.sh, or the Docker entrypoint, to a randomly generated value if
    the operator didn't pick one). If the users table is empty and the
    password is blank, the process exits with a clear error rather than
    silently starting with no admin account.
    """
    settings = get_settings()
    admin_password = settings.admin_password

    async with aiosqlite.connect(DB_PATH) as conn:
        await conn.execute("PRAGMA journal_mode=WAL")
        cur = await conn.execute("SELECT COUNT(*) FROM users")
        row = await cur.fetchone()
        user_count = row[0] if row else 0

        if user_count > 0:
            return  # DB already has users — skip seeding

        if not admin_password:
            print(
                "\nFATAL: No users exist and CORTEXARR_ADMIN_PASSWORD is not set.\n"
                "       Set CORTEXARR_ADMIN_PASSWORD to create the initial admin account.\n"
                "       Example: CORTEXARR_ADMIN_PASSWORD=changeme python3 -m app.main\n",
                file=sys.stderr,
            )
            sys.exit(1)

        from app.auth.local import hash_password
        hashed = hash_password(admin_password)
        await conn.execute(
            "INSERT INTO users (username, email, hashed_password, role, is_default_admin) "
            "VALUES (?, ?, ?, 'admin', 1)",
            ("admin", "admin@cortexarr.local", hashed),
        )
        await conn.commit()
