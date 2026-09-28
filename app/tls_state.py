"""
Whether Cortexarr's own HTTP server listens with TLS, and where its
certificate lives. uvicorn needs this decided before it binds its socket —
too early for the SQLite-backed settings the rest of the app uses — so it's
a tiny file next to config.yaml instead, the same way install.sh manages
config.yaml itself. See app/config.py for how it's read at startup.

Cert/key always live at <install_dir>/certs/server.{crt,key} — one pair,
not a path setting — so there's nothing to get wrong beyond "is a valid
pair uploaded" and "is TLS turned on".
"""
from __future__ import annotations

import json
import os
import stat
from pathlib import Path


def cert_paths(install_dir: str) -> tuple[Path, Path]:
    certs_dir = Path(install_dir) / "certs"
    return certs_dir / "server.crt", certs_dir / "server.key"


def _state_path(install_dir: str) -> Path:
    return Path(install_dir) / "tls_state.json"


def read_enabled(install_dir: str) -> bool:
    path = _state_path(install_dir)
    if not path.exists():
        return False
    try:
        return bool(json.loads(path.read_text()).get("enabled"))
    except (json.JSONDecodeError, OSError):
        return False


def write_enabled(install_dir: str, enabled: bool) -> None:
    _state_path(install_dir).write_text(json.dumps({"enabled": enabled}))


def save_certificate(install_dir: str, certificate_pem: str, private_key_pem: str) -> None:
    certfile, keyfile = cert_paths(install_dir)
    certfile.parent.mkdir(parents=True, exist_ok=True)
    keyfile.write_text(private_key_pem)
    os.chmod(keyfile, stat.S_IRUSR | stat.S_IWUSR)  # 0600 — private key, this user only
    certfile.write_text(certificate_pem)
    os.chmod(certfile, stat.S_IRUSR | stat.S_IWUSR | stat.S_IRGRP | stat.S_IROTH)  # 0644, public cert


def remove_certificate(install_dir: str) -> None:
    certfile, keyfile = cert_paths(install_dir)
    certfile.unlink(missing_ok=True)
    keyfile.unlink(missing_ok=True)
    write_enabled(install_dir, False)
