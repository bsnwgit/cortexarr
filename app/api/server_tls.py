"""
/api/server/tls — whether Cortexarr's own HTTP server speaks HTTPS, and the
certificate it uses. The web UI, the rest of the API, and the MCP server at
/mcp all share one listener, so this is one scheme for the whole app, not
just /mcp — added because a remote MCP client refuses to connect to a
plain-HTTP endpoint.

TLS has to be decided before uvicorn binds its socket, so turning it on/off
or replacing the certificate never takes effect until the service is
restarted — same as any other startup setting. See app/tls_state.py for
where it's actually stored.
"""
from __future__ import annotations

from datetime import datetime, timezone

import aiosqlite
from cryptography import x509
from cryptography.hazmat.primitives import serialization
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from app import audit, tls_state
from app.config import get_settings
from app.database import get_db
from app.dependencies import AdminUser

router = APIRouter()


def _cert_meta() -> dict:
    settings = get_settings()
    certfile, keyfile = tls_state.cert_paths(settings.install_dir)
    if not (certfile.exists() and keyfile.exists()):
        return {"has_certificate": False, "subject": None, "not_after": None, "expired": False}
    try:
        cert = x509.load_pem_x509_certificate(certfile.read_bytes())
    except ValueError:
        return {"has_certificate": False, "subject": None, "not_after": None, "expired": False}
    not_after = cert.not_valid_after_utc
    return {
        "has_certificate": True,
        "subject": cert.subject.rfc4514_string(),
        "not_after": not_after.isoformat(),
        "expired": not_after < datetime.now(timezone.utc),
    }


def _status() -> dict:
    settings = get_settings()
    pending = tls_state.read_enabled(settings.install_dir)
    return {
        "active_enabled": settings.tls_enabled,
        "pending_enabled": pending,
        "restart_required": pending != settings.tls_enabled,
        **_cert_meta(),
    }


@router.get("/tls")
async def get_tls(admin: AdminUser):
    return _status()


class CertificateIn(BaseModel):
    certificate: str
    private_key: str


@router.post("/tls/certificate")
async def upload_certificate(body: CertificateIn, admin: AdminUser, db: aiosqlite.Connection = Depends(get_db)):
    settings = get_settings()
    try:
        cert = x509.load_pem_x509_certificate(body.certificate.encode())
    except ValueError:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Not a valid PEM certificate")
    try:
        key = serialization.load_pem_private_key(body.private_key.encode(), password=None)
    except (ValueError, TypeError):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail="Not a valid, unencrypted PEM private key")
    if key.public_key().public_numbers() != cert.public_key().public_numbers():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="The certificate and private key don't match")
    not_after = cert.not_valid_after_utc
    if not_after < datetime.now(timezone.utc):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"That certificate expired on {not_after.date()}")

    tls_state.save_certificate(settings.install_dir, body.certificate, body.private_key)
    await audit.record(db, user=admin, action="server.tls_certificate", target_type="server",
                       detail={"subject": cert.subject.rfc4514_string(), "not_after": not_after.isoformat()})
    return _status()


class TlsEnabledIn(BaseModel):
    enabled: bool


@router.put("/tls/enabled")
async def set_tls_enabled(body: TlsEnabledIn, admin: AdminUser, db: aiosqlite.Connection = Depends(get_db)):
    meta = _cert_meta()
    if body.enabled:
        if not meta["has_certificate"]:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Upload a certificate first")
        if meta["expired"]:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                                detail="That certificate has expired — upload a current one first")
    settings = get_settings()
    tls_state.write_enabled(settings.install_dir, body.enabled)
    await audit.record(db, user=admin, action="server.tls_enabled", target_type="server", detail={"enabled": body.enabled})
    return _status()


@router.delete("/tls/certificate")
async def delete_certificate(admin: AdminUser, db: aiosqlite.Connection = Depends(get_db)):
    settings = get_settings()
    tls_state.remove_certificate(settings.install_dir)
    await audit.record(db, user=admin, action="server.tls_certificate_remove", target_type="server")
    return _status()
