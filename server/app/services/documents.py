from __future__ import annotations

import csv
import hashlib
import io
import json
import os
import re
import uuid
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from defusedxml import ElementTree

ALLOWED_MIME = {
    "application/pdf",
    "application/xml",
    "text/xml",
    "text/csv",
    "image/jpeg",
    "image/png",
    "image/heic",
    "image/heif",
}
EXECUTABLE_MAGIC = (b"MZ", b"\x7fELF", b"#!")


def sniff_kind(data: bytes) -> str:
    head = data[:32].lstrip()
    if data.startswith(EXECUTABLE_MAGIC):
        raise ValueError("executable content is not accepted")
    if data.startswith(b"%PDF-"):
        return "pdf"
    if data.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if len(data) >= 12 and data[4:8] == b"ftyp" and data[8:12] in {
        b"heic",
        b"heix",
        b"hevc",
        b"hevx",
        b"mif1",
        b"msf1",
    }:
        return "heic"
    if head.startswith(b"<"):
        return "xml"
    try:
        data[:4096].decode("utf-8")
        return "csv"
    except UnicodeDecodeError as exc:
        raise ValueError("unsupported or disguised file") from exc


def safe_name(filename: str) -> str:
    basename = Path(filename).name
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", basename).strip(".-")
    return cleaned[:160] or "document"


def encrypt_document(data: bytes, key: bytes, directory: str) -> tuple[str, str]:
    digest = hashlib.sha256(data).hexdigest()
    nonce = os.urandom(12)
    ciphertext = AESGCM(key).encrypt(nonce, data, digest.encode())
    target_dir = Path(directory)
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / f"{uuid.uuid4().hex}.aesgcm"
    target.write_bytes(nonce + ciphertext)
    return digest, str(target)


def decrypt_document(path: str, digest: str, key: bytes) -> bytes:
    encrypted = Path(path).read_bytes()
    if len(encrypted) < 13:
        raise ValueError("encrypted document is truncated")
    return AESGCM(key).decrypt(encrypted[:12], encrypted[12:], digest.encode())


def parse_xml_cfdi(data: bytes) -> dict:
    root = ElementTree.fromstring(data)
    attrs = {key.split("}")[-1]: value for key, value in root.attrib.items()}
    concepts = []
    for node in root.iter():
        if node.tag.split("}")[-1] == "Concepto":
            concepts.append(
                {
                    "description": node.attrib.get("Descripcion"),
                    "amount": node.attrib.get("Importe"),
                }
            )
    return {
        "kind": "cfdi",
        "date": attrs.get("Fecha"),
        "currency": attrs.get("Moneda", "MXN"),
        "total": attrs.get("Total"),
        "reference": attrs.get("Folio"),
        "concepts": concepts,
    }


def parse_csv(data: bytes) -> dict:
    text = data.decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(text))
    rows = [dict(row) for row in reader]
    return {"kind": "csv", "rows": rows[:5000], "row_count": len(rows)}


def deterministic_extract(kind: str, data: bytes) -> str | None:
    if kind == "xml":
        return json.dumps(parse_xml_cfdi(data), ensure_ascii=False)
    if kind == "csv":
        return json.dumps(parse_csv(data), ensure_ascii=False)
    return None
