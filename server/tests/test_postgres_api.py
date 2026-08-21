from __future__ import annotations

import os
from datetime import UTC, date, datetime, timedelta
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.db import engine
from app.main import app

pytestmark = pytest.mark.skipif(
    os.getenv("RUN_POSTGRES_TESTS") != "1",
    reason="PostgreSQL integration tests require RUN_POSTGRES_TESTS=1",
)


def test_postgresql_contracts_match_api_validation() -> None:
    assert engine.dialect.name == "postgresql"
    app.dependency_overrides.clear()
    web = TestClient(app, raise_server_exceptions=False)
    master = {"Authorization": f"Bearer {os.environ['MASTER_TOKEN']}"}

    bootstrap = web.post(
        "/api/v1/auth/bootstrap",
        json={"master_token": os.environ["MASTER_TOKEN"], "device_label": "PostgreSQL CI"},
    )
    assert bootstrap.status_code == 200, bootstrap.text
    sessions = web.get("/api/v1/auth/sessions", headers=master)
    assert sessions.status_code == 200, sessions.text
    assert isinstance(sessions.json(), list)

    account = web.post(
        "/api/v1/accounts",
        headers={**master, "Idempotency-Key": f"account-{uuid4()}"},
        json={
            "name": f"PostgreSQL account {uuid4()}",
            "kind": "debit",
            "currency": "MXN",
            "opening_balance": "1000.00",
        },
    )
    assert account.status_code == 201, account.text
    account_id = account.json()["id"]

    transaction = web.post(
        "/api/v1/transactions/simple",
        headers={**master, "Idempotency-Key": f"transaction-{uuid4()}"},
        json={
            "occurred_on": datetime.now(UTC).date().isoformat(),
            "kind": "expense",
            "account_id": account_id,
            "amount": "25.00",
            "description": "PostgreSQL JSON transaction",
            "category": "Compatibility",
            "tags": ["postgresql", "json"],
        },
    )
    assert transaction.status_code == 201, transaction.text

    for query in (
        "limit=200",
        f"account_id={account_id}",
        "category=Compatibility",
        "query=PostgreSQL",
    ):
        response = web.get(f"/api/v1/transactions?{query}", headers=master)
        assert response.status_code == 200, response.text
        assert any(row["id"] == transaction.json()["id"] for row in response.json())

    overflow = web.post(
        "/api/v1/accounts",
        headers={**master, "Idempotency-Key": f"overflow-{uuid4()}"},
        json={
            "name": "Overflow rejected before PostgreSQL",
            "kind": "cash",
            "currency": "MXN",
            "opening_balance": "100000000000000000.00",
        },
    )
    assert overflow.status_code == 422, overflow.text

    missing_account = str(uuid4())
    recurring = web.post(
        "/api/v1/recurring",
        headers=master,
        json={
            "name": "Invalid linked account",
            "kind": "income",
            "amount": "10.00",
            "currency": "MXN",
            "cadence": "monthly",
            "next_date": datetime.now(UTC).date().isoformat(),
            "account_id": missing_account,
        },
    )
    assert recurring.status_code == 422, recurring.text

    goal = web.post(
        "/api/v1/goals",
        headers=master,
        json={
            "name": "Invalid linked goal",
            "target_amount": "10.00",
            "account_id": missing_account,
        },
    )
    assert goal.status_code == 422, goal.text


def test_postgresql_full_crud_and_reporting_surface() -> None:
    """Exercise every database-backed route family against PostgreSQL."""
    app.dependency_overrides.clear()
    web = TestClient(app, raise_server_exceptions=False)
    master = {"Authorization": f"Bearer {os.environ['MASTER_TOKEN']}"}
    suffix = uuid4().hex[:8]
    today = datetime.now(UTC).date()
    month = today.replace(day=1)

    def created(path: str, payload: dict, expected: int = 201) -> dict:
        response = web.post(path, headers=master, json=payload)
        assert response.status_code == expected, f"{path}: {response.text}"
        return response.json()

    session = web.post(
        "/api/v1/auth/bootstrap",
        json={"master_token": os.environ["MASTER_TOKEN"], "device_label": f"PostgreSQL {suffix}"},
    )
    assert session.status_code == 200, session.text
    refreshed = web.post(
        "/api/v1/auth/refresh", json={"refresh_token": session.json()["refresh_token"]}
    )
    assert refreshed.status_code == 200, refreshed.text
    codes = web.post("/api/v1/auth/recovery-codes", headers=master)
    assert codes.status_code == 200, codes.text
    recovered = web.post(
        "/api/v1/auth/recover",
        json={"recovery_code": codes.json()["codes"][0], "device_label": f"Recovered {suffix}"},
    )
    assert recovered.status_code == 200, recovered.text
    passkey_options = web.post("/api/v1/auth/passkeys/register/options", headers=master)
    assert passkey_options.status_code == 200, passkey_options.text
    assert web.get("/api/v1/auth/passkeys", headers=master).status_code == 200

    primary = created(
        "/api/v1/accounts",
        {
            "name": f"Primary {suffix}",
            "kind": "debit",
            "currency": "MXN",
            "opening_balance": "5000",
        },
    )
    secondary = created(
        "/api/v1/accounts",
        {"name": f"Savings {suffix}", "kind": "savings", "currency": "MXN", "opening_balance": "0"},
    )
    assert web.get(f"/api/v1/accounts/{primary['id']}", headers=master).status_code == 200
    assert (
        web.patch(
            f"/api/v1/accounts/{primary['id']}", headers=master, json={"alias": f"Main {suffix}"}
        ).status_code
        == 200
    )

    category = created("/api/v1/categories", {"name": f"Food {suffix}", "kind": "expense"})
    tag = created("/api/v1/tags", {"name": f"review-{suffix}"})
    expense = created(
        "/api/v1/transactions/simple",
        {
            "occurred_on": today.isoformat(),
            "kind": "expense",
            "account_id": primary["id"],
            "amount": "125.50",
            "description": f"Expense {suffix}",
            "merchant": f"Shop {suffix}",
            "category": category["name"],
            "tags": [tag["name"]],
        },
    )
    transfer = created(
        "/api/v1/transactions/simple",
        {
            "occurred_on": today.isoformat(),
            "kind": "transfer",
            "account_id": primary["id"],
            "target_account_id": secondary["id"],
            "amount": "50",
            "description": f"Transfer {suffix}",
        },
    )
    assert transfer["kind"] == "transfer"
    direct = created(
        "/api/v1/transactions",
        {
            "occurred_on": today.isoformat(),
            "description": f"Direct postings {suffix}",
            "kind": "transfer",
            "tags": ["postgresql"],
            "postings": [
                {"account_id": primary["id"], "amount": "-5", "currency": "MXN"},
                {"account_id": secondary["id"], "amount": "5", "currency": "MXN"},
            ],
        },
    )
    assert len(direct["postings"]) == 2
    assert web.get(f"/api/v1/transactions/{expense['id']}", headers=master).status_code == 200
    assert (
        web.patch(
            f"/api/v1/transactions/{expense['id']}", headers=master, json={"reconciled": True}
        ).status_code
        == 200
    )

    budget = created(
        "/api/v1/budgets",
        {
            "month": month.isoformat(),
            "category": category["name"],
            "limit_amount": "800",
            "rollover": True,
        },
    )
    budget_update = web.put(
        f"/api/v1/budgets/{budget['id']}",
        headers=master,
        json={
            "month": month.isoformat(),
            "category": category["name"],
            "limit_amount": "900",
            "rollover": True,
        },
    )
    assert budget_update.status_code == 200, budget_update.text
    target_month = date(month.year + (month.month == 12), month.month % 12 + 1, 1)
    copied = web.post(
        f"/api/v1/budgets/copy/{month.strftime('%Y-%m')}?target_month={target_month.strftime('%Y-%m')}",
        headers=master,
    )
    assert copied.status_code == 200, copied.text

    scenario_payload = {
        "name": f"Scenario {suffix}",
        "kind": "custom",
        "income_adjustment_pct": "2",
        "expense_adjustment_pct": "3",
        "one_time_adjustment": "100",
        "assumptions": {"source": "postgres"},
    }
    scenario = created("/api/v1/forecasts/scenarios", scenario_payload)
    scenario_payload["one_time_adjustment"] = "150"
    assert (
        web.put(
            f"/api/v1/forecasts/scenarios/{scenario['id']}", headers=master, json=scenario_payload
        ).status_code
        == 200
    )
    assert (
        web.get(
            f"/api/v1/forecasts?months=3&scenario=custom&scenario_id={scenario['id']}",
            headers=master,
        ).status_code
        == 200
    )

    recurring_payload = {
        "name": f"Recurring {suffix}",
        "kind": "expense",
        "amount": "80",
        "currency": "MXN",
        "cadence": "monthly",
        "next_date": (today + timedelta(days=30)).isoformat(),
        "account_id": primary["id"],
        "category": category["name"],
        "confirmed": True,
    }
    recurring = created("/api/v1/recurring", recurring_payload)
    recurring_payload["amount"] = "85"
    assert (
        web.put(
            f"/api/v1/recurring/{recurring['id']}", headers=master, json=recurring_payload
        ).status_code
        == 200
    )

    goal_payload = {
        "name": f"Goal {suffix}",
        "target_amount": "2000",
        "target_date": (today + timedelta(days=365)).isoformat(),
        "account_id": secondary["id"],
    }
    goal = created("/api/v1/goals", goal_payload)
    goal_payload["target_amount"] = "2200"
    assert (
        web.put(f"/api/v1/goals/{goal['id']}", headers=master, json=goal_payload).status_code == 200
    )

    fx = created(
        "/api/v1/fx-rates",
        {
            "currency": "USD",
            "mxn_per_unit": "18.123456",
            "effective_on": date(2099, 1, 1).isoformat(),
        },
    )
    assert fx["currency"] == "USD"
    assert (
        web.put(
            f"/api/v1/categories/{category['id']}",
            headers=master,
            json={"name": f"Dining {suffix}", "kind": "expense"},
        ).status_code
        == 200
    )
    assert (
        web.put(
            f"/api/v1/tags/{tag['id']}", headers=master, json={"name": f"checked-{suffix}"}
        ).status_code
        == 200
    )

    capture = web.post(
        "/api/v1/capture/text",
        headers={**master, "Idempotency-Key": f"capture-{suffix}"},
        json={"text": f"Gasté 42 en prueba {suffix}", "client": "pwa"},
    )
    assert capture.status_code == 202, capture.text
    import_id = capture.json()["import_id"]
    assert web.get(f"/api/v1/imports/{import_id}", headers=master).status_code == 200
    confirmation = web.post(
        f"/api/v1/imports/{import_id}/confirm-simple",
        headers=master,
        json={
            "occurred_on": today.isoformat(),
            "kind": "expense",
            "account_id": primary["id"],
            "amount": "42",
            "description": f"Imported {suffix}",
            "category": f"Dining {suffix}",
        },
    )
    assert confirmation.status_code == 200, confirmation.text
    file_capture = web.post(
        "/api/v1/capture/file",
        headers={**master, "Idempotency-Key": f"file-{suffix}"},
        files={
            "document": (
                f"statement-{suffix}.csv",
                b"date,description,amount\n2026-08-21,Test,10\n",
                "text/csv",
            )
        },
    )
    assert file_capture.status_code == 202, file_capture.text
    file_import_id = file_capture.json()["import_id"]
    file_detail = web.get(f"/api/v1/imports/{file_import_id}", headers=master)
    assert file_detail.status_code == 200, file_detail.text
    generic_confirmation = web.post(
        f"/api/v1/imports/{file_import_id}/confirm",
        headers=master,
        json={
            "transaction": {
                "occurred_on": today.isoformat(),
                "description": f"Generic import {suffix}",
                "kind": "transfer",
                "postings": [
                    {"account_id": primary["id"], "amount": "-7", "currency": "MXN"},
                    {"account_id": secondary["id"], "amount": "7", "currency": "MXN"},
                ],
            }
        },
    )
    assert generic_confirmation.status_code == 200, generic_confirmation.text

    for endpoint in (
        "/api/v1/accounts",
        "/api/v1/transactions?limit=200",
        "/api/v1/budgets",
        "/api/v1/forecasts?months=6&scenario=base",
        "/api/v1/forecasts/scenarios",
        "/api/v1/recurring",
        "/api/v1/recurring/suggestions",
        "/api/v1/goals",
        "/api/v1/fx-rates",
        "/api/v1/categories",
        "/api/v1/tags",
        "/api/v1/imports",
        "/api/v1/analytics/summary",
        "/api/v1/analytics/cash-flow?months=12",
        "/api/v1/analytics/categories",
        "/api/v1/analytics/net-worth",
        "/api/v1/admin/audit",
        "/api/v1/auth/sessions",
    ):
        response = web.get(endpoint, headers=master)
        assert response.status_code == 200, f"{endpoint}: {response.text}"

    chat = web.post("/api/v1/chat", headers=master, json={"message": "¿Cuál es mi saldo?"})
    assert chat.status_code == 200, chat.text
    shortcut = created("/api/v1/admin/shortcut-tokens", {"label": f"Shortcut {suffix}"})
    assert (
        web.delete(f"/api/v1/admin/shortcut-tokens/{shortcut['id']}", headers=master).status_code
        == 204
    )

    assert web.delete(f"/api/v1/recurring/{recurring['id']}", headers=master).status_code == 204
    assert web.delete(f"/api/v1/goals/{goal['id']}", headers=master).status_code == 204
    assert (
        web.delete(f"/api/v1/forecasts/scenarios/{scenario['id']}", headers=master).status_code
        == 204
    )
    assert web.delete(f"/api/v1/budgets/{budget['id']}", headers=master).status_code == 204
    assert (
        web.delete(f"/api/v1/budgets/{copied.json()[0]['id']}", headers=master).status_code == 204
    )
    assert web.delete(f"/api/v1/categories/{category['id']}", headers=master).status_code == 204
    assert web.delete(f"/api/v1/tags/{tag['id']}", headers=master).status_code == 204
    assert web.delete(f"/api/v1/accounts/{primary['id']}", headers=master).status_code == 204
    assert (
        web.delete(
            f"/api/v1/auth/sessions/{session.json()['session_id']}", headers=master
        ).status_code
        == 204
    )
