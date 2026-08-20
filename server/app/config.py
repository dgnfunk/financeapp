from __future__ import annotations

import base64
import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    database_url: str = os.getenv(
        "DATABASE_URL", "postgresql+psycopg://app_user@postgres:5432/app_database"
    )
    redis_url: str = os.getenv("REDIS_URL", "redis://redis:6379/0")
    master_token: str = os.getenv("MASTER_TOKEN", "change-me-before-first-use")
    document_key_b64: str = os.getenv("DOCUMENT_KEY_B64", "")
    document_dir: str = os.getenv("DOCUMENT_DIR", "/data/documents")
    ollama_url: str = os.getenv("OLLAMA_URL", "http://ollama:11434")
    ollama_model: str = os.getenv("OLLAMA_MODEL", "qwen3:4b-q4_K_M")
    max_upload_bytes: int = int(os.getenv("MAX_UPLOAD_BYTES", str(25 * 1024 * 1024)))
    max_pdf_pages: int = int(os.getenv("MAX_PDF_PAGES", "250"))
    webauthn_rp_id: str = os.getenv("WEBAUTHN_RP_ID", "localhost")
    webauthn_origin: str = os.getenv("WEBAUTHN_ORIGIN", "http://localhost:4173")

    @property
    def document_key(self) -> bytes:
        if not self.document_key_b64:
            raise RuntimeError("DOCUMENT_KEY_B64 is required for document encryption")
        key = base64.b64decode(self.document_key_b64, validate=True)
        if len(key) != 32:
            raise RuntimeError("DOCUMENT_KEY_B64 must decode to exactly 32 bytes")
        return key


settings = Settings()
