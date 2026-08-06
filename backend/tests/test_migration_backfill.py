"""Direct verification of the aed6229aa1a1_backfill_default_expense_categories
Alembic migration's upgrade() logic.

Unlike the rest of this suite (HTTP integration tests against a running
API), this test talks to the database directly. `fresh_business` isn't
usable here: every business it creates goes through the normal signup path
in app.auth._create_business_and_user, which always seeds categories - so
it can never produce the "pre-existing business with zero categories" state
this migration is meant to fix. Instead we simulate that state by inserting
a business row directly (bypassing signup), then re-invoke the migration
module's upgrade() function against the live DB and confirm it backfills
exactly the 14 default categories - and leaves already-seeded businesses
alone (no double-seeding).

No pytest-asyncio is installed for this project (see pytest.ini), so the
async DB work is driven with asyncio.run() inside an ordinary sync test.
"""
import asyncio
import importlib.util
import os
import sys
import uuid
from pathlib import Path

import pytest
import sqlalchemy as sa
from sqlalchemy.ext.asyncio import create_async_engine

BACKEND_DIR = Path(__file__).resolve().parent.parent
MIGRATION_PATH = BACKEND_DIR / "alembic" / "versions" / "aed6229aa1a1_backfill_default_expense_categories.py"


def _load_migration_module():
    spec = importlib.util.spec_from_file_location("aed6229aa1a1_backfill", MIGRATION_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


async def _run_backfill_against_live_db():
    from dotenv import load_dotenv
    load_dotenv(BACKEND_DIR / ".env")

    migration = _load_migration_module()
    engine = create_async_engine(os.environ["DATABASE_URL"])
    fake_business_id = str(uuid.uuid4())
    fake_owner_id = str(uuid.uuid4())
    control_business_id = str(uuid.uuid4())
    control_owner_id = str(uuid.uuid4())

    # A fixed, known set of categories seeded directly for a business this
    # test owns exclusively. Previously the "already-seeded" control was
    # picked via `SELECT ... LIMIT 1` over whatever business happened to
    # already have categories - which could land on a business shared with
    # other tests. Since this suite runs under pytest-xdist (`-n 2
    # --dist loadscope`, see pytest.ini), another worker's concurrent
    # `_make_category(...)` call could change that shared business's count
    # mid-test and fail this assertion for reasons unrelated to the
    # migration. Owning the control business ourselves removes that
    # dependency on shared state entirely.
    control_categories = [
        ("TEST_Control Category A", "0001 Control A"),
        ("TEST_Control Category B", "0002 Control B"),
        ("TEST_Control Category C", "0003 Control C"),
    ]

    try:
        try:
            async with engine.begin() as conn:
                # Simulate a pre-existing business created before this feature
                # existed: insert straight into `businesses`, bypassing
                # app.auth._create_business_and_user (the only place categories
                # are normally seeded).
                await conn.execute(sa.text(
                    "INSERT INTO businesses (id, owner_user_id, name, currency, invoice_prefix, "
                    "next_invoice_no, default_due_days, plan, onboarded) "
                    "VALUES (:id, :owner, 'TEST_Backfill Pre-Existing Biz', 'USD', 'INV', 1, 14, 'FREE', false)"
                ), {"id": fake_business_id, "owner": fake_owner_id})

                count_before = (await conn.execute(
                    sa.text("SELECT COUNT(*) FROM expense_categories WHERE business_id = :id"),
                    {"id": fake_business_id},
                )).scalar_one()
                assert count_before == 0

                # Control business: dedicated to this test, seeded with a
                # known, fixed set of categories. The migration must leave it
                # completely unchanged (no double-seeding).
                await conn.execute(sa.text(
                    "INSERT INTO businesses (id, owner_user_id, name, currency, invoice_prefix, "
                    "next_invoice_no, default_due_days, plan, onboarded) "
                    "VALUES (:id, :owner, 'TEST_Backfill Control Biz', 'USD', 'INV', 1, 14, 'FREE', false)"
                ), {"id": control_business_id, "owner": control_owner_id})

                for name, cra_line in control_categories:
                    await conn.execute(sa.text(
                        "INSERT INTO expense_categories (id, business_id, name, cra_t2125_line, is_default, archived) "
                        "VALUES (:id, :business_id, :name, :cra_line, true, false)"
                    ), {
                        "id": str(uuid.uuid4()),
                        "business_id": control_business_id,
                        "name": name,
                        "cra_line": cra_line,
                    })

            # Invoke the migration's upgrade() exactly as alembic would: bind an
            # Operations instance (backed by this live connection) to the `op`
            # proxy the migration module calls into.
            from alembic.runtime.migration import MigrationContext
            from alembic.operations import Operations
            from alembic import op as alembic_op

            async with engine.connect() as conn:
                def run_upgrade(sync_conn):
                    ctx = MigrationContext.configure(sync_conn)
                    alembic_op._proxy = Operations(ctx)
                    migration.upgrade()

                await conn.run_sync(run_upgrade)
                await conn.commit()

            async with engine.begin() as conn:
                rows = (await conn.execute(
                    sa.text(
                        "SELECT name, is_default, archived FROM expense_categories "
                        "WHERE business_id = :id ORDER BY name"
                    ),
                    {"id": fake_business_id},
                )).all()

                names = sorted(r[0] for r in rows)
                expected_names = sorted(name for name, _ in migration.DEFAULT_EXPENSE_CATEGORIES)
                assert len(rows) == 14, f"expected 14 backfilled categories, got {len(rows)}"
                assert names == expected_names
                assert all(r[1] is True and r[2] is False for r in rows), "backfilled rows should be is_default=True, archived=False"

                control_rows = (await conn.execute(
                    sa.text(
                        "SELECT name, is_default, archived FROM expense_categories "
                        "WHERE business_id = :id ORDER BY name"
                    ),
                    {"id": control_business_id},
                )).all()
                control_names_after = sorted(r[0] for r in control_rows)
                assert control_names_after == sorted(name for name, _ in control_categories), (
                    "already-seeded control business was double-seeded by the migration"
                )
                assert control_rows == [
                    (name, True, False) for name, _ in sorted(control_categories)
                ], "control business's category rows were modified by the migration"
        finally:
            # Cleanup runs even if an assertion above raised, so this test
            # never leaves the fake or control business (or their categories)
            # behind in the shared dev database.
            async with engine.begin() as conn:
                await conn.execute(
                    sa.text("DELETE FROM expense_categories WHERE business_id IN (:fake, :control)"),
                    {"fake": fake_business_id, "control": control_business_id},
                )
                await conn.execute(
                    sa.text("DELETE FROM businesses WHERE id IN (:fake, :control)"),
                    {"fake": fake_business_id, "control": control_business_id},
                )
    finally:
        await engine.dispose()


class TestExpenseCategoryBackfillMigration:
    def test_backfill_seeds_pre_existing_business_with_zero_categories(self):
        if not MIGRATION_PATH.exists():
            pytest.skip("backfill migration file not found")
        asyncio.run(_run_backfill_against_live_db())
