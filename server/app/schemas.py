from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, Field, model_validator

from .models import AccountKind


class AccountIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    alias: str | None = Field(default=None, max_length=120)
    kind: AccountKind
    currency: str = Field(default="MXN", min_length=3, max_length=3)
    opening_balance: Decimal = Field(default=Decimal(0), max_digits=18, decimal_places=2)
    institution: str | None = Field(default=None, max_length=120)
    last_four: str | None = Field(default=None, pattern=r"^\d{4}$")
    credit_limit: Decimal | None = Field(default=None, gt=0, max_digits=18, decimal_places=2)
    statement_day: int | None = Field(default=None, ge=1, le=31)
    due_day: int | None = Field(default=None, ge=1, le=31)


class AccountUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    alias: str | None = Field(default=None, max_length=120)
    institution: str | None = Field(default=None, max_length=120)
    last_four: str | None = Field(default=None, pattern=r"^\d{4}$")
    credit_limit: Decimal | None = Field(default=None, gt=0, max_digits=18, decimal_places=2)
    statement_day: int | None = Field(default=None, ge=1, le=31)
    due_day: int | None = Field(default=None, ge=1, le=31)


class AccountOut(AccountIn):
    id: UUID
    balance: Decimal = Decimal(0)
    credit_available: Decimal | None = None
    utilization_pct: Decimal | None = None
    archived_at: datetime | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


class PostingIn(BaseModel):
    account_id: UUID
    amount: Decimal = Field(max_digits=18, decimal_places=2)
    currency: str = Field(default="MXN", min_length=3, max_length=3)
    category: str | None = Field(default=None, max_length=120)


class PostingOut(PostingIn):
    id: UUID

    model_config = {"from_attributes": True}


class TransactionCreate(BaseModel):
    occurred_on: date
    description: str = Field(min_length=1, max_length=240)
    merchant: str | None = Field(default=None, max_length=160)
    category: str | None = Field(default=None, max_length=120)
    note: str | None = None
    reference: str | None = Field(default=None, max_length=160)
    source: str = "manual"
    kind: str = "general"
    reconciled: bool = False
    tags: list[str] = []
    postings: list[PostingIn] = Field(min_length=2)

    @model_validator(mode="after")
    def balanced(self) -> TransactionCreate:
        by_currency: dict[str, Decimal] = {}
        for posting in self.postings:
            by_currency[posting.currency] = (
                by_currency.get(posting.currency, Decimal(0)) + posting.amount
            )
        if any(total != 0 for total in by_currency.values()):
            raise ValueError("postings must balance to zero for every currency")
        return self


class TransactionOut(BaseModel):
    id: UUID
    occurred_on: date
    description: str
    merchant: str | None
    category: str | None
    note: str | None
    reference: str | None
    source: str
    kind: str
    reconciled: bool
    tags: list[str]
    postings: list[PostingOut] = []
    created_at: datetime

    model_config = {"from_attributes": True}


class CaptureTextIn(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    client: Literal["pwa", "shortcut", "chat"] = "pwa"


class CaptureOut(BaseModel):
    import_id: UUID
    status: str
    review_url: str


class BudgetIn(BaseModel):
    month: date
    category: str = Field(min_length=1, max_length=120)
    limit_amount: Decimal = Field(gt=0, max_digits=18, decimal_places=2)
    rollover: bool = False


class BudgetOut(BudgetIn):
    id: UUID
    used: Decimal = Decimal(0)
    rollover_amount: Decimal = Decimal(0)
    available: Decimal = Decimal(0)
    percent_used: Decimal = Decimal(0)
    status: Literal["healthy", "warning", "over"] = "healthy"


class SimpleSplit(BaseModel):
    category: str = Field(min_length=1, max_length=120)
    amount: Decimal = Field(gt=0, max_digits=18, decimal_places=2)


class SimpleTransactionIn(BaseModel):
    occurred_on: date
    kind: Literal["expense", "income", "transfer", "debt_payment", "valuation"]
    account_id: UUID
    target_account_id: UUID | None = None
    amount: Decimal = Field(gt=0, max_digits=18, decimal_places=2)
    description: str = Field(min_length=1, max_length=240)
    merchant: str | None = Field(default=None, max_length=160)
    category: str | None = Field(default=None, max_length=120)
    note: str | None = None
    tags: list[str] = []
    splits: list[SimpleSplit] = []
    reconciled: bool = False

    @model_validator(mode="after")
    def validate_shape(self) -> SimpleTransactionIn:
        if self.kind in ("transfer", "debt_payment") and not self.target_account_id:
            raise ValueError("target_account_id is required for transfers and debt payments")
        if self.splits and sum((part.amount for part in self.splits), Decimal(0)) != self.amount:
            raise ValueError("split amounts must equal the transaction amount")
        return self


class TransactionUpdate(BaseModel):
    occurred_on: date | None = None
    description: str | None = Field(default=None, min_length=1, max_length=240)
    merchant: str | None = Field(default=None, max_length=160)
    category: str | None = Field(default=None, max_length=120)
    note: str | None = None
    reference: str | None = Field(default=None, max_length=160)
    reconciled: bool | None = None
    tags: list[str] | None = None


class NamedEntityIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    kind: Literal["expense", "income"] = "expense"
    color: str | None = Field(default=None, max_length=20)


class TagIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class RecurringRuleIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    kind: Literal["income", "expense", "debt_payment"]
    amount: Decimal = Field(gt=0, max_digits=18, decimal_places=2)
    currency: str = Field(default="MXN", min_length=3, max_length=3)
    cadence: Literal["weekly", "biweekly", "monthly", "yearly"] = "monthly"
    next_date: date
    account_id: UUID | None = None
    counterparty_account_id: UUID | None = None
    category: str | None = Field(default=None, max_length=120)
    active: bool = True
    confirmed: bool = False


class GoalIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    target_amount: Decimal = Field(gt=0, max_digits=18, decimal_places=2)
    target_date: date | None = None
    account_id: UUID | None = None
    active: bool = True


class FxRateIn(BaseModel):
    currency: str = Field(min_length=3, max_length=3)
    mxn_per_unit: Decimal = Field(gt=0, max_digits=18, decimal_places=6)
    effective_on: date


class ScenarioIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    kind: Literal["custom"] = "custom"
    income_adjustment_pct: Decimal = Field(
        default=Decimal(0), ge=-100, le=500, max_digits=8, decimal_places=4
    )
    expense_adjustment_pct: Decimal = Field(
        default=Decimal(0), ge=-100, le=500, max_digits=8, decimal_places=4
    )
    one_time_adjustment: Decimal = Field(
        default=Decimal(0), max_digits=18, decimal_places=2
    )
    assumptions: dict[str, Any] = {}


class ForecastPoint(BaseModel):
    month: str
    balance: Decimal
    income: Decimal
    expenses: Decimal


class ChatIn(BaseModel):
    message: str = Field(min_length=1, max_length=4000)


class ChatProposal(BaseModel):
    kind: Literal["answer", "create_transaction", "create_budget", "update_transaction"]
    message: str
    requires_confirmation: bool = False
    proposed_action: dict | None = None


class ShortcutTokenCreate(BaseModel):
    label: str = Field(min_length=1, max_length=100)


class ShortcutTokenOut(BaseModel):
    id: UUID
    label: str
    token: str
    scope: Literal["capture:create"] = "capture:create"


class ImportConfirm(BaseModel):
    transaction: TransactionCreate


class BootstrapSessionIn(BaseModel):
    master_token: str = Field(min_length=8)
    device_label: str = Field(default="Dispositivo personal", min_length=1, max_length=120)


class RefreshSessionIn(BaseModel):
    refresh_token: str = Field(min_length=20)


class RecoveryLoginIn(BaseModel):
    recovery_code: str = Field(min_length=8)
    device_label: str = Field(default="Dispositivo recuperado", min_length=1, max_length=120)


class SessionOut(BaseModel):
    access_token: str
    refresh_token: str
    expires_in: int
    session_id: UUID


class PasskeyRegistrationIn(BaseModel):
    challenge_id: UUID
    label: str = Field(default="Passkey personal", min_length=1, max_length=120)
    credential: dict[str, Any]


class PasskeyAuthenticationIn(BaseModel):
    challenge_id: UUID
    device_label: str = Field(default="Dispositivo con passkey", min_length=1, max_length=120)
    credential: dict[str, Any]
