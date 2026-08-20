from __future__ import annotations

from calendar import monthrange
from datetime import UTC, date, datetime
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import (
    Account,
    Budget,
    ForecastScenario,
    FxRate,
    RecurringRule,
    SavingsGoal,
)
from .ledger import account_balance


def add_months(value: date, months: int) -> date:
    raw = value.month - 1 + months
    year = value.year + raw // 12
    month = raw % 12 + 1
    return date(year, month, min(value.day, monthrange(year, month)[1]))


def project(
    opening: Decimal,
    monthly_income: Decimal,
    monthly_expenses: Decimal,
    months: int,
    scenario: str,
) -> list[dict]:
    expense_factor = {"base": Decimal(1), "conservative": Decimal("1.10")}.get(scenario, Decimal(1))
    balance = opening
    points = []
    for offset in range(1, months + 1):
        expenses = (monthly_expenses * expense_factor).quantize(Decimal("0.01"))
        balance += monthly_income - expenses
        points.append(
            {
                "month": add_months(datetime.now(UTC).date().replace(day=1), offset).isoformat(),
                "balance": balance,
                "income": monthly_income,
                "expenses": expenses,
            }
        )
    return points


def _monthly_amount(amount: Decimal, cadence: str) -> Decimal:
    factors = {
        "weekly": Decimal(52) / Decimal(12),
        "biweekly": Decimal(26) / Decimal(12),
        "monthly": Decimal(1),
        "yearly": Decimal(1) / Decimal(12),
    }
    return (amount * factors.get(cadence, Decimal(1))).quantize(Decimal("0.01"))


def _latest_fx(db: Session, currency: str) -> Decimal:
    if currency == "MXN":
        return Decimal(1)
    rate = db.scalar(
        select(FxRate)
        .where(FxRate.currency == currency)
        .order_by(FxRate.effective_on.desc())
        .limit(1)
    )
    return Decimal(rate.mxn_per_unit) if rate else Decimal(0)


def forecast_from_db(
    db: Session,
    months: int,
    scenario_kind: str,
    scenario_id=None,
) -> dict:
    visible_accounts = db.scalars(
        select(Account).where(Account.is_internal.is_(False), Account.archived_at.is_(None))
    ).all()
    opening = sum(
        (account_balance(db, account) * _latest_fx(db, account.currency) for account in visible_accounts),
        Decimal(0),
    )

    rules = db.scalars(
        select(RecurringRule).where(
            RecurringRule.active.is_(True), RecurringRule.confirmed.is_(True)
        )
    ).all()
    income = sum(
        (_monthly_amount(Decimal(rule.amount), rule.cadence) for rule in rules if rule.kind == "income"),
        Decimal(0),
    )
    recurring_expenses = sum(
        (
            _monthly_amount(Decimal(rule.amount), rule.cadence)
            for rule in rules
            if rule.kind in ("expense", "debt_payment")
        ),
        Decimal(0),
    )
    current_month = datetime.now(UTC).date().replace(day=1)
    budget_total = sum(
        (
            Decimal(value)
            for value in db.scalars(
                select(Budget.limit_amount).where(Budget.month == current_month)
            ).all()
        ),
        Decimal(0),
    )
    expenses = max(recurring_expenses, budget_total)

    goals = db.scalars(select(SavingsGoal).where(SavingsGoal.active.is_(True))).all()
    monthly_goal_allocation = Decimal(0)
    today = datetime.now(UTC).date()
    for goal in goals:
        if not goal.target_date:
            continue
        account = db.get(Account, goal.account_id) if goal.account_id else None
        current = max(account_balance(db, account), Decimal(0)) if account else Decimal(0)
        gap = max(Decimal(goal.target_amount) - current, Decimal(0))
        months_left = max(
            1,
            (goal.target_date.year - today.year) * 12 + goal.target_date.month - today.month,
        )
        monthly_goal_allocation += (gap / Decimal(months_left)).quantize(Decimal("0.01"))

    income_pct = Decimal(0)
    expense_pct = Decimal(0)
    one_time = Decimal(0)
    scenario_name = scenario_kind.capitalize()
    assumptions: dict = {}
    if scenario_kind == "conservative":
        income_pct = Decimal(-5)
        expense_pct = Decimal(10)
        assumptions = {"income_adjustment_pct": -5, "expense_adjustment_pct": 10}
    elif scenario_kind == "custom":
        scenario = db.get(ForecastScenario, scenario_id) if scenario_id else None
        if not scenario:
            raise ValueError("custom scenario_id is required")
        scenario_name = scenario.name
        income_pct = Decimal(scenario.income_adjustment_pct)
        expense_pct = Decimal(scenario.expense_adjustment_pct)
        one_time = Decimal(scenario.one_time_adjustment)
        assumptions = dict(scenario.assumptions or {})

    adjusted_income = (income * (Decimal(1) + income_pct / Decimal(100))).quantize(
        Decimal("0.01")
    )
    adjusted_expenses = (
        (expenses + monthly_goal_allocation) * (Decimal(1) + expense_pct / Decimal(100))
    ).quantize(Decimal("0.01"))
    points = project(opening + one_time, adjusted_income, adjusted_expenses, months, "base")
    return {
        "scenario": scenario_kind,
        "name": scenario_name,
        "generated_at": datetime.now(UTC).isoformat(),
        "opening_balance": opening,
        "monthly_income": adjusted_income,
        "monthly_expenses": adjusted_expenses,
        "monthly_goal_allocation": monthly_goal_allocation,
        "assumptions": assumptions,
        "points": points,
    }
