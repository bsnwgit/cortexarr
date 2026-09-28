"""
Cortexarr configuration.

Priority order (highest -> lowest):
  1. Environment variables  (CORTEXARR_*)
  2. config.yaml — found via $CORTEXARR_CONFIG, $CORTEXARR_INSTALL_DIR/config.yaml,
     ./config.yaml, or ~/.cortexarr/config.yaml
  3. Defaults defined here

No path in this file is hardcoded to a specific install location. Every
on-disk path (db_path, log_file, ...) defaults to somewhere under
`install_dir` — the directory install.sh (or $CORTEXARR_INSTALL_DIR) was
pointed at — so the app works the same whether it's installed at
/opt/cortexarr, in a Docker container, in-place in a repo checkout, or
anywhere else.

Runtime settings (monitored service instances, notification rules, poll
intervals, retention, etc.) are stored in SQLite, not in this file. This
file only covers startup/infrastructure settings that must be known before
the database is connected.
"""
from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path
from typing import Literal, Optional

import yaml
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


def _find_config_path() -> Optional[Path]:
    """Try known config file locations, in priority order."""
    candidates = [Path("config.yaml")]
    install_dir = os.environ.get("CORTEXARR_INSTALL_DIR")
    if install_dir:
        candidates.insert(0, Path(install_dir) / "config.yaml")
    candidates.append(Path.home() / ".cortexarr" / "config.yaml")

    env_path = os.environ.get("CORTEXARR_CONFIG")
    if env_path:
        candidates.insert(0, Path(env_path))

    for path in candidates:
        if path.exists():
            return path
    return None


def _load_yaml(path: Optional[Path]) -> dict:
    if path is None:
        return {}
    with path.open() as f:
        return yaml.safe_load(f) or {}


def _default_install_dir(config_path: Optional[Path]) -> Path:
    """The app root: everything else defaults to a path under this."""
    env_dir = os.environ.get("CORTEXARR_INSTALL_DIR")
    if env_dir:
        return Path(env_dir)
    if config_path is not None:
        return config_path.resolve().parent
    return Path.cwd()


_CONFIG_PATH = _find_config_path()
_yaml_cfg = _load_yaml(_CONFIG_PATH)
_INSTALL_DIR = _default_install_dir(_CONFIG_PATH)

# TLS is decided before this settings object even exists (uvicorn binds its
# socket with it), so it can't wait for the SQLite-backed settings the rest
# of the app uses — see app/tls_state.py.
from app import tls_state as _tls_state  # noqa: E402 — needs _INSTALL_DIR above first

_TLS_ENABLED_DEFAULT = _tls_state.read_enabled(str(_INSTALL_DIR))
_TLS_CERTFILE_DEFAULT, _TLS_KEYFILE_DEFAULT = (str(p) for p in _tls_state.cert_paths(str(_INSTALL_DIR)))


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="CORTEXARR_",
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # -- Server --------------------------------------------------------------
    host: str = Field(default=_yaml_cfg.get("host", "0.0.0.0"))
    port: int = Field(default=_yaml_cfg.get("port", 8770))
    workers: int = Field(default=_yaml_cfg.get("workers", 2))
    debug: bool = Field(default=_yaml_cfg.get("debug", False))

    # -- HTTPS — set via Settings → Server (app/api/server_tls.py), not
    # config.yaml, since it's managed by the app itself. A CORTEXARR_TLS_*
    # env var still overrides it, same as everything else here.
    tls_enabled: bool = Field(default=_TLS_ENABLED_DEFAULT)
    tls_certfile: str = Field(default=_TLS_CERTFILE_DEFAULT)
    tls_keyfile: str = Field(default=_TLS_KEYFILE_DEFAULT)

    # -- App root — every other path below defaults to somewhere under this --
    install_dir: str = Field(default=_yaml_cfg.get("install_dir", str(_INSTALL_DIR)))

    # -- First-boot admin seed -------------------------------------------------
    # Set by install.sh (or the Docker entrypoint) from CORTEXARR_ADMIN_PASSWORD;
    # ignored if the DB already has users.
    admin_password: str = Field(default="")

    # -- App database (SQLite) ------------------------------------------------
    db_path: str = Field(
        default=_yaml_cfg.get("db_path", str(_INSTALL_DIR / "cortexarr.db"))
    )

    # -- JWT -------------------------------------------------------------------
    secret_key: str = Field(
        default=_yaml_cfg.get("secret_key", "CHANGE_ME_IN_PRODUCTION_secret_key_32chars")
    )
    algorithm: Literal["HS256", "HS384", "HS512"] = "HS256"
    access_token_expire_minutes: int = 15
    refresh_token_expire_days: int = 7

    # -- CORS --------------------------------------------------------------------
    # Fail closed: with no cors_origins configured, allow no cross-origin
    # requests rather than "*". The SPA is same-origin so it is unaffected.
    cors_origins: list[str] = Field(default=_yaml_cfg.get("cors_origins", []))

    # -- Fernet key for encrypting monitored-service API keys and notification
    # provider secrets at rest -----------------------------------------------
    credential_key: str = Field(default=_yaml_cfg.get("credential_key", ""))

    # -- Logging -------------------------------------------------------------------
    log_level: str = Field(default=_yaml_cfg.get("log_level", "info"))
    log_file: str = Field(
        default=_yaml_cfg.get("log_file", str(_INSTALL_DIR / "logs" / "cortexarr.log"))
    )


@lru_cache
def get_settings() -> Settings:
    """Startup/infra settings from yaml + env. Cached — these don't change
    without a restart."""
    return Settings()
