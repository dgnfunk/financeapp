from collections.abc import Generator
from datetime import UTC, datetime

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.db import Base, get_db
from app.main import app


def client() -> TestClient:
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)

    def database() -> Generator[Session, None, None]:
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_db] = database
    return TestClient(app)


def owner_headers() -> dict[str, str]:
    return {"Authorization": "Bearer change-me-before-first-use"}


def test_account_budget_transaction_and_analytics_flow() -> None:
    web = client()
    debit = web.post(
        "/api/v1/accounts",
        headers={**owner_headers(), "Idempotency-Key": "account-debit"},
        json={
            "name": "Débito",
            "kind": "debit",
            "currency": "MXN",
            "opening_balance": "1000",
        },
    )
    assert debit.status_code == 201, debit.text
    account_id = debit.json()["id"]

    month = datetime.now(UTC).date().replace(day=1).isoformat()
    budget = web.post(
        "/api/v1/budgets",
        headers={**owner_headers(), "Idempotency-Key": "budget-food"},
        json={
            "month": month,
            "category": "Comida",
            "limit_amount": "500",
            "rollover": True,
        },
    )
    assert budget.status_code == 201, budget.text

    transaction = web.post(
        "/api/v1/transactions/simple",
        headers={**owner_headers(), "Idempotency-Key": "tx-food"},
        json={
            "occurred_on": datetime.now(UTC).date().isoformat(),
            "kind": "expense",
            "account_id": account_id,
            "amount": "125",
            "description": "Comida",
            "category": "Comida",
        },
    )
    assert transaction.status_code == 201, transaction.text
    assert len(transaction.json()["postings"]) == 2

    execution = web.get(
        f"/api/v1/budgets?month={month[:7]}", headers=owner_headers()
    )
    assert execution.status_code == 200
    assert execution.json()[0]["used"] == "125.00"
    assert execution.json()[0]["available"] == "375.00"

    summary = web.get("/api/v1/analytics/summary", headers=owner_headers())
    assert summary.status_code == 200
    assert summary.json()["expenses_month"] == "125.00"
    assert summary.json()["transaction_count"] == 1


def test_bootstrap_refresh_and_session_revocation() -> None:
    web = client()
    bootstrap = web.post(
        "/api/v1/auth/bootstrap",
        json={"master_token": "change-me-before-first-use", "device_label": "Test"},
    )
    assert bootstrap.status_code == 200, bootstrap.text
    body = bootstrap.json()
    access_headers = {"Authorization": f"Bearer {body['access_token']}"}
    assert web.get("/api/v1/accounts", headers=access_headers).status_code == 200

    refreshed = web.post(
        "/api/v1/auth/refresh", json={"refresh_token": body["refresh_token"]}
    )
    assert refreshed.status_code == 200
    assert refreshed.json()["refresh_token"] != body["refresh_token"]

    revoked = web.delete(
        f"/api/v1/auth/sessions/{body['session_id']}", headers=owner_headers()
    )
    assert revoked.status_code == 204
    assert web.get("/api/v1/accounts", headers=access_headers).status_code == 401


def test_passkey_registration_requires_owner_and_returns_short_lived_challenge() -> None:
    web = client()
    assert web.post("/api/v1/auth/passkeys/register/options").status_code == 401
    options = web.post(
        "/api/v1/auth/passkeys/register/options", headers=owner_headers()
    )
    assert options.status_code == 200, options.text
    body = options.json()
    assert body["rp"]["id"] == "localhost"
    assert body["user"]["name"] == "propietario"
    assert body["challenge_id"]
    assert web.post("/api/v1/auth/passkeys/authenticate/options").status_code == 409
