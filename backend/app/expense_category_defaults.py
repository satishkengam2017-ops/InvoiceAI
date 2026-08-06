"""Shared default expense category list.

Used by `app.auth._create_business_and_user` to seed new signups, and
available for any future admin/backfill tooling that needs the same list.

NOTE: Alembic migrations must NOT import this module — migrations should be
self-contained and not depend on application code that could change later.
Any migration that needs this data (e.g. the pre-existing-business backfill)
keeps its own literal, inline copy instead.
"""

DEFAULT_EXPENSE_CATEGORIES = [
    # (name, illustrative CRA T2125 line — verify exact line numbers with an accountant before filing)
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
