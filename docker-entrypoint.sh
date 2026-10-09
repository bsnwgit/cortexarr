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

# Self-update inside Docker writes a release to /data/release (the image's
# own files can't be changed). Run it instead of the image's code when it is
# newer and actually starts; after a rebuild with newer code the image wins
# again. Delete /data/release to go back to the image's code.
RELEASE_DIR=/data/release
if [ -f "$RELEASE_DIR/VERSION" ] && [ -f "$RELEASE_DIR/app/main.py" ]; then
    NEWER=$(python3 - <<'PYEOF'
def key(path):
    try:
        return tuple(int(x) for x in open(path).read().strip().split(".")[:3])
    except (OSError, ValueError):
        return (0, 0, 0)

print("yes" if key("/data/release/VERSION") > key("/app/VERSION") else "no")
PYEOF
)
    if [ "$NEWER" = "yes" ]; then
        if (cd "$RELEASE_DIR" && python3 -c "import app.main" >/dev/null 2>&1); then
            cd "$RELEASE_DIR"
            echo "Running release $(cat VERSION) from $RELEASE_DIR"
        else
            echo "Release in $RELEASE_DIR doesn't start — running the image's code instead."
        fi
    fi
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
