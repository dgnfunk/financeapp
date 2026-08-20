from datetime import date
from decimal import Decimal
from uuid import uuid4

import pytest
from pydantic import ValidationError

from app.schemas import PostingIn, TransactionCreate


def test_transaction_requires_balanced_postings() -> None:
    account_a = uuid4()
    account_b = uuid4()
    payload = TransactionCreate(
        occurred_on=date(2026, 8, 18),
        description="Supermercado",
        postings=[
            PostingIn(account_id=account_a, amount=Decimal("-542.00")),
            PostingIn(account_id=account_b, amount=Decimal("542.00")),
        ],
    )
    assert sum(posting.amount for posting in payload.postings) == 0


def test_unbalanced_transaction_is_rejected() -> None:
    with pytest.raises(ValidationError):
        TransactionCreate(
            occurred_on=date(2026, 8, 18),
            description="Inválido",
            postings=[
                PostingIn(account_id=uuid4(), amount=Decimal("-100.00")),
                PostingIn(account_id=uuid4(), amount=Decimal("99.00")),
            ],
        )
