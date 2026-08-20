from uuid import uuid4

from app.models import Account, AccountKind
from app.services.capture import parse_capture_text


def test_spanish_capture_extracts_amount_category_and_unique_card() -> None:
    card = Account(id=uuid4(), name="Platinum", alias="tarjeta azul", kind=AccountKind.credit)
    proposal = parse_capture_text("Gasté 430 en gasolina con la tarjeta azul", [card])
    assert proposal["amount"] == "430.00"
    assert proposal["category"] == "Transporte"
    assert proposal["account_id"] == str(card.id)
    assert proposal["missing_fields"] == []
    assert proposal["requires_review"] is True


def test_capture_reports_ambiguous_fields_instead_of_inventing() -> None:
    proposal = parse_capture_text("Pagué algo ayer", [])
    assert proposal["amount"] is None
    assert set(proposal["missing_fields"]) == {"amount", "category", "account"}
