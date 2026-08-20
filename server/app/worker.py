from __future__ import annotations

import io
import json
import tempfile
from pathlib import Path
from uuid import UUID

from pypdf import PdfReader
from redis import Redis
from sqlalchemy.orm import Session

from .config import settings
from .db import engine
from .models import AuditEvent, ImportJob, ImportStatus
from .services.documents import decrypt_document


def pdf_text(data: bytes) -> str:
    reader = PdfReader(io.BytesIO(data))
    if len(reader.pages) > settings.max_pdf_pages:
        raise ValueError("PDF exceeds page limit")
    return "\n".join(page.extract_text() or "" for page in reader.pages).strip()


def local_ocr(data: bytes, suffix: str) -> str:
    try:
        from rapidocr_onnxruntime import RapidOCR
    except ImportError:
        return ""
    with tempfile.NamedTemporaryFile(suffix=suffix) as source:
        source.write(data)
        source.flush()
        result, _ = RapidOCR()(source.name)
    return "\n".join(item[1] for item in result or [])


def docling_text(data: bytes, suffix: str) -> str:
    try:
        from docling.document_converter import DocumentConverter
    except ImportError:
        return ""
    with tempfile.NamedTemporaryFile(suffix=suffix) as source:
        source.write(data)
        source.flush()
        result = DocumentConverter().convert(source.name)
    return result.document.export_to_markdown().strip()


def process(import_id: str) -> None:
    with Session(engine) as db:
        job = db.get(ImportJob, UUID(import_id))
        if not job or not job.encrypted_path or not job.sha256:
            return
        job.status = ImportStatus.processing
        db.commit()
        try:
            data = decrypt_document(job.encrypted_path, job.sha256, settings.document_key)
            text = pdf_text(data) if job.source_kind == "pdf" else ""
            if not text:
                suffix = Path(job.original_name or "scan.png").suffix or ".png"
                text = docling_text(data, suffix)
            if not text:
                suffix = Path(job.original_name or "scan.png").suffix or ".png"
                text = local_ocr(data, suffix)
            if not text:
                raise RuntimeError("OCR profile is required for this document")
            job.extracted_text = text[:500_000]
            job.proposal_json = json.dumps(
                {"untrusted_document_text": True, "requires_review": True}, ensure_ascii=False
            )
            job.confidence = 0.70
            job.status = ImportStatus.review
            db.add(AuditEvent(action="import.processed", actor="worker", target_id=str(job.id)))
        except Exception as exc:  # noqa: BLE001 - worker boundary sanitizes and continues
            job.status = ImportStatus.failed
            job.error = type(exc).__name__
            db.add(AuditEvent(action="import.failed", actor="worker", target_id=str(job.id)))
        db.commit()


def run() -> None:
    redis = Redis.from_url(settings.redis_url, decode_responses=True)
    while True:
        item = redis.blpop("finance:document-jobs", timeout=10)
        if item:
            process(item[1])


if __name__ == "__main__":
    run()
