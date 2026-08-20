"""financial planning and secure sessions

Revision ID: c73e4f9a0d21
Revises: b5d29aa14ef1
Create Date: 2026-08-19
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "c73e4f9a0d21"
down_revision: str | Sequence[str] | None = "b5d29aa14ef1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE accountkind ADD VALUE IF NOT EXISTS 'investment'")
        op.execute("ALTER TYPE accountkind ADD VALUE IF NOT EXISTS 'equity'")

    op.add_column("accounts", sa.Column("alias", sa.String(120), nullable=True))
    op.add_column("accounts", sa.Column("institution", sa.String(120), nullable=True))
    op.add_column("accounts", sa.Column("last_four", sa.String(4), nullable=True))
    op.add_column("accounts", sa.Column("credit_limit", sa.Numeric(18, 2), nullable=True))
    op.add_column("accounts", sa.Column("statement_day", sa.Integer(), nullable=True))
    op.add_column("accounts", sa.Column("due_day", sa.Integer(), nullable=True))
    op.add_column(
        "accounts", sa.Column("is_internal", sa.Boolean(), nullable=False, server_default=sa.false())
    )
    op.add_column("accounts", sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True))

    op.add_column(
        "transactions",
        sa.Column("kind", sa.String(30), nullable=False, server_default="general"),
    )
    op.add_column(
        "transactions",
        sa.Column("reconciled", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column(
        "transactions", sa.Column("tags", sa.JSON(), nullable=False, server_default="[]")
    )
    op.add_column(
        "transactions",
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.add_column("postings", sa.Column("category", sa.String(120), nullable=True))
    op.execute("UPDATE postings SET category = transactions.category FROM transactions WHERE postings.transaction_id = transactions.id")
    op.add_column(
        "budgets",
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )

    op.create_table(
        "categories",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("color", sa.String(20), nullable=True),
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name"),
    )
    op.create_table(
        "tags",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(80), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name"),
    )
    op.create_table(
        "fx_rates",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("currency", sa.String(3), nullable=False),
        sa.Column("mxn_per_unit", sa.Numeric(18, 6), nullable=False),
        sa.Column("effective_on", sa.Date(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("currency", "effective_on", name="uq_fx_currency_date"),
    )
    op.create_table(
        "forecast_scenarios",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("income_adjustment_pct", sa.Numeric(8, 4), nullable=False),
        sa.Column("expense_adjustment_pct", sa.Numeric(8, 4), nullable=False),
        sa.Column("one_time_adjustment", sa.Numeric(18, 2), nullable=False),
        sa.Column("assumptions", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "recurring_rules",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(160), nullable=False),
        sa.Column("kind", sa.String(30), nullable=False),
        sa.Column("amount", sa.Numeric(18, 2), nullable=False),
        sa.Column("currency", sa.String(3), nullable=False),
        sa.Column("cadence", sa.String(20), nullable=False),
        sa.Column("next_date", sa.Date(), nullable=False),
        sa.Column("account_id", sa.Uuid(), nullable=True),
        sa.Column("counterparty_account_id", sa.Uuid(), nullable=True),
        sa.Column("category", sa.String(120), nullable=True),
        sa.Column("active", sa.Boolean(), nullable=False),
        sa.Column("confirmed", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["account_id"], ["accounts.id"]),
        sa.ForeignKeyConstraint(["counterparty_account_id"], ["accounts.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "savings_goals",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(160), nullable=False),
        sa.Column("target_amount", sa.Numeric(18, 2), nullable=False),
        sa.Column("target_date", sa.Date(), nullable=True),
        sa.Column("account_id", sa.Uuid(), nullable=True),
        sa.Column("active", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["account_id"], ["accounts.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "device_sessions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("label", sa.String(120), nullable=False),
        sa.Column("refresh_hash", sa.String(64), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("refresh_hash"),
    )
    op.create_table(
        "passkey_credentials",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("credential_id", sa.String(1024), nullable=False),
        sa.Column("public_key", sa.Text(), nullable=False),
        sa.Column("sign_count", sa.Integer(), nullable=False),
        sa.Column("label", sa.String(120), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("credential_id"),
    )
    op.create_table(
        "auth_challenges",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("challenge", sa.Text(), nullable=False),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "recovery_codes",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("code_hash", sa.String(64), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("code_hash"),
    )


def downgrade() -> None:
    for table in (
        "recovery_codes",
        "auth_challenges",
        "passkey_credentials",
        "device_sessions",
        "savings_goals",
        "recurring_rules",
        "forecast_scenarios",
        "fx_rates",
        "tags",
        "categories",
    ):
        op.drop_table(table)
    op.drop_column("budgets", "created_at")
    op.drop_column("postings", "category")
    for column in ("updated_at", "tags", "reconciled", "kind"):
        op.drop_column("transactions", column)
    for column in (
        "archived_at",
        "is_internal",
        "due_day",
        "statement_day",
        "credit_limit",
        "last_four",
        "institution",
        "alias",
    ):
        op.drop_column("accounts", column)
