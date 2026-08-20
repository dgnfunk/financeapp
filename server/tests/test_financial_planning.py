from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.db import Base
from app.main import budget_view
from app.models import Account, AccountKind, Budget, ForecastScenario, RecurringRule, SavingsGoal
from app.schemas import SimpleSplit, SimpleTransactionIn
from app.services.forecast import forecast_from_db
from app.services.ledger import account_balance, create_simple_transaction


def database() -> Session:
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    return Session(engine)


def test_credit_expense_and_payment_keep_double_entry() -> None:
    db = database()
    today = datetime.now(UTC).date()
    card = Account(
        name="Platinum",
        kind=AccountKind.credit,
        currency="MXN",
        credit_limit=Decimal(20000),
    )
    debit = Account(name="Débito", kind=AccountKind.debit, currency="MXN")
    db.add_all([card, debit])
    db.flush()

    expense = create_simple_transaction(
        db,
        SimpleTransactionIn(
            occurred_on=today,
            kind="expense",
            account_id=card.id,
            amount=Decimal(542),
            description="Supermercado",
            category="Supermercado",
        ),
    )
    payment = create_simple_transaction(
        db,
        SimpleTransactionIn(
            occurred_on=today,
            kind="debt_payment",
            account_id=debit.id,
            target_account_id=card.id,
            amount=Decimal(200),
            description="Pago de tarjeta",
        ),
    )
    db.commit()

    assert sum((posting.amount for posting in expense.postings), Decimal(0)) == 0
    assert sum((posting.amount for posting in payment.postings), Decimal(0)) == 0
    assert account_balance(db, card) == Decimal(-342)
    assert account_balance(db, debit) == Decimal(-200)


def test_split_expense_updates_budget_execution() -> None:
    db = database()
    today = datetime.now(UTC).date()
    debit = Account(name="Débito", kind=AccountKind.debit, currency="MXN")
    db.add(debit)
    db.flush()
    month = today.replace(day=1)
    budget = Budget(
        month=month,
        category="Supermercado",
        limit_amount=Decimal(1000),
        rollover=False,
    )
    db.add(budget)
    create_simple_transaction(
        db,
        SimpleTransactionIn(
            occurred_on=today,
            kind="expense",
            account_id=debit.id,
            amount=Decimal(300),
            description="Compra dividida",
            splits=[
                SimpleSplit(category="Supermercado", amount=Decimal(250)),
                SimpleSplit(category="Hogar", amount=Decimal(50)),
            ],
        ),
    )
    db.commit()

    result = budget_view(db, budget)
    assert result["used"] == Decimal(250)
    assert result["available"] == Decimal(750)
    assert result["percent_used"] == Decimal("25.00")


def test_positive_rollover_accumulates_across_months() -> None:
    db = database()
    budgets = [
        Budget(
            month=date(2026, month, 1),
            category="Comida",
            limit_amount=Decimal(1000),
            rollover=True,
        )
        for month in (1, 2, 3)
    ]
    db.add_all(budgets)
    db.commit()

    assert budget_view(db, budgets[1])["rollover_amount"] == Decimal(1000)
    assert budget_view(db, budgets[2])["rollover_amount"] == Decimal(2000)


def test_manual_investment_valuation_is_auditable() -> None:
    db = database()
    today = datetime.now(UTC).date()
    investment = Account(
        name="Casa de bolsa",
        kind=AccountKind.investment,
        currency="MXN",
        opening_balance=Decimal(10000),
    )
    db.add(investment)
    db.flush()
    transaction = create_simple_transaction(
        db,
        SimpleTransactionIn(
            occurred_on=today,
            kind="valuation",
            account_id=investment.id,
            amount=Decimal(10850),
            description="Valuación manual",
        ),
    )
    db.commit()

    assert transaction.kind == "valuation"
    assert account_balance(db, investment) == Decimal(10850)
    assert sum((posting.amount for posting in transaction.postings), Decimal(0)) == 0


def test_forecast_uses_confirmed_recurring_budget_goal_and_custom_scenario() -> None:
    db = database()
    today = datetime.now(UTC).date()
    debit = Account(
        name="Débito",
        kind=AccountKind.debit,
        currency="MXN",
        opening_balance=Decimal(10000),
    )
    db.add(debit)
    db.flush()
    db.add_all(
        [
            RecurringRule(
                name="Nómina",
                kind="income",
                amount=Decimal(20000),
                cadence="monthly",
                next_date=today,
                confirmed=True,
            ),
            RecurringRule(
                name="Renta",
                kind="expense",
                amount=Decimal(7000),
                cadence="monthly",
                next_date=today,
                confirmed=True,
            ),
            Budget(
                month=today.replace(day=1),
                category="General",
                limit_amount=Decimal(10000),
                rollover=False,
            ),
            SavingsGoal(
                name="Emergencia",
                target_amount=Decimal(22000),
                target_date=(datetime.now(UTC) + timedelta(days=365)).date(),
                account_id=debit.id,
            ),
        ]
    )
    scenario = ForecastScenario(
        name="Mudanza",
        income_adjustment_pct=Decimal(0),
        expense_adjustment_pct=Decimal(10),
        one_time_adjustment=Decimal(-2000),
        assumptions={"event": "mudanza"},
    )
    db.add(scenario)
    db.commit()

    base = forecast_from_db(db, 3, "base")
    custom = forecast_from_db(db, 3, "custom", scenario.id)
    assert base["monthly_income"] == Decimal("20000.00")
    assert base["monthly_expenses"] > Decimal(10000)
    assert custom["points"][-1]["balance"] < base["points"][-1]["balance"]
    assert custom["assumptions"] == {"event": "mudanza"}
