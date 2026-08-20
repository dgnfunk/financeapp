from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from dataclasses import dataclass
from uuid import UUID

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import settings
from .db import get_db
from .models import DeviceSession, ShortcutToken


@dataclass(frozen=True)
class Principal:
    actor: str
    scopes: frozenset[str]


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def bearer_value(authorization: str | None) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Bearer token required")
    return authorization.removeprefix("Bearer ").strip()


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _unb64(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def create_access_token(session_id: UUID, lifetime_seconds: int = 900) -> str:
    payload = _b64(
        json.dumps(
            {"sid": str(session_id), "exp": int(time.time()) + lifetime_seconds},
            separators=(",", ":"),
        ).encode()
    )
    signature = _b64(
        hmac.new(settings.master_token.encode(), payload.encode(), hashlib.sha256).digest()
    )
    return f"{payload}.{signature}"


def verify_access_token(token: str, db: Session) -> DeviceSession | None:
    try:
        payload, signature = token.split(".", 1)
        expected = _b64(
            hmac.new(settings.master_token.encode(), payload.encode(), hashlib.sha256).digest()
        )
        if not hmac.compare_digest(signature, expected):
            return None
        decoded = json.loads(_unb64(payload))
        if int(decoded["exp"]) <= int(time.time()):
            return None
        session = db.get(DeviceSession, UUID(decoded["sid"]))
        if not session or session.revoked_at is not None:
            return None
        return session
    except (ValueError, KeyError, json.JSONDecodeError):
        return None


def require_owner(
    authorization: str | None = Header(default=None), db: Session = Depends(get_db)
) -> Principal:
    supplied = bearer_value(authorization)
    if hmac.compare_digest(supplied, settings.master_token):
        return Principal("owner:bootstrap", frozenset({"*"}))
    session = verify_access_token(supplied, db)
    if not session:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired credentials")
    return Principal(f"session:{session.id}", frozenset({"*"}))


def require_capture(
    authorization: str | None = Header(default=None), db: Session = Depends(get_db)
) -> Principal:
    supplied = bearer_value(authorization)
    if hmac.compare_digest(supplied, settings.master_token):
        return Principal("owner", frozenset({"*"}))
    session = verify_access_token(supplied, db)
    if session:
        return Principal(f"session:{session.id}", frozenset({"*"}))
    record = db.scalar(
        select(ShortcutToken).where(ShortcutToken.token_hash == hash_token(supplied))
    )
    if not record or record.revoked_at is not None or record.scope != "capture:create":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Token cannot create captures")
    return Principal(f"shortcut:{record.id}", frozenset({"capture:create"}))
