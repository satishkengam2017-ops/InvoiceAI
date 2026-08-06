"""backfill_default_expense_categories

Revision ID: aed6229aa1a1
Revises: b91e6a2f0c14
Create Date: 2026-08-06 00:00:00.000000

Default expense categories were only ever seeded for NEW signups (in
app.auth._create_business_and_user). Every business that existed before the
expense-management feature deployed has zero rows in expense_categories,
and since Expense.category_id is required with no in-form "create category"
shortcut, those businesses would otherwise be permanently unable to log an
expense. This migration backfills the same 14 default categories for any
business that currently has none.
"""
import uuid
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = 'aed6229aa1a1'
down_revision: Union[str, None] = 'b91e6a2f0c14'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# Deliberately an inline, literal copy of the list in
# app.expense_category_defaults rather than an import of it: Alembic
# migrations should be self-contained and not depend on application code
# that could change (or be deleted/renamed) later, which would silently
# break replaying this migration from scratch on a new environment.
DEFAULT_EXPENSE_CATEGORIES = [
    ("Advertising & Marketing", "8521 Advertising"),
    ("Bank Charges & Interest", "8710 Interest and bank charges"),
    ("Insurance", "8690 Insurance"),
    ("Meals & Entertainment", "8523 Meals and entertainment"),
    ("Motor Vehicle Expenses", "9281 Motor vehicle expenses"),
    ("Office Supplies", "8811 Office expenses"),
    ("Professional Fees", "8860 Professional fees"),
    ("Rent", "8910 Rent"),
    ("Repairs & Maintenance", "8960 Repairs and maintenance"),
    ("Salaries & Wages", "9060 Salaries, wages and benefits"),
    ("Supplies", "8811 Office expenses"),
    ("Travel", "9200 Travel expenses"),
    ("Utilities", "9220 Utilities"),
    ("Other Expenses", "9270 Other expenses"),
]


expense_categories = sa.table(
    'expense_categories',
    sa.column('id', postgresql.UUID(as_uuid=False)),
    sa.column('business_id', postgresql.UUID(as_uuid=False)),
    sa.column('name', sa.String()),
    sa.column('cra_t2125_line', sa.String()),
    sa.column('is_default', sa.Boolean()),
    sa.column('archived', sa.Boolean()),
)


def upgrade() -> None:
    bind = op.get_bind()

    # Businesses with zero rows in expense_categories - i.e. pre-existing
    # businesses that predate this feature and never went through the
    # signup-path seeding in app.auth._create_business_and_user. Businesses
    # that already have at least one category (whether default or
    # user-created) are left untouched so we never double-seed.
    result = bind.execute(sa.text(
        "SELECT b.id FROM businesses b "
        "LEFT JOIN expense_categories ec ON ec.business_id = b.id "
        "GROUP BY b.id HAVING COUNT(ec.id) = 0"
    ))
    business_ids = [row[0] for row in result]

    rows = [
        {
            "id": str(uuid.uuid4()),
            "business_id": business_id,
            "name": name,
            "cra_t2125_line": cra_line,
            "is_default": True,
            "archived": False,
        }
        for business_id in business_ids
        for name, cra_line in DEFAULT_EXPENSE_CATEGORIES
    ]

    if rows:
        op.bulk_insert(expense_categories, rows)


def downgrade() -> None:
    # Intentional no-op. This is a data-only migration and there is no
    # marker distinguishing rows it inserted from rows inserted by the
    # normal signup path (both share is_default=True) or from categories a
    # user has since renamed/edited, so we can't safely identify "the rows
    # this migration added" to remove them without risking deletion of
    # legitimate user data. Leaving the backfilled categories in place on
    # downgrade is the conservative tradeoff.
    pass
