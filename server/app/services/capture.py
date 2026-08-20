from __future__ import annotations

import re
from decimal import Decimal, InvalidOperation

from ..models import Account

AMOUNT = re.compile(r"(?:\$\s*)?([0-9][0-9.,]*)")
CATEGORIES = {
    "gasolina": "Transporte",
    "uber": "Transporte",
    "metro": "Transporte",
    "super": "Supermercado",
    "chedraui": "Supermercado",
    "restaurante": "Restaurantes",
    "café": "Restaurantes",
    "cafe": "Restaurantes",
    "farmacia": "Salud",
    "internet": "Servicios",
    "luz": "Servicios",
    "renta": "Vivienda",
}


def parse_capture_text(text: str, accounts: list[Account]) -> dict:
    lowered = text.lower().strip()
    match = AMOUNT.search(lowered)
    amount = None
    if match:
        raw = match.group(1)
        normalized = raw.replace(",", "") if "." in raw else raw.replace(",", ".")
        try:
            amount = Decimal(normalized).quantize(Decimal("0.01"))
        except InvalidOperation:
            amount = None
    category = next((value for keyword, value in CATEGORIES.items() if keyword in lowered), None)
    selected = next(
        (
            account
            for account in accounts
            if (account.alias and account.alias.lower() in lowered) or account.name.lower() in lowered
        ),
        None,
    )
    if not selected and "tarjeta" in lowered:
        credit = [account for account in accounts if account.kind.value == "credit"]
        selected = credit[0] if len(credit) == 1 else None
    confidence_parts = [amount is not None, category is not None, selected is not None]
    confidence = Decimal(sum(confidence_parts)) / Decimal(len(confidence_parts))
    return {
        "kind": "expense" if any(word in lowered for word in ("gasté", "gaste", "pagué", "pague", "compré", "compre")) else "unknown",
        "description": text.strip(),
        "amount": str(amount) if amount is not None else None,
        "currency": "MXN",
        "category": category,
        "account_id": str(selected.id) if selected else None,
        "account_name": selected.alias or selected.name if selected else None,
        "requires_review": True,
        "missing_fields": [name for name, present in zip(("amount", "category", "account"), confidence_parts, strict=True) if not present],
        "confidence": str(confidence.quantize(Decimal("0.01"))),
        "untrusted_input": True,
    }
