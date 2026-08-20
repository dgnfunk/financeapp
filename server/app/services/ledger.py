from __future__ import annotations

from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import Account, AccountKind, AuditEvent, Posting, Transaction
from ..schemas import PostingIn, SimpleTransactionIn, TransactionCreate


def account_balance(db: Session, account: Account) -> Decimal:
    posted = db.scalar(
        select(func.coalesce(func.sum(Posting.amount), 0)).where(Posting.account_id == account.id)
    )
    return Decimal(account.opening_balance) + Decimal(posted or 0)


def ensure_internal_account(
    db: Session, kind: AccountKind, currency: str, name: str | None = None
) -> Account:
    account = db.scalar(
        select(Account).where(
            Account.kind == kind,
            Account.currency == currency,
            Account.is_internal.is_(True),
        )
    )
    if account:
        return account
    account = Account(
        name=name or f"Sistema · {kind.value}",
        kind=kind,
        currency=currency,
        is_internal=True,
    )
    db.add(account)
    db.flush()
    return account


def create_transaction(
    db: Session, payload: TransactionCreate, actor: str = "owner"
) -> Transaction:
    account_ids = {posting.account_id for posting in payload.postings}
    found = set(db.scalars(select(Account.id).where(Account.id.in_(account_ids))).all())
    if found != account_ids:
        raise ValueError("one or more accounts do not exist")

    totals: dict[str, Decimal] = {}
    for posting in payload.postings:
        totals[posting.currency] = totals.get(posting.currency, Decimal(0)) + posting.amount
    if any(total != Decimal(0) for total in totals.values()):
        raise ValueError("transaction is not balanced")

    transaction = Transaction(
        occurred_on=payload.occurred_on,
        description=payload.description,
        merchant=payload.merchant,
        category=payload.category,
        note=payload.note,
        reference=payload.reference,
        source=payload.source,
        kind=payload.kind,
        reconciled=payload.reconciled,
        tags=payload.tags,
    )
    transaction.postings = [Posting(**posting.model_dump()) for posting in payload.postings]
    db.add(transaction)
    db.flush()
    db.add(AuditEvent(action="transaction.created", actor=actor, target_id=str(transaction.id)))
    return transaction


def create_simple_transaction(
    db: Session, payload: SimpleTransactionIn, actor: str = "owner"
) -> Transaction:
    account = db.get(Account, payload.account_id)
    if not account or account.archived_at is not None or account.is_internal:
        raise ValueError("source account does not exist or is unavailable")
    currency = account.currency
    postings: list[PostingIn] = []

    if payload.kind in ("transfer", "debt_payment"):
        target = db.get(Account, payload.target_account_id)
        if not target or target.archived_at is not None or target.currency != currency:
            raise ValueError("target account must exist and use the same currency")
        postings = [
            PostingIn(account_id=account.id, amount=-payload.amount, currency=currency),
            PostingIn(account_id=target.id, amount=payload.amount, currency=currency),
        ]
    elif payload.kind == "income":
        counterparty = ensure_internal_account(db, AccountKind.income, currency)
        postings = [
            PostingIn(account_id=account.id, amount=payload.amount, currency=currency),
            PostingIn(
                account_id=counterparty.id,
                amount=-payload.amount,
                currency=currency,
                category=payload.category,
            ),
        ]
    elif payload.kind == "valuation":
        if account.kind != AccountKind.investment:
            raise ValueError("valuation adjustments require an investment account")
        current = account_balance(db, account)
        delta = payload.amount - current
        if delta == 0:
            raise ValueError("valuation already matches the requested amount")
        counterparty = ensure_internal_account(db, AccountKind.equity, currency)
        postings = [
            PostingIn(account_id=account.id, amount=delta, currency=currency),
            PostingIn(account_id=counterparty.id, amount=-delta, currency=currency),
        ]
    else:
        counterparty = ensure_internal_account(db, AccountKind.expense, currency)
        postings.append(PostingIn(account_id=account.id, amount=-payload.amount, currency=currency))
        if payload.splits:
            postings.extend(
                PostingIn(
                    account_id=counterparty.id,
                    amount=part.amount,
                    currency=currency,
                    category=part.category,
                )
                for part in payload.splits
            )
        else:
            postings.append(
                PostingIn(
                    account_id=counterparty.id,
                    amount=payload.amount,
                    currency=currency,
                    category=payload.category,
                )
            )

    transaction_payload = TransactionCreate(
        occurred_on=payload.occurred_on,
        description=payload.description,
        merchant=payload.merchant,
        category=payload.category,
        note=payload.note,
        source="manual",
        kind=payload.kind,
        reconciled=payload.reconciled,
        tags=payload.tags,
        postings=postings,
    )
    return create_transaction(db, transaction_payload, actor)
