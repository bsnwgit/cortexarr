#!/bin/sh
# First-boot bootstrap for the Docker image — the container equivalent of
# install.sh's steps 5/6 (generate config.yaml, init the database, seed the
# admin user), run against the /data volume instead of an install directory
# on the host. A CORTEXARR_SECRET_KEY / CORTEXARR_CREDENTIAL_KEY set as real
# env vars already overrides config.yaml either way (see app/config.py's
# priority order) — this only fills in config.yaml when nothing else will.
set -eu

CONFIG_FILE="${CORTEXARR_CONFIG:-/data/config.yaml}"

if [ ! -f "$CONFIG_FILE" ]; then
    echo "No config.yaml at $CONFIG_FILE — generating one from config.example.yaml..."
    cp /app/config.example.yaml "$CONFIG_FILE"

    SECRET=$(python3 -c "import secrets; print(secrets.token_hex(32))")
    sed -i "s/CHANGE_ME_generate_with_openssl_rand_hex_32/$SECRET/" "$CONFIG_FILE"

    CRED_KEY=$(python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())")
    sed -i "s#CHANGE_ME_generate_with_fernet_generate_key#$CRED_KEY#" "$CONFIG_FILE"

    # cors_origins is a same-origin SPA default — real value depends on how
    # this container is published (reverse proxy, host port, ...), left to
    # the operator to set for anything cross-origin (e.g. a separate API host).
    echo "  Config created. Review cors_origins in $CONFIG_FILE if the web UI"
    echo "  and API are ever served from different origins."
fi

DB_EXISTED=0
[ -f /data/cortexarr.db ] && DB_EXISTED=1

if [ "$DB_EXISTED" -eq 0 ]; then
    export CORTEXARR_ADMIN_PASSWORD="${CORTEXARR_ADMIN_PASSWORD:-$(python3 -c "import secrets; print(secrets.token_urlsafe(12))")}"
fi

python3 - <<'PYEOF'
import asyncio
from app.database import init_db, seed_admin

async def setup():
    await init_db()
    await seed_admin()

asyncio.run(setup())
PYEOF

if [ "$DB_EXISTED" -eq 0 ]; then
    echo "=================================================================="
    echo " Cortexarr admin account created"
    echo "   Username: admin"
    echo "   Password: ${CORTEXARR_ADMIN_PASSWORD}"
    echo " Save this now — it will not be shown again. Change it after login."
    echo "=================================================================="
fi

exec "$@"
