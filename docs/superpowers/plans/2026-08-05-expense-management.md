# Expense Management, Vendors, and AI Receipt Scanner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add expense tracking, a vendor list, and a photo-based AI receipt scanner to InvoiceAI, so the app records money going out, not just money coming in.

**Architecture:** Three new tables (`vendors`, `expense_categories`, `expenses`) and three new FastAPI routers, built to the exact CRUD shape already established by `backend/app/routers/customers.py`. The receipt scanner is one additional endpoint on the expenses router — a single synchronous request that sends an uploaded photo to Claude's vision API and returns suggested field values, with nothing persisted server-side. Two new frontend screens (`vendors.tsx`, `expenses.tsx`) and their modals mirror `customers.tsx` / `AddCustomerModal.tsx`.

**Tech Stack:** FastAPI, SQLAlchemy async + asyncpg, Alembic, Anthropic Python SDK (`claude-sonnet-4-5`, vision), Expo Router / React Native Web, `expo-image-picker`.

## Global Constraints

- Money fields are `_cents` integer minor units throughout — never floats. (Spec, Data model.)
- `Vendor` and `ExpenseCategory` are soft-deleted (`archived=True`); `Expense` is hard-deleted. (Spec, Backend.)
- `Expense.category_id` is required; `Expense.vendor_id` is nullable. (Spec, Data model.)
- Exactly 14 default expense categories are seeded per new business: Advertising & Marketing, Bank Charges & Interest, Insurance, Meals & Entertainment, Motor Vehicle Expenses, Office Supplies, Professional Fees, Rent, Repairs & Maintenance, Salaries & Wages, Supplies, Travel, Utilities, Other Expenses. (Spec, Data model.)
- No image or file persistence anywhere — the receipt scanner is a single synchronous request; the uploaded image exists only in memory for the duration of that HTTP call. (Spec, Scope.)
- AI model id is `claude-sonnet-4-5`, matching `backend/app/routers/ai.py`. (Spec, Backend.)
- Every new router/schema/model follows the exact conventions already in `backend/app/routers/customers.py`, `backend/app/schemas.py`, and `backend/app/models.py`: `PG_UUID(as_uuid=False)` string PKs via `new_id()`, the `get_business` dependency, `to_dict()` responses, business-scoped queries. (Codebase convention, verified in Task 1 research.)
- Vendors and expense categories do not get their own tab-bar slot: Vendors is reachable via `router.push("/vendors")` but hidden from the tab bar (`href: null`); categories are managed from a modal inside the Expenses screen. Only "Expenses" is added as a new visible tab. (Spec, Frontend — mobile tab-bar real estate.)
- New frontend components mirror `AddCustomerModal.tsx` / `customers.tsx` structurally: `Modal` + `KeyboardAvoidingView` + `ScrollView`, the existing `testID` naming convention, `Input`/`Button`/`EmptyState` shared components. (Spec, Frontend.)
- Backend tests are black-box HTTP integration tests against a running server using `requests` (see `backend/tests/test_backend.py`, `backend/tests/conftest.py`) — not FastAPI `TestClient` or mocked sessions. `TEST_`-prefixed data, `auth_client`/`fresh_business` fixtures.

---

### Task 1: Data model — Vendor, ExpenseCategory, Expense tables

**Files:**
- Modify: `backend/app/models.py` (append after the `PasswordResetCode` class at the end of the file)
- Create: `backend/alembic/versions/b91e6a2f0c14_add_vendors_expense_categories_expenses.py`

**Interfaces:**
- Produces: `Vendor`, `ExpenseCategory`, `Expense` ORM classes (importable from `app.models`), and the three underlying Postgres tables `vendors`, `expense_categories`, `expenses`.

- [ ] **Step 1: Add the three ORM models**

Append to `backend/app/models.py`:

```python
class Vendor(Base):
    __tablename__ = "vendors"

    id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), primary_key=True, default=new_id)
    business_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), ForeignKey("businesses.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String)
    email: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    phone: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    address_line1: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    city: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    region: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    postal_code: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    country: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    archived: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True, onupdate=func.now())


class ExpenseCategory(Base):
    __tablename__ = "expense_categories"

    id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), primary_key=True, default=new_id)
    business_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), ForeignKey("businesses.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String)
    cra_t2125_line: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    archived: Mapped[bool] = mapped_column(Boolean, default=False)


class Expense(Base):
    __tablename__ = "expenses"

    id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), primary_key=True, default=new_id)
    business_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), ForeignKey("businesses.id", ondelete="CASCADE"), index=True)
    vendor_id: Mapped[Optional[str]] = mapped_column(PG_UUID(as_uuid=False), ForeignKey("vendors.id"), nullable=True, index=True)
    category_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), ForeignKey("expense_categories.id"), index=True)
    date: Mapped[str] = mapped_column(Date)
    amount_cents: Mapped[int] = mapped_column(Integer)
    tax_cents: Mapped[int] = mapped_column(Integer, default=0)
    currency: Mapped[str] = mapped_column(String, default="USD")
    payment_method: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True, onupdate=func.now())
```

- [ ] **Step 2: Write the Alembic migration**

Create `backend/alembic/versions/b91e6a2f0c14_add_vendors_expense_categories_expenses.py`:

```python
"""add_vendors_expense_categories_expenses

Revision ID: b91e6a2f0c14
Revises: 747fdfb9d8e2
Create Date: 2026-08-05 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = 'b91e6a2f0c14'
down_revision: Union[str, None] = '747fdfb9d8e2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'vendors',
        sa.Column('id', postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column('business_id', postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column('name', sa.String(), nullable=False),
        sa.Column('email', sa.String(), nullable=True),
        sa.Column('phone', sa.String(), nullable=True),
        sa.Column('address_line1', sa.String(), nullable=True),
        sa.Column('city', sa.String(), nullable=True),
        sa.Column('region', sa.String(), nullable=True),
        sa.Column('postal_code', sa.String(), nullable=True),
        sa.Column('country', sa.String(), nullable=True),
        sa.Column('notes', sa.Text(), nullable=True),
        sa.Column('archived', sa.Boolean(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['business_id'], ['businesses.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_vendors_business_id'), 'vendors', ['business_id'], unique=False)

    op.create_table(
        'expense_categories',
        sa.Column('id', postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column('business_id', postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column('name', sa.String(), nullable=False),
        sa.Column('cra_t2125_line', sa.String(), nullable=True),
        sa.Column('is_default', sa.Boolean(), nullable=False),
        sa.Column('archived', sa.Boolean(), nullable=False),
        sa.ForeignKeyConstraint(['business_id'], ['businesses.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_expense_categories_business_id'), 'expense_categories', ['business_id'], unique=False)

    op.create_table(
        'expenses',
        sa.Column('id', postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column('business_id', postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column('vendor_id', postgresql.UUID(as_uuid=False), nullable=True),
        sa.Column('category_id', postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column('date', sa.Date(), nullable=False),
        sa.Column('amount_cents', sa.Integer(), nullable=False),
        sa.Column('tax_cents', sa.Integer(), nullable=False),
        sa.Column('currency', sa.String(), nullable=False),
        sa.Column('payment_method', sa.String(), nullable=True),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['business_id'], ['businesses.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['vendor_id'], ['vendors.id']),
        sa.ForeignKeyConstraint(['category_id'], ['expense_categories.id']),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_expenses_business_id'), 'expenses', ['business_id'], unique=False)
    op.create_index(op.f('ix_expenses_vendor_id'), 'expenses', ['vendor_id'], unique=False)
    op.create_index(op.f('ix_expenses_category_id'), 'expenses', ['category_id'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_expenses_category_id'), table_name='expenses')
    op.drop_index(op.f('ix_expenses_vendor_id'), table_name='expenses')
    op.drop_index(op.f('ix_expenses_business_id'), table_name='expenses')
    op.drop_table('expenses')
    op.drop_index(op.f('ix_expense_categories_business_id'), table_name='expense_categories')
    op.drop_table('expense_categories')
    op.drop_index(op.f('ix_vendors_business_id'), table_name='vendors')
    op.drop_table('vendors')
```

- [ ] **Step 3: Run the migration and verify it's reversible**

Run (from `backend/`, with `DATABASE_URL` pointing at the dev database):
```bash
alembic upgrade head
alembic downgrade -1
alembic upgrade head
```
Expected: all three commands exit 0 with no errors; the final `alembic current` shows `b91e6a2f0c14 (head)`.

- [ ] **Step 4: Commit**

```bash
git add backend/app/models.py backend/alembic/versions/b91e6a2f0c14_add_vendors_expense_categories_expenses.py
git commit -m "Add Vendor, ExpenseCategory, and Expense tables"
```

---

### Task 2: Vendors CRUD router

**Files:**
- Modify: `backend/app/schemas.py` (add `VendorIn`, after `CustomerIn`)
- Create: `backend/app/routers/vendors.py`
- Modify: `backend/app/main.py` (register the router)
- Modify: `backend/tests/test_backend.py` (append `TestVendors`)

**Interfaces:**
- Consumes: `Vendor` model, `new_id()` from Task 1.
- Produces: `GET/POST /vendors`, `GET/PATCH/DELETE /vendors/{id}` — used by Task 8's frontend screen and Task 9's vendor picker.

- [ ] **Step 1: Add the `VendorIn` schema**

In `backend/app/schemas.py`, add directly after `CustomerIn`:

```python
class VendorIn(BaseModel):
    name: str
    email: Optional[EmailStr] = None
    phone: Optional[str] = None
    address_line1: Optional[str] = None
    city: Optional[str] = None
    region: Optional[str] = None
    postal_code: Optional[str] = None
    country: Optional[str] = None
    notes: Optional[str] = None
```

- [ ] **Step 2: Write the vendors router**

Create `backend/app/routers/vendors.py`:

```python
"""Vendor CRUD routes."""
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_business
from app.db import get_db, to_dict
from app.models import Vendor, new_id
from app.schemas import VendorIn

router = APIRouter(prefix="/vendors", tags=["vendors"])


@router.get("")
async def list_vendors(
    ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db), q: Optional[str] = None
):
    biz_id = ctx["business"]["id"]
    stmt = select(Vendor).where(Vendor.business_id == biz_id, Vendor.archived.is_not(True))
    if q:
        like = f"%{q}%"
        stmt = stmt.where(or_(Vendor.name.ilike(like), Vendor.email.ilike(like)))
    stmt = stmt.order_by(Vendor.name)
    rows = (await db.execute(stmt)).scalars().all()
    return [to_dict(r) for r in rows]


@router.post("")
async def create_vendor(payload: VendorIn, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)):
    biz_id = ctx["business"]["id"]
    vendor = Vendor(id=new_id(), business_id=biz_id, archived=False, **payload.model_dump())
    db.add(vendor)
    await db.commit()
    await db.refresh(vendor)
    return to_dict(vendor)


@router.get("/{vendor_id}")
async def get_vendor(vendor_id: str, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)):
    biz_id = ctx["business"]["id"]
    vendor = (await db.execute(
        select(Vendor).where(Vendor.id == vendor_id, Vendor.business_id == biz_id)
    )).scalar_one_or_none()
    if not vendor:
        raise HTTPException(status_code=404, detail="Vendor not found")
    return to_dict(vendor)


@router.patch("/{vendor_id}")
async def update_vendor(
    vendor_id: str, payload: VendorIn, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)
):
    biz_id = ctx["business"]["id"]
    vendor = (await db.execute(
        select(Vendor).where(Vendor.id == vendor_id, Vendor.business_id == biz_id)
    )).scalar_one_or_none()
    if not vendor:
        raise HTTPException(status_code=404, detail="Vendor not found")
    for key, value in payload.model_dump().items():
        setattr(vendor, key, value)
    vendor.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(vendor)
    return to_dict(vendor)


@router.delete("/{vendor_id}")
async def archive_vendor(vendor_id: str, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)):
    biz_id = ctx["business"]["id"]
    vendor = (await db.execute(
        select(Vendor).where(Vendor.id == vendor_id, Vendor.business_id == biz_id)
    )).scalar_one_or_none()
    if vendor:
        vendor.archived = True
        await db.commit()
    return {"ok": True}
```

- [ ] **Step 3: Register the router**

In `backend/app/main.py`, add `vendors` to the import line and register it:

```python
from app.routers import ai, auth, business, catalog, customers, dashboard, invoices, vendors, webhooks
```

```python
api.include_router(vendors.router)
```
(add this line next to `api.include_router(customers.router)`)

- [ ] **Step 4: Write the tests**

Append to `backend/tests/test_backend.py`, after the `TestCustomers` class:

```python
# ---------------------------------------------------------------------------
# Vendors CRUD + business isolation
# ---------------------------------------------------------------------------
class TestVendors:
    def test_vendor_crud(self, auth_client):
        r = auth_client.post(f"{API}/vendors", json={
            "name": "TEST_Acme Supply Co", "email": "TEST_acme-supply@example.com"
        })
        assert r.status_code == 200
        vendor = r.json()
        vid = vendor["id"]
        assert vendor["name"] == "TEST_Acme Supply Co"

        r = auth_client.get(f"{API}/vendors/{vid}")
        assert r.status_code == 200
        assert r.json()["id"] == vid

        r = auth_client.get(f"{API}/vendors")
        assert r.status_code == 200
        assert any(v["id"] == vid for v in r.json())

        r = auth_client.patch(f"{API}/vendors/{vid}", json={"name": "TEST_Acme Supply Co Updated"})
        assert r.status_code == 200
        assert r.json()["name"] == "TEST_Acme Supply Co Updated"

        r = auth_client.delete(f"{API}/vendors/{vid}")
        assert r.status_code == 200

        r = auth_client.get(f"{API}/vendors")
        assert not any(v["id"] == vid for v in r.json())

    def test_business_isolation(self, auth_client, fresh_business):
        r = auth_client.post(f"{API}/vendors", json={"name": "TEST_ISO_Vendor"})
        assert r.status_code == 200
        primary_vid = r.json()["id"]

        s = fresh_business["session"]
        r = s.get(f"{API}/vendors")
        assert r.status_code == 200
        assert not any(v["id"] == primary_vid for v in r.json())

        r = s.get(f"{API}/vendors/{primary_vid}")
        assert r.status_code == 404
```

- [ ] **Step 5: Run the tests**

Run: `cd backend && pytest tests/test_backend.py -k TestVendors -v`
Expected: 2 passed

- [ ] **Step 6: Commit**

```bash
git add backend/app/schemas.py backend/app/routers/vendors.py backend/app/main.py backend/tests/test_backend.py
git commit -m "Add Vendors CRUD API"
```

---

### Task 3: Expense Categories CRUD router

**Files:**
- Modify: `backend/app/schemas.py` (add `ExpenseCategoryIn`)
- Create: `backend/app/routers/expense_categories.py`
- Modify: `backend/app/main.py` (register the router)
- Modify: `backend/tests/test_backend.py` (append `TestExpenseCategories`)

**Interfaces:**
- Consumes: `ExpenseCategory`, `Expense` models, `new_id()` from Task 1.
- Produces: `GET/POST /expense-categories`, `PATCH/DELETE /expense-categories/{id}` — used by Task 4's seeding, Task 5's category-in-use test, Task 9's category picker and manager modal.

- [ ] **Step 1: Add the `ExpenseCategoryIn` schema**

In `backend/app/schemas.py`, add directly after `VendorIn`:

```python
class ExpenseCategoryIn(BaseModel):
    name: str
    cra_t2125_line: Optional[str] = None
```

- [ ] **Step 2: Write the expense categories router**

Create `backend/app/routers/expense_categories.py`:

```python
"""Expense category CRUD routes."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_business
from app.db import get_db, to_dict
from app.models import Expense, ExpenseCategory, new_id
from app.schemas import ExpenseCategoryIn

router = APIRouter(prefix="/expense-categories", tags=["expense-categories"])


@router.get("")
async def list_expense_categories(ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)):
    biz_id = ctx["business"]["id"]
    rows = (await db.execute(
        select(ExpenseCategory)
        .where(ExpenseCategory.business_id == biz_id, ExpenseCategory.archived.is_not(True))
        .order_by(ExpenseCategory.name)
    )).scalars().all()
    return [to_dict(r) for r in rows]


@router.post("")
async def create_expense_category(
    payload: ExpenseCategoryIn, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)
):
    biz_id = ctx["business"]["id"]
    category = ExpenseCategory(id=new_id(), business_id=biz_id, is_default=False, archived=False, **payload.model_dump())
    db.add(category)
    await db.commit()
    await db.refresh(category)
    return to_dict(category)


@router.patch("/{category_id}")
async def update_expense_category(
    category_id: str, payload: ExpenseCategoryIn, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)
):
    biz_id = ctx["business"]["id"]
    category = (await db.execute(
        select(ExpenseCategory).where(ExpenseCategory.id == category_id, ExpenseCategory.business_id == biz_id)
    )).scalar_one_or_none()
    if not category:
        raise HTTPException(status_code=404, detail="Category not found")
    for key, value in payload.model_dump().items():
        setattr(category, key, value)
    await db.commit()
    await db.refresh(category)
    return to_dict(category)


@router.delete("/{category_id}")
async def archive_expense_category(
    category_id: str, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)
):
    biz_id = ctx["business"]["id"]
    category = (await db.execute(
        select(ExpenseCategory).where(ExpenseCategory.id == category_id, ExpenseCategory.business_id == biz_id)
    )).scalar_one_or_none()
    if not category:
        return {"ok": True}
    in_use = (await db.execute(
        select(Expense.id).where(Expense.category_id == category_id).limit(1)
    )).scalar_one_or_none()
    if in_use:
        raise HTTPException(status_code=409, detail="Category is used by existing expenses and can't be removed.")
    category.archived = True
    await db.commit()
    return {"ok": True}
```

- [ ] **Step 3: Register the router**

In `backend/app/main.py`:

```python
from app.routers import ai, auth, business, catalog, customers, dashboard, expense_categories, invoices, vendors, webhooks
```

```python
api.include_router(expense_categories.router)
```

- [ ] **Step 4: Write the tests**

Append to `backend/tests/test_backend.py`, after `TestVendors`:

```python
# ---------------------------------------------------------------------------
# Expense categories CRUD
# ---------------------------------------------------------------------------
class TestExpenseCategories:
    def test_category_crud(self, auth_client):
        r = auth_client.post(f"{API}/expense-categories", json={
            "name": "TEST_Custom Category", "cra_t2125_line": "9270 Other expenses"
        })
        assert r.status_code == 200
        cat = r.json()
        cat_id = cat["id"]
        assert cat["name"] == "TEST_Custom Category"
        assert cat["is_default"] is False

        r = auth_client.get(f"{API}/expense-categories")
        assert r.status_code == 200
        assert any(c["id"] == cat_id for c in r.json())

        r = auth_client.patch(f"{API}/expense-categories/{cat_id}", json={"name": "TEST_Custom Category v2"})
        assert r.status_code == 200
        assert r.json()["name"] == "TEST_Custom Category v2"

        r = auth_client.delete(f"{API}/expense-categories/{cat_id}")
        assert r.status_code == 200

        r = auth_client.get(f"{API}/expense-categories")
        assert not any(c["id"] == cat_id for c in r.json())
```

- [ ] **Step 5: Run the tests**

Run: `cd backend && pytest tests/test_backend.py -k TestExpenseCategories -v`
Expected: 1 passed

- [ ] **Step 6: Commit**

```bash
git add backend/app/schemas.py backend/app/routers/expense_categories.py backend/app/main.py backend/tests/test_backend.py
git commit -m "Add Expense Categories CRUD API"
```

---

### Task 4: Seed default expense categories on business creation

**Files:**
- Modify: `backend/app/auth.py`
- Modify: `backend/tests/test_backend.py` (append `TestExpenseCategorySeeding`)

**Interfaces:**
- Consumes: `ExpenseCategory` model + `new_id()` (Task 1), `GET /expense-categories` (Task 3).
- Produces: every new business (via `/auth/register` or the Clerk exchange) has exactly 14 `ExpenseCategory` rows with `is_default=True` immediately after creation.

- [ ] **Step 1: Add the default category list and seed them in `_create_business_and_user`**

In `backend/app/auth.py`, add the import and constant near the top (after the existing imports):

```python
from app.models import Business, ExpenseCategory, User, new_id
```
(replaces the existing `from app.db import get_db, to_dict` + `from app.models import Business, User, new_id` line's model import — just add `ExpenseCategory` to it)

```python
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
```

In `_create_business_and_user`, replace:

```python
    db.add(business)
    db.add(user)
    await db.commit()
    return user_id, business_id
```

with:

```python
    db.add(business)
    db.add(user)
    for name, cra_line in DEFAULT_EXPENSE_CATEGORIES:
        db.add(ExpenseCategory(
            id=new_id(), business_id=business_id, name=name, cra_t2125_line=cra_line,
            is_default=True, archived=False,
        ))
    await db.commit()
    return user_id, business_id
```

- [ ] **Step 2: Write the test**

Append to `backend/tests/test_backend.py`, after `TestExpenseCategories`:

```python
# ---------------------------------------------------------------------------
# Default expense category seeding on business creation
# ---------------------------------------------------------------------------
class TestExpenseCategorySeeding:
    def test_new_business_gets_default_categories(self, fresh_business):
        s = fresh_business["session"]
        r = s.get(f"{API}/expense-categories")
        assert r.status_code == 200
        rows = r.json()
        names = {c["name"] for c in rows}
        assert names == {
            "Advertising & Marketing", "Bank Charges & Interest", "Insurance",
            "Meals & Entertainment", "Motor Vehicle Expenses", "Office Supplies",
            "Professional Fees", "Rent", "Repairs & Maintenance", "Salaries & Wages",
            "Supplies", "Travel", "Utilities", "Other Expenses",
        }
        assert all(c["is_default"] for c in rows)
```

- [ ] **Step 3: Run the test**

Run: `cd backend && pytest tests/test_backend.py -k TestExpenseCategorySeeding -v`
Expected: 1 passed

- [ ] **Step 4: Commit**

```bash
git add backend/app/auth.py backend/tests/test_backend.py
git commit -m "Seed default expense categories for new businesses"
```

---

### Task 5: Expenses CRUD router with filters

**Files:**
- Modify: `backend/app/schemas.py` (add `ExpenseIn`)
- Create: `backend/app/routers/expenses.py`
- Modify: `backend/app/main.py` (register the router)
- Modify: `backend/tests/test_backend.py` (append `TestExpenses`)

**Interfaces:**
- Consumes: `Expense` model, `new_id()` (Task 1); `expense-categories` create/delete endpoints (Task 3) for test setup.
- Produces: `GET/POST /expenses`, `GET/PATCH/DELETE /expenses/{id}` — Task 6 adds `POST /expenses/scan-receipt` to this same router file; Task 9's screen consumes all of these.

- [ ] **Step 1: Add the `ExpenseIn` schema**

In `backend/app/schemas.py`, add directly after `ExpenseCategoryIn`:

```python
class ExpenseIn(BaseModel):
    vendor_id: Optional[str] = None
    category_id: str
    date: str
    amount_cents: int = Field(ge=0)
    tax_cents: int = Field(default=0, ge=0)
    currency: Optional[str] = None
    payment_method: Optional[str] = None
    description: Optional[str] = None
```

- [ ] **Step 2: Write the expenses router**

Create `backend/app/routers/expenses.py`:

```python
"""Expense CRUD routes."""
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import and_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_business
from app.db import get_db, to_dict
from app.models import Expense, new_id
from app.schemas import ExpenseIn

router = APIRouter(prefix="/expenses", tags=["expenses"])


@router.get("")
async def list_expenses(
    ctx: dict = Depends(get_business),
    db: AsyncSession = Depends(get_db),
    q: Optional[str] = None,
    category_id: Optional[str] = None,
    vendor_id: Optional[str] = None,
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
):
    biz_id = ctx["business"]["id"]
    conditions = [Expense.business_id == biz_id]
    if q:
        conditions.append(Expense.description.ilike(f"%{q}%"))
    if category_id:
        conditions.append(Expense.category_id == category_id)
    if vendor_id:
        conditions.append(Expense.vendor_id == vendor_id)
    if from_date:
        conditions.append(Expense.date >= from_date)
    if to_date:
        conditions.append(Expense.date <= to_date)
    stmt = select(Expense).where(and_(*conditions)).order_by(Expense.date.desc())
    rows = (await db.execute(stmt)).scalars().all()
    return [to_dict(r) for r in rows]


@router.post("")
async def create_expense(payload: ExpenseIn, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)):
    biz = ctx["business"]
    data = payload.model_dump()
    data["currency"] = data.get("currency") or biz.get("currency", "USD")
    expense = Expense(id=new_id(), business_id=biz["id"], **data)
    db.add(expense)
    await db.commit()
    await db.refresh(expense)
    return to_dict(expense)


@router.get("/{expense_id}")
async def get_expense(expense_id: str, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)):
    biz_id = ctx["business"]["id"]
    expense = (await db.execute(
        select(Expense).where(Expense.id == expense_id, Expense.business_id == biz_id)
    )).scalar_one_or_none()
    if not expense:
        raise HTTPException(status_code=404, detail="Expense not found")
    return to_dict(expense)


@router.patch("/{expense_id}")
async def update_expense(
    expense_id: str, payload: ExpenseIn, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)
):
    biz_id = ctx["business"]["id"]
    expense = (await db.execute(
        select(Expense).where(Expense.id == expense_id, Expense.business_id == biz_id)
    )).scalar_one_or_none()
    if not expense:
        raise HTTPException(status_code=404, detail="Expense not found")
    for key, value in payload.model_dump().items():
        setattr(expense, key, value)
    expense.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(expense)
    return to_dict(expense)


@router.delete("/{expense_id}")
async def delete_expense(expense_id: str, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)):
    biz_id = ctx["business"]["id"]
    expense = (await db.execute(
        select(Expense).where(Expense.id == expense_id, Expense.business_id == biz_id)
    )).scalar_one_or_none()
    if expense:
        await db.delete(expense)
        await db.commit()
    return {"ok": True}
```

- [ ] **Step 3: Register the router**

In `backend/app/main.py`:

```python
from app.routers import ai, auth, business, catalog, customers, dashboard, expense_categories, expenses, invoices, vendors, webhooks
```

```python
api.include_router(expenses.router)
```

- [ ] **Step 4: Write the tests**

Append to `backend/tests/test_backend.py`, after `TestExpenseCategorySeeding`:

```python
# ---------------------------------------------------------------------------
# Expenses CRUD, filters, business isolation, category-in-use protection
# ---------------------------------------------------------------------------
class TestExpenses:
    def _make_category(self, s, name="TEST_Expense Category"):
        r = s.post(f"{API}/expense-categories", json={"name": name})
        assert r.status_code == 200
        return r.json()["id"]

    def test_expense_crud(self, auth_client):
        cat_id = self._make_category(auth_client)
        r = auth_client.post(f"{API}/expenses", json={
            "category_id": cat_id, "date": "2026-08-01", "amount_cents": 4250, "tax_cents": 250,
            "description": "TEST_Fuel fill-up",
        })
        assert r.status_code == 200
        expense = r.json()
        eid = expense["id"]
        assert expense["amount_cents"] == 4250
        assert expense["currency"]

        r = auth_client.get(f"{API}/expenses/{eid}")
        assert r.status_code == 200
        assert r.json()["id"] == eid

        r = auth_client.get(f"{API}/expenses", params={"category_id": cat_id})
        assert r.status_code == 200
        assert any(e["id"] == eid for e in r.json())

        r = auth_client.patch(f"{API}/expenses/{eid}", json={
            "category_id": cat_id, "date": "2026-08-01", "amount_cents": 5000, "tax_cents": 250,
        })
        assert r.status_code == 200
        assert r.json()["amount_cents"] == 5000

        r = auth_client.delete(f"{API}/expenses/{eid}")
        assert r.status_code == 200
        r = auth_client.get(f"{API}/expenses/{eid}")
        assert r.status_code == 404

    def test_date_range_filter(self, fresh_business):
        s = fresh_business["session"]
        cat_id = self._make_category(s)
        s.post(f"{API}/expenses", json={"category_id": cat_id, "date": "2026-01-15", "amount_cents": 1000})
        s.post(f"{API}/expenses", json={"category_id": cat_id, "date": "2026-06-15", "amount_cents": 2000})

        r = s.get(f"{API}/expenses", params={"from_date": "2026-06-01", "to_date": "2026-06-30"})
        assert r.status_code == 200
        rows = r.json()
        assert len(rows) == 1
        assert rows[0]["date"] == "2026-06-15"

    def test_business_isolation(self, auth_client, fresh_business):
        cat_id = self._make_category(auth_client, "TEST_ISO_Category")
        r = auth_client.post(f"{API}/expenses", json={"category_id": cat_id, "date": "2026-08-01", "amount_cents": 100})
        assert r.status_code == 200
        primary_eid = r.json()["id"]

        s = fresh_business["session"]
        r = s.get(f"{API}/expenses")
        assert r.status_code == 200
        assert not any(e["id"] == primary_eid for e in r.json())
        r = s.get(f"{API}/expenses/{primary_eid}")
        assert r.status_code == 404

    def test_category_delete_blocked_while_in_use(self, fresh_business):
        s = fresh_business["session"]
        cat_id = self._make_category(s, "TEST_In_Use_Category")
        r = s.post(f"{API}/expenses", json={"category_id": cat_id, "date": "2026-08-01", "amount_cents": 500})
        assert r.status_code == 200

        r = s.delete(f"{API}/expense-categories/{cat_id}")
        assert r.status_code == 409
```

- [ ] **Step 5: Run the tests**

Run: `cd backend && pytest tests/test_backend.py -k TestExpenses -v`
Expected: 4 passed

- [ ] **Step 6: Commit**

```bash
git add backend/app/schemas.py backend/app/routers/expenses.py backend/app/main.py backend/tests/test_backend.py
git commit -m "Add Expenses CRUD API with category/vendor/date filters"
```

---

### Task 6: AI receipt scanner endpoint

**Files:**
- Modify: `backend/app/routers/expenses.py`
- Modify: `backend/tests/test_backend.py` (append `TestReceiptScan`)

**Interfaces:**
- Consumes: `ExpenseCategory` model (Task 1/3), business's `anthropic_api_key` (existing `Business` field).
- Produces: `POST /expenses/scan-receipt` returning `{vendor_name, date, amount_cents, tax_cents, category_id, description}` (all nullable) — consumed by Task 10's camera integration via `scanReceipt()` in `frontend/src/lib/api.ts`.

- [ ] **Step 1: Add the scan-receipt endpoint**

In `backend/app/routers/expenses.py`, add these imports at the top (alongside the existing ones):

```python
import base64

from anthropic import AsyncAnthropic
from fastapi import File, UploadFile

from app.models import ExpenseCategory
```

Add near the top of the file, after the imports and `router = APIRouter(...)` line:

```python
ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}

RECEIPT_EXTRACTION_TOOL = {
    "name": "extract_receipt",
    "description": "Extract structured expense data from a photo of a receipt.",
    "input_schema": {
        "type": "object",
        "properties": {
            "vendor_name": {"type": ["string", "null"], "description": "Business name on the receipt, or null if unreadable."},
            "date": {"type": ["string", "null"], "description": "ISO YYYY-MM-DD purchase date, or null if unreadable."},
            "amount_cents": {"type": ["integer", "null"], "description": "Total amount paid, in minor units (cents). E.g. $42.50 = 4250."},
            "tax_cents": {"type": ["integer", "null"], "description": "Tax portion of the total, in cents, or null if not itemized."},
            "category_id": {"type": ["string", "null"], "description": "Best-match id from the provided category list, or null if none fit."},
            "description": {"type": ["string", "null"], "description": "Short 3-6 word summary of what was purchased."},
        },
        "required": [],
    },
}
```

Add the endpoint at the end of the file:

```python
@router.post("/scan-receipt")
async def scan_receipt(
    file: UploadFile = File(...),
    ctx: dict = Depends(get_business),
    db: AsyncSession = Depends(get_db),
):
    biz = ctx["business"]
    api_key = biz.get("anthropic_api_key")
    if not api_key:
        raise HTTPException(status_code=400, detail="Anthropic API key not configured. Add it in Settings.")

    if file.content_type not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(status_code=400, detail="Unsupported image type. Use JPEG, PNG, WEBP, or GIF.")

    image_bytes = await file.read()
    image_b64 = base64.standard_b64encode(image_bytes).decode("ascii")

    categories = (await db.execute(
        select(ExpenseCategory).where(ExpenseCategory.business_id == biz["id"], ExpenseCategory.archived.is_not(True))
    )).scalars().all()
    known_categories = [{"id": c.id, "name": c.name} for c in categories]

    system_prompt = (
        "You extract structured expense data from a photo of a receipt. "
        f"Known expense categories: {known_categories}\n"
        "Rules:\n"
        "- Amounts in MINOR UNITS (cents). Never invent amounts not visible on the receipt.\n"
        "- Match category_id to the closest known category by id; if nothing fits, use null.\n"
        "- If a field isn't legible or present, return null for it rather than guessing."
    )

    client_ai = AsyncAnthropic(api_key=api_key)
    try:
        resp = await client_ai.messages.create(
            model="claude-sonnet-4-5",
            max_tokens=1024,
            system=system_prompt,
            tools=[RECEIPT_EXTRACTION_TOOL],
            tool_choice={"type": "tool", "name": "extract_receipt"},
            messages=[{
                "role": "user",
                "content": [
                    {"type": "image", "source": {"type": "base64", "media_type": file.content_type, "data": image_b64}},
                    {"type": "text", "text": "Extract the expense data from this receipt."},
                ],
            }],
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Receipt scan failed: {e}")

    extracted = None
    for block in resp.content:
        if getattr(block, "type", None) == "tool_use":
            extracted = block.input
            break
    if extracted is None:
        raise HTTPException(status_code=500, detail="AI returned no structured data")
    return extracted
```

- [ ] **Step 2: Write the tests**

Append to `backend/tests/test_backend.py`, after `TestExpenses`:

```python
# ---------------------------------------------------------------------------
# AI receipt scanning (graceful handling — mirrors TestAIExtract)
# ---------------------------------------------------------------------------
class TestReceiptScan:
    def test_no_key_returns_400(self, fresh_business):
        s = fresh_business["session"]
        files = {"file": ("receipt.jpg", b"fake-image-bytes", "image/jpeg")}
        # The session sets Content-Type: application/json by default (see
        # conftest.py); overriding it to None here lets `requests` generate
        # the correct multipart/form-data boundary for the file upload.
        r = s.post(f"{API}/expenses/scan-receipt", files=files, headers={"Content-Type": None})
        assert r.status_code == 400
        assert "Anthropic" in r.json().get("detail", "")

    def test_invalid_key_returns_502(self, fresh_business):
        s = fresh_business["session"]
        r = s.patch(f"{API}/settings", json={"anthropic_api_key": "sk-ant-invalid-key-for-test"})
        assert r.status_code == 200
        files = {"file": ("receipt.jpg", b"fake-image-bytes", "image/jpeg")}
        r = s.post(f"{API}/expenses/scan-receipt", files=files, headers={"Content-Type": None})
        assert r.status_code == 502, f"expected 502, got {r.status_code} {r.text}"
```

- [ ] **Step 3: Run the tests**

Run: `cd backend && pytest tests/test_backend.py -k TestReceiptScan -v`
Expected: 2 passed

- [ ] **Step 4: Commit**

```bash
git add backend/app/routers/expenses.py backend/tests/test_backend.py
git commit -m "Add AI receipt scanner endpoint"
```

---

### Task 7: Frontend shared types

**Files:**
- Modify: `frontend/src/lib/types.ts`

**Interfaces:**
- Produces: `Vendor`, `ExpenseCategory`, `Expense` TypeScript types — consumed by Tasks 8, 9, 10.

- [ ] **Step 1: Add the three types**

In `frontend/src/lib/types.ts`, add after the `CatalogItem` type:

```typescript
export type Vendor = {
  id: string;
  business_id: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  address_line1?: string | null;
  city?: string | null;
  region?: string | null;
  postal_code?: string | null;
  country?: string | null;
  notes?: string | null;
  archived?: boolean;
};

export type ExpenseCategory = {
  id: string;
  business_id: string;
  name: string;
  cra_t2125_line?: string | null;
  is_default: boolean;
  archived?: boolean;
};

export type Expense = {
  id: string;
  business_id: string;
  vendor_id?: string | null;
  category_id: string;
  date: string;
  amount_cents: number;
  tax_cents: number;
  currency: string;
  payment_method?: string | null;
  description?: string | null;
  created_at: string;
};
```

- [ ] **Step 2: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: no new errors (this is an additive change to a types file — the command should exit 0, same as before this change).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/types.ts
git commit -m "Add Vendor, ExpenseCategory, and Expense frontend types"
```

---

### Task 8: Vendors screen

**Files:**
- Create: `frontend/src/components/AddVendorModal.tsx`
- Create: `frontend/app/(app)/vendors.tsx`
- Modify: `frontend/app/(app)/_layout.tsx`

**Interfaces:**
- Consumes: `Vendor` type (Task 7); `GET/POST/PATCH/DELETE /vendors` (Task 2).
- Produces: `AddVendorModal` component (props: `visible`, `vendor?`, `onClose`, `onSaved`) — reused by Task 9's vendor picker.

- [ ] **Step 1: Create `AddVendorModal.tsx`**

Create `frontend/src/components/AddVendorModal.tsx`:

```tsx
import { Feather } from "@expo/vector-icons";
import React, { useEffect, useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import { Button } from "@/src/components/Button";
import { Input } from "@/src/components/Input";
import { api } from "@/src/lib/api";
import { colors, radius, spacing } from "@/src/lib/theme";
import type { Vendor } from "@/src/lib/types";

export function AddVendorModal({
  visible,
  vendor,
  onClose,
  onSaved,
}: {
  visible: boolean;
  vendor?: Vendor | null;
  onClose: () => void;
  onSaved: (v: Vendor) => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [addressLine1, setAddressLine1] = useState("");
  const [city, setCity] = useState("");
  const [region, setRegion] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [country, setCountry] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const isEdit = !!vendor;

  useEffect(() => {
    if (!visible) return;
    setName(vendor?.name || "");
    setEmail(vendor?.email || "");
    setPhone(vendor?.phone || "");
    setAddressLine1(vendor?.address_line1 || "");
    setCity(vendor?.city || "");
    setRegion(vendor?.region || "");
    setPostalCode(vendor?.postal_code || "");
    setCountry(vendor?.country || "");
    setNotes(vendor?.notes || "");
    setErr(null);
  }, [visible, vendor]);

  const reset = () => {
    setName(""); setEmail(""); setPhone("");
    setAddressLine1(""); setCity(""); setRegion(""); setPostalCode(""); setCountry(""); setNotes("");
    setErr(null);
  };

  const onSave = async () => {
    if (!name.trim()) return setErr("Name is required");
    setErr(null);
    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        email: email.trim() || null,
        phone: phone.trim() || null,
        address_line1: addressLine1.trim() || null,
        city: city.trim() || null,
        region: region.trim() || null,
        postal_code: postalCode.trim() || null,
        country: country.trim() || null,
        notes: notes.trim() || null,
      };
      const v = isEdit
        ? await api.patch<Vendor>(`/vendors/${vendor!.id}`, payload)
        : await api.post<Vendor>("/vendors", payload);
      if (!isEdit) reset();
      onSaved(v);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <View style={styles.card}>
            <View style={styles.header}>
              <Text style={styles.title}>{isEdit ? "Edit vendor" : "Add vendor"}</Text>
              <TouchableOpacity testID="add-vendor-close" onPress={() => { reset(); onClose(); }}>
                <Feather name="x" size={22} color={colors.muted} />
              </TouchableOpacity>
            </View>
            <ScrollView keyboardShouldPersistTaps="handled" style={styles.scroll}>
              <Input testID="add-vendor-name" label="Name *" value={name} onChangeText={setName} />
              <Input testID="add-vendor-email" label="Email" keyboardType="email-address" autoCapitalize="none" value={email} onChangeText={setEmail} />
              <Input testID="add-vendor-phone" label="Phone" keyboardType="phone-pad" value={phone} onChangeText={setPhone} />
              <Input testID="add-vendor-address" label="Address" value={addressLine1} onChangeText={setAddressLine1} />
              <View style={{ flexDirection: "row", gap: spacing.md }}>
                <View style={{ flex: 1 }}>
                  <Input testID="add-vendor-city" label="City" value={city} onChangeText={setCity} />
                </View>
                <View style={{ flex: 1 }}>
                  <Input testID="add-vendor-region" label="Province/State" value={region} onChangeText={setRegion} />
                </View>
              </View>
              <View style={{ flexDirection: "row", gap: spacing.md }}>
                <View style={{ flex: 1 }}>
                  <Input testID="add-vendor-postal-code" label="Postal/ZIP code" value={postalCode} onChangeText={setPostalCode} />
                </View>
                <View style={{ flex: 1 }}>
                  <Input testID="add-vendor-country" label="Country" value={country} onChangeText={setCountry} />
                </View>
              </View>
              <Input testID="add-vendor-notes" label="Notes" value={notes} onChangeText={setNotes} multiline />
            </ScrollView>
            {err ? <Text style={styles.err}>{err}</Text> : null}
            <Button testID="add-vendor-save" title={isEdit ? "Save Changes" : "Save Vendor"} loading={saving} onPress={onSave} />
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  card: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: spacing.lg,
    paddingBottom: spacing.xxxl,
    maxHeight: "85%",
  },
  scroll: { flexGrow: 0 },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: spacing.lg,
  },
  title: { fontSize: 20, fontWeight: "600", color: colors.onSurface },
  err: { color: colors.error, marginBottom: spacing.sm, fontSize: 14 },
});
```

- [ ] **Step 2: Create the Vendors screen**

Create `frontend/app/(app)/vendors.tsx`:

```tsx
import { Feather } from "@expo/vector-icons";
import { useFocusEffect } from "expo-router";
import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AddVendorModal } from "@/src/components/AddVendorModal";
import { Button } from "@/src/components/Button";
import { EmptyState } from "@/src/components/Card";
import { api } from "@/src/lib/api";
import { confirmAsync } from "@/src/lib/confirm";
import { colors, radius, spacing, typography, webContent } from "@/src/lib/theme";
import type { Vendor } from "@/src/lib/types";

export default function Vendors() {
  const [items, setItems] = useState<Vendor[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Vendor | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const load = useCallback(async () => {
    try {
      const params = search ? `?q=${encodeURIComponent(search)}` : "";
      const data = await api.get<Vendor[]>(`/vendors${params}`);
      setItems(data);
    } catch {
      /* ignore — AuthContext redirects if the session is invalid */
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [search]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const deleteVendor = async (vendor: Vendor) => {
    const ok = await confirmAsync("Delete vendor?", `"${vendor.name}" will be removed from your vendor list. Past expenses are not affected.`);
    if (!ok) return;
    try {
      await api.del(`/vendors/${vendor.id}`);
      setItems((prev) => prev.filter((v) => v.id !== vendor.id));
    } catch (e) {
      Alert.alert("Delete failed", e instanceof Error ? e.message : "Unknown error");
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={[styles.header, webContent]}>
        <Text style={styles.title}>Vendors</Text>
        <TouchableOpacity testID="vendors-add-btn" onPress={() => { setEditing(null); setShowAdd(true); }} style={styles.newBtn}>
          <Feather name="plus" size={16} color={colors.onBrandPrimary} />
          <Text style={styles.newBtnText}>Add</Text>
        </TouchableOpacity>
      </View>

      <View style={[styles.searchWrap, webContent]}>
        <Feather name="search" size={16} color={colors.muted} />
        <TextInput
          testID="vendors-search"
          placeholder="Search vendors"
          placeholderTextColor={colors.muted}
          style={styles.searchInput}
          value={search}
          onChangeText={setSearch}
          onSubmitEditing={load}
        />
      </View>

      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} size="large" color={colors.brand} />
      ) : items.length === 0 ? (
        <EmptyState
          testID="vendors-empty"
          title="No vendors yet"
          subtitle="Add a vendor to attach it to your expenses."
          action={<Button testID="vendors-empty-add" title="Add Vendor" onPress={() => { setEditing(null); setShowAdd(true); }} />}
        />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(i) => i.id}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.brand} />}
          contentContainerStyle={[styles.list, webContent]}
          renderItem={({ item }) => (
            <TouchableOpacity
              testID={`vendor-row-${item.id}`}
              style={styles.row}
              onPress={() => { setEditing(item); setShowAdd(true); }}
              activeOpacity={0.85}
            >
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>{item.name.slice(0, 1).toUpperCase()}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowName}>{item.name}</Text>
                <Text style={styles.rowSub}>{item.email || item.phone || "—"}</Text>
              </View>
              <TouchableOpacity
                testID={`vendor-row-delete-${item.id}`}
                onPress={() => deleteVendor(item)}
                style={styles.deleteBtn}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Feather name="trash-2" size={18} color={colors.error} />
              </TouchableOpacity>
            </TouchableOpacity>
          )}
        />
      )}

      <AddVendorModal
        visible={showAdd}
        vendor={editing}
        onClose={() => setShowAdd(false)}
        onSaved={() => { setShowAdd(false); load(); }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  title: { fontSize: 28, fontWeight: "600", color: colors.onSurface, letterSpacing: -0.5 },
  newBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: colors.brand,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
  },
  newBtnText: { color: colors.onBrandPrimary, fontWeight: "500", fontSize: typography.base },
  searchWrap: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.surfaceSecondary,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
  },
  searchInput: { flex: 1, height: 44, color: colors.onSurface, fontSize: typography.base },
  list: { padding: spacing.lg, paddingBottom: 120 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.sm,
  },
  avatar: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: colors.brandTertiary,
    alignItems: "center", justifyContent: "center",
  },
  avatarText: { color: colors.brand, fontSize: typography.lg, fontWeight: "600" },
  rowName: { fontSize: typography.lg, fontWeight: "500", color: colors.onSurface },
  rowSub: { fontSize: typography.base, color: colors.muted, marginTop: 2 },
  deleteBtn: { padding: 4, marginRight: spacing.xs },
});
```

- [ ] **Step 3: Register the hidden route in the tab layout**

In `frontend/app/(app)/_layout.tsx`, add this `Tabs.Screen` entry after the `catalog` one (before `settings`). `href: null` keeps it out of the tab bar while still making `/vendors` navigable via `router.push`:

```tsx
      <Tabs.Screen
        name="vendors"
        options={{ href: null }}
      />
```

- [ ] **Step 4: Verify manually**

Run the app (`cd frontend && npx expo start`), sign in, navigate to `/vendors` directly (it won't appear in the tab bar). Confirm:
- The empty state shows on a fresh business.
- "Add Vendor" opens the modal, saving a vendor with just a name succeeds and the list updates.
- Tapping a vendor row opens the modal pre-filled for editing.
- Deleting a vendor asks for confirmation and removes it from the list.
- The tab bar itself is unchanged (still 5 tabs — Home, Invoices, Customers, Catalog, Settings).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/AddVendorModal.tsx frontend/app/\(app\)/vendors.tsx frontend/app/\(app\)/_layout.tsx
git commit -m "Add Vendors screen"
```

---

### Task 9: Expenses screen, expense form, and category manager

**Files:**
- Create: `frontend/src/components/ManageCategoriesModal.tsx`
- Create: `frontend/src/components/AddExpenseModal.tsx`
- Create: `frontend/app/(app)/expenses.tsx`
- Modify: `frontend/app/(app)/_layout.tsx`

**Interfaces:**
- Consumes: `Expense`, `ExpenseCategory`, `Vendor` types (Task 7); `/expenses`, `/expense-categories`, `/vendors` endpoints (Tasks 2, 3, 5); `AddVendorModal` (Task 8).
- Produces: `AddExpenseModal` component with an `ExpensePrefill` type (`{vendor_name, date, amount_cents, tax_cents, category_id, description}`, all optional/nullable) — this exact shape is what Task 10's scan result must match to pre-fill the form.

- [ ] **Step 1: Create `ManageCategoriesModal.tsx`**

Create `frontend/src/components/ManageCategoriesModal.tsx`:

```tsx
import { Feather } from "@expo/vector-icons";
import React, { useState } from "react";
import { Alert, Modal, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";

import { Button } from "@/src/components/Button";
import { api } from "@/src/lib/api";
import { confirmAsync } from "@/src/lib/confirm";
import { colors, radius, spacing, typography } from "@/src/lib/theme";
import type { ExpenseCategory } from "@/src/lib/types";

export function ManageCategoriesModal({
  visible,
  categories,
  onClose,
  onChanged,
}: {
  visible: boolean;
  categories: ExpenseCategory[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [newName, setNewName] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const addCategory = async () => {
    if (!newName.trim()) return;
    setSaving(true);
    setErr(null);
    try {
      await api.post("/expense-categories", { name: newName.trim() });
      setNewName("");
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to add category");
    } finally {
      setSaving(false);
    }
  };

  const removeCategory = async (category: ExpenseCategory) => {
    const ok = await confirmAsync("Remove category?", `"${category.name}" will no longer appear when logging expenses.`);
    if (!ok) return;
    try {
      await api.del(`/expense-categories/${category.id}`);
      onChanged();
    } catch (e) {
      Alert.alert("Can't remove category", e instanceof Error ? e.message : "This category is used by existing expenses.");
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.title}>Expense categories</Text>
            <TouchableOpacity testID="manage-categories-close" onPress={onClose}>
              <Feather name="x" size={22} color={colors.muted} />
            </TouchableOpacity>
          </View>
          <ScrollView style={styles.scroll}>
            {categories.map((c) => (
              <View key={c.id} style={styles.row}>
                <Text style={styles.rowText}>{c.name}</Text>
                <TouchableOpacity testID={`manage-categories-delete-${c.id}`} onPress={() => removeCategory(c)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Feather name="trash-2" size={18} color={colors.error} />
                </TouchableOpacity>
              </View>
            ))}
          </ScrollView>
          <View style={styles.addRow}>
            <TextInput
              testID="manage-categories-new-name"
              placeholder="New category name"
              placeholderTextColor={colors.muted}
              style={styles.input}
              value={newName}
              onChangeText={setNewName}
            />
            <Button testID="manage-categories-add" title="Add" loading={saving} onPress={addCategory} />
          </View>
          {err ? <Text style={styles.err}>{err}</Text> : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  card: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: spacing.lg,
    paddingBottom: spacing.xxxl,
    maxHeight: "85%",
  },
  scroll: { flexGrow: 0, maxHeight: 320 },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: spacing.lg,
  },
  title: { fontSize: 20, fontWeight: "600", color: colors.onSurface },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  rowText: { fontSize: typography.lg, color: colors.onSurface },
  addRow: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.md, alignItems: "center" },
  input: {
    flex: 1,
    minHeight: 48,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    fontSize: typography.lg,
    color: colors.onSurface,
  },
  err: { color: colors.error, marginTop: spacing.sm, fontSize: 14 },
});
```

- [ ] **Step 2: Create `AddExpenseModal.tsx`**

Create `frontend/src/components/AddExpenseModal.tsx`:

```tsx
import { Feather } from "@expo/vector-icons";
import React, { useEffect, useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import { AddVendorModal } from "@/src/components/AddVendorModal";
import { Button } from "@/src/components/Button";
import { DateField } from "@/src/components/DateField";
import { Input } from "@/src/components/Input";
import { api } from "@/src/lib/api";
import { parseCents } from "@/src/lib/money";
import { colors, radius, spacing, typography } from "@/src/lib/theme";
import type { Expense, ExpenseCategory, Vendor } from "@/src/lib/types";

export type ExpensePrefill = {
  vendor_name?: string | null;
  date?: string | null;
  amount_cents?: number | null;
  tax_cents?: number | null;
  category_id?: string | null;
  description?: string | null;
};

function centsToInput(cents?: number | null): string {
  if (cents === null || cents === undefined) return "";
  return (cents / 100).toFixed(2);
}

export function AddExpenseModal({
  visible,
  expense,
  prefill,
  categories,
  vendors,
  onClose,
  onSaved,
  onVendorCreated,
}: {
  visible: boolean;
  expense?: Expense | null;
  prefill?: ExpensePrefill | null;
  categories: ExpenseCategory[];
  vendors: Vendor[];
  onClose: () => void;
  onSaved: (e: Expense) => void;
  onVendorCreated: (v: Vendor) => void;
}) {
  const [date, setDate] = useState("");
  const [amount, setAmount] = useState("");
  const [tax, setTax] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("");
  const [description, setDescription] = useState("");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [vendorId, setVendorId] = useState<string | null>(null);
  const [detectedVendorName, setDetectedVendorName] = useState<string | null>(null);
  const [showPickCategory, setShowPickCategory] = useState(false);
  const [showPickVendor, setShowPickVendor] = useState(false);
  const [showAddVendor, setShowAddVendor] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const isEdit = !!expense;

  useEffect(() => {
    if (!visible) return;
    if (expense) {
      setDate(expense.date);
      setAmount(centsToInput(expense.amount_cents));
      setTax(centsToInput(expense.tax_cents));
      setPaymentMethod(expense.payment_method || "");
      setDescription(expense.description || "");
      setCategoryId(expense.category_id);
      setVendorId(expense.vendor_id || null);
      setDetectedVendorName(null);
    } else {
      setDate(prefill?.date || new Date().toISOString().slice(0, 10));
      setAmount(centsToInput(prefill?.amount_cents));
      setTax(centsToInput(prefill?.tax_cents));
      setPaymentMethod("");
      setDescription(prefill?.description || "");
      setCategoryId(prefill?.category_id || null);
      setVendorId(null);
      setDetectedVendorName(prefill?.vendor_name || null);
    }
    setErr(null);
  }, [visible, expense, prefill]);

  const reset = () => {
    setDate(""); setAmount(""); setTax(""); setPaymentMethod(""); setDescription("");
    setCategoryId(null); setVendorId(null); setDetectedVendorName(null); setErr(null);
  };

  const selectedCategory = categories.find((c) => c.id === categoryId);
  const selectedVendor = vendors.find((v) => v.id === vendorId);

  const onSave = async () => {
    if (!date) return setErr("Date is required");
    if (!categoryId) return setErr("Category is required");
    if (!amount || parseCents(amount) <= 0) return setErr("Amount must be greater than 0");
    setErr(null);
    setSaving(true);
    try {
      const payload = {
        vendor_id: vendorId,
        category_id: categoryId,
        date,
        amount_cents: parseCents(amount),
        tax_cents: parseCents(tax || "0"),
        payment_method: paymentMethod.trim() || null,
        description: description.trim() || null,
      };
      const e = isEdit
        ? await api.patch<Expense>(`/expenses/${expense!.id}`, payload)
        : await api.post<Expense>("/expenses", payload);
      if (!isEdit) reset();
      onSaved(e);
    } catch (err2) {
      setErr(err2 instanceof Error ? err2.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <View style={styles.card}>
            <View style={styles.header}>
              <Text style={styles.title}>{isEdit ? "Edit expense" : "Add expense"}</Text>
              <TouchableOpacity testID="add-expense-close" onPress={() => { reset(); onClose(); }}>
                <Feather name="x" size={22} color={colors.muted} />
              </TouchableOpacity>
            </View>
            <ScrollView keyboardShouldPersistTaps="handled" style={styles.scroll}>
              <DateField testID="add-expense-date" label="Date" value={date} onChange={setDate} />
              <Input testID="add-expense-amount" label="Amount *" keyboardType="decimal-pad" value={amount} onChangeText={setAmount} placeholder="0.00" />
              <Input testID="add-expense-tax" label="Tax" keyboardType="decimal-pad" value={tax} onChangeText={setTax} placeholder="0.00" />

              <Text style={styles.label}>Category *</Text>
              <TouchableOpacity testID="add-expense-pick-category" style={styles.picker} onPress={() => setShowPickCategory(true)}>
                <Text style={selectedCategory ? styles.pickerText : styles.pickerPlaceholder}>
                  {selectedCategory?.name || "Select a category"}
                </Text>
                <Feather name="chevron-right" size={18} color={colors.muted} />
              </TouchableOpacity>

              <Text style={styles.label}>Vendor</Text>
              {detectedVendorName && !vendorId ? (
                <Text style={styles.hint}>Detected on receipt: {detectedVendorName} — link a vendor below if you want to track it.</Text>
              ) : null}
              <TouchableOpacity testID="add-expense-pick-vendor" style={styles.picker} onPress={() => setShowPickVendor(true)}>
                <Text style={selectedVendor ? styles.pickerText : styles.pickerPlaceholder}>
                  {selectedVendor?.name || "No vendor (optional)"}
                </Text>
                <Feather name="chevron-right" size={18} color={colors.muted} />
              </TouchableOpacity>

              <Input testID="add-expense-payment-method" label="Payment method" value={paymentMethod} onChangeText={setPaymentMethod} placeholder="e.g. Visa, Cash, E-transfer" />
              <Input testID="add-expense-description" label="Description" value={description} onChangeText={setDescription} multiline />
            </ScrollView>
            {err ? <Text style={styles.err}>{err}</Text> : null}
            <Button testID="add-expense-save" title={isEdit ? "Save Changes" : "Save Expense"} loading={saving} onPress={onSave} />
          </View>
        </KeyboardAvoidingView>
      </View>

      <Modal visible={showPickCategory} animationType="slide" transparent onRequestClose={() => setShowPickCategory(false)}>
        <View style={styles.overlay}>
          <View style={styles.card}>
            <View style={styles.header}>
              <Text style={styles.title}>Select a category</Text>
              <TouchableOpacity testID="pick-category-close" onPress={() => setShowPickCategory(false)}>
                <Feather name="x" size={22} color={colors.muted} />
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.scroll}>
              {categories.map((c) => (
                <TouchableOpacity
                  key={c.id}
                  testID={`pick-category-${c.id}`}
                  style={styles.pickRow}
                  onPress={() => { setCategoryId(c.id); setShowPickCategory(false); }}
                >
                  <Text style={styles.pickerText}>{c.name}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>

      <Modal visible={showPickVendor} animationType="slide" transparent onRequestClose={() => setShowPickVendor(false)}>
        <View style={styles.overlay}>
          <View style={styles.card}>
            <View style={styles.header}>
              <Text style={styles.title}>Select a vendor</Text>
              <TouchableOpacity testID="pick-vendor-close" onPress={() => setShowPickVendor(false)}>
                <Feather name="x" size={22} color={colors.muted} />
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.scroll}>
              <TouchableOpacity
                testID="pick-vendor-none"
                style={styles.pickRow}
                onPress={() => { setVendorId(null); setShowPickVendor(false); }}
              >
                <Text style={styles.pickerText}>No vendor</Text>
              </TouchableOpacity>
              {vendors.length === 0 ? (
                <Text style={styles.hint}>No vendors yet.</Text>
              ) : (
                vendors.map((v) => (
                  <TouchableOpacity
                    key={v.id}
                    testID={`pick-vendor-${v.id}`}
                    style={styles.pickRow}
                    onPress={() => { setVendorId(v.id); setShowPickVendor(false); }}
                  >
                    <Text style={styles.pickerText}>{v.name}</Text>
                  </TouchableOpacity>
                ))
              )}
            </ScrollView>
            <Button
              testID="pick-vendor-new"
              title="+ Add new vendor"
              variant="secondary"
              onPress={() => { setShowPickVendor(false); setShowAddVendor(true); }}
            />
          </View>
        </View>
      </Modal>

      <AddVendorModal
        visible={showAddVendor}
        onClose={() => setShowAddVendor(false)}
        onSaved={(v) => {
          onVendorCreated(v);
          setVendorId(v.id);
          setShowAddVendor(false);
        }}
      />
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  card: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: spacing.lg,
    paddingBottom: spacing.xxxl,
    maxHeight: "85%",
  },
  scroll: { flexGrow: 0 },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: spacing.lg,
  },
  title: { fontSize: 20, fontWeight: "600", color: colors.onSurface },
  err: { color: colors.error, marginBottom: spacing.sm, fontSize: 14 },
  label: {
    fontSize: typography.sm,
    color: colors.onSurfaceTertiary,
    marginBottom: spacing.xs,
    fontWeight: typography.weightMedium,
  },
  hint: { fontSize: typography.sm, color: colors.muted, marginBottom: spacing.xs },
  picker: {
    minHeight: 48,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.md,
  },
  pickerText: { fontSize: typography.lg, color: colors.onSurface },
  pickerPlaceholder: { fontSize: typography.lg, color: colors.muted },
  pickRow: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
});
```

- [ ] **Step 3: Create the Expenses screen**

Create `frontend/app/(app)/expenses.tsx`:

```tsx
import { Feather } from "@expo/vector-icons";
import { useFocusEffect } from "expo-router";
import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AddExpenseModal } from "@/src/components/AddExpenseModal";
import { Button } from "@/src/components/Button";
import { EmptyState } from "@/src/components/Card";
import { ManageCategoriesModal } from "@/src/components/ManageCategoriesModal";
import { api } from "@/src/lib/api";
import { confirmAsync } from "@/src/lib/confirm";
import { formatMoney } from "@/src/lib/money";
import { colors, radius, spacing, typography, webContent } from "@/src/lib/theme";
import type { Expense, ExpenseCategory, Vendor } from "@/src/lib/types";

export default function Expenses() {
  const [items, setItems] = useState<Expense[]>([]);
  const [categories, setCategories] = useState<ExpenseCategory[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState<Expense | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [showManageCategories, setShowManageCategories] = useState(false);

  const load = useCallback(async () => {
    try {
      const [exp, cats, vends] = await Promise.all([
        api.get<Expense[]>("/expenses"),
        api.get<ExpenseCategory[]>("/expense-categories"),
        api.get<Vendor[]>("/vendors"),
      ]);
      setItems(exp);
      setCategories(cats);
      setVendors(vends);
    } catch {
      /* ignore — AuthContext redirects if the session is invalid */
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const categoryName = (id: string) => categories.find((c) => c.id === id)?.name || "Uncategorized";
  const vendorName = (id?: string | null) => (id ? vendors.find((v) => v.id === id)?.name : null);

  const deleteExpense = async (expense: Expense) => {
    const ok = await confirmAsync("Delete expense?", "This can't be undone.");
    if (!ok) return;
    try {
      await api.del(`/expenses/${expense.id}`);
      setItems((prev) => prev.filter((e) => e.id !== expense.id));
    } catch (e) {
      Alert.alert("Delete failed", e instanceof Error ? e.message : "Unknown error");
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={[styles.header, webContent]}>
        <Text style={styles.title}>Expenses</Text>
        <View style={styles.headerActions}>
          <TouchableOpacity testID="expenses-manage-categories" onPress={() => setShowManageCategories(true)} style={styles.iconBtn}>
            <Feather name="tag" size={18} color={colors.brand} />
          </TouchableOpacity>
          <TouchableOpacity testID="expenses-add-btn" onPress={() => { setEditing(null); setShowAdd(true); }} style={styles.newBtn}>
            <Feather name="plus" size={16} color={colors.onBrandPrimary} />
            <Text style={styles.newBtnText}>Add</Text>
          </TouchableOpacity>
        </View>
      </View>

      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} size="large" color={colors.brand} />
      ) : items.length === 0 ? (
        <EmptyState
          testID="expenses-empty"
          title="No expenses yet"
          subtitle="Log your first expense manually or scan a receipt."
          action={<Button testID="expenses-empty-add" title="Add Expense" onPress={() => { setEditing(null); setShowAdd(true); }} />}
        />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(i) => i.id}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.brand} />}
          contentContainerStyle={[styles.list, webContent]}
          renderItem={({ item }) => (
            <TouchableOpacity
              testID={`expense-row-${item.id}`}
              style={styles.row}
              onPress={() => { setEditing(item); setShowAdd(true); }}
              activeOpacity={0.85}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.rowName}>{categoryName(item.category_id)}</Text>
                <Text style={styles.rowSub}>{vendorName(item.vendor_id) || item.description || item.date}</Text>
              </View>
              <Text style={styles.rowAmount}>{formatMoney(item.amount_cents, item.currency)}</Text>
              <TouchableOpacity
                testID={`expense-row-delete-${item.id}`}
                onPress={() => deleteExpense(item)}
                style={styles.deleteBtn}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Feather name="trash-2" size={18} color={colors.error} />
              </TouchableOpacity>
            </TouchableOpacity>
          )}
        />
      )}

      <AddExpenseModal
        visible={showAdd}
        expense={editing}
        categories={categories}
        vendors={vendors}
        onClose={() => setShowAdd(false)}
        onSaved={() => { setShowAdd(false); load(); }}
        onVendorCreated={(v) => setVendors((prev) => [...prev, v])}
      />

      <ManageCategoriesModal
        visible={showManageCategories}
        categories={categories}
        onClose={() => setShowManageCategories(false)}
        onChanged={load}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  title: { fontSize: 28, fontWeight: "600", color: colors.onSurface, letterSpacing: -0.5 },
  headerActions: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  iconBtn: {
    width: 40, height: 40, borderRadius: radius.pill,
    alignItems: "center", justifyContent: "center",
    borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surfaceSecondary,
  },
  newBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: colors.brand,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
  },
  newBtnText: { color: colors.onBrandPrimary, fontWeight: "500", fontSize: typography.base },
  list: { padding: spacing.lg, paddingBottom: 120 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.sm,
  },
  rowName: { fontSize: typography.lg, fontWeight: "500", color: colors.onSurface },
  rowSub: { fontSize: typography.base, color: colors.muted, marginTop: 2 },
  rowAmount: { fontSize: typography.lg, fontWeight: "600", color: colors.onSurface },
  deleteBtn: { padding: 4, marginLeft: spacing.xs },
});
```

- [ ] **Step 4: Register the visible Expenses tab**

In `frontend/app/(app)/_layout.tsx`, add this `Tabs.Screen` entry after `catalog` and before `vendors` (the `href: null` one from Task 8):

```tsx
      <Tabs.Screen
        name="expenses"
        options={{
          title: "Expenses",
          tabBarIcon: ({ color, size }) => <Feather name="credit-card" size={size} color={color} />,
        }}
      />
```

- [ ] **Step 5: Verify manually**

Run the app, sign in with a fresh business. Confirm:
- The tab bar now shows 6 tabs, with "Expenses" between Catalog and Settings.
- The Expenses empty state appears; "Add Expense" opens the form.
- Category picker shows all 14 default categories; selecting one and an amount, then saving, creates the expense and it appears in the list with the category name and formatted amount.
- Vendor picker's "+ Add new vendor" opens `AddVendorModal` inline, and the newly created vendor becomes immediately selected and shows in the list going forward.
- The tag icon opens category management; adding a new category makes it appear in the picker; deleting a category that's in use shows the "can't remove" alert (matching the backend's 409).
- Tapping an existing expense row opens the form pre-filled for editing.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/ManageCategoriesModal.tsx frontend/src/components/AddExpenseModal.tsx frontend/app/\(app\)/expenses.tsx frontend/app/\(app\)/_layout.tsx
git commit -m "Add Expenses screen with manual entry and category management"
```

---

### Task 10: Camera-based receipt scan integration

**Files:**
- Modify: `frontend/package.json` (add `expo-image-picker`)
- Modify: `frontend/src/lib/api.ts`
- Modify: `frontend/app/(app)/expenses.tsx`

**Interfaces:**
- Consumes: `POST /expenses/scan-receipt` (Task 6); `ExpensePrefill` type and `AddExpenseModal`'s `prefill` prop (Task 9).
- Produces: `scanReceipt(fileUri, fileName, mimeType)` in `frontend/src/lib/api.ts`, returning `ScanReceiptResult` (same shape as `ExpensePrefill`).

- [ ] **Step 1: Install `expo-image-picker`**

Run: `cd frontend && npx expo install expo-image-picker`
Expected: `package.json` gains an `expo-image-picker` dependency at the version Expo's SDK resolves for this project.

- [ ] **Step 2: Add `scanReceipt` to `api.ts`**

In `frontend/src/lib/api.ts`, add after the existing `api` object (before `saveToken`):

```typescript
export type ScanReceiptResult = {
  vendor_name: string | null;
  date: string | null;
  amount_cents: number | null;
  tax_cents: number | null;
  category_id: string | null;
  description: string | null;
};

// Uses raw fetch (not apiFetch) because this is a multipart upload, not
// JSON. Reading the picked image through fetch()+.blob() — rather than
// building a React-Native-specific {uri, name, type} FormData entry —
// works identically on native and web, per Expo's documented pattern for
// expo-image-picker uploads.
export async function scanReceipt(fileUri: string, fileName: string, mimeType: string): Promise<ScanReceiptResult> {
  const token = await getToken();
  const fileBlob = await (await fetch(fileUri)).blob();
  const form = new FormData();
  form.append("file", fileBlob, fileName);

  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${BASE_URL}/api/expenses/scan-receipt`, {
    method: "POST",
    headers,
    body: form,
  });
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }

  if (!res.ok) {
    const detail = body && typeof body === "object" && "detail" in body ? (body as { detail: unknown }).detail : undefined;
    const message = extractErrorMessage(detail, res.status);
    const err = new Error(message) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return body as ScanReceiptResult;
}
```

- [ ] **Step 3: Wire the camera button into the Expenses screen**

In `frontend/app/(app)/expenses.tsx`:

Add imports:
```tsx
import * as ImagePicker from "expo-image-picker";
```
```tsx
import { Platform } from "react-native";
```
(add `Platform` to the existing `react-native` import list rather than a second import line)

Change:
```tsx
import { api } from "@/src/lib/api";
```
to:
```tsx
import { api, scanReceipt } from "@/src/lib/api";
```

Add near the other imports:
```tsx
import type { ExpensePrefill } from "@/src/components/AddExpenseModal";
```

Add state, alongside the existing `useState` calls:
```tsx
  const [prefill, setPrefill] = useState<ExpensePrefill | null>(null);
  const [scanning, setScanning] = useState(false);
```

Add the handler, above the `return (`:
```tsx
  const scanReceiptPhoto = async () => {
    let result: ImagePicker.ImagePickerResult;
    if (Platform.OS === "web") {
      result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.7 });
    } else {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        Alert.alert("Camera access needed", "Enable camera access in your device settings to scan receipts.");
        return;
      }
      result = await ImagePicker.launchCameraAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.7 });
    }
    if (result.canceled || !result.assets?.[0]) return;

    const asset = result.assets[0];
    setScanning(true);
    try {
      const extracted = await scanReceipt(asset.uri, asset.fileName || "receipt.jpg", asset.mimeType || "image/jpeg");
      setPrefill(extracted);
    } catch {
      setPrefill(null);
      Alert.alert("Couldn't read that receipt", "Enter the expense manually instead.");
    } finally {
      setScanning(false);
      setEditing(null);
      setShowAdd(true);
    }
  };
```

Add the camera button to the header, next to the existing `expenses-manage-categories` button:
```tsx
          <TouchableOpacity testID="expenses-scan-btn" onPress={scanReceiptPhoto} style={styles.iconBtn} disabled={scanning}>
            {scanning ? <ActivityIndicator size="small" color={colors.brand} /> : <Feather name="camera" size={18} color={colors.brand} />}
          </TouchableOpacity>
```

Pass `prefill` through to the modal and clear it on close:
```tsx
      <AddExpenseModal
        visible={showAdd}
        expense={editing}
        prefill={prefill}
        categories={categories}
        vendors={vendors}
        onClose={() => { setShowAdd(false); setPrefill(null); }}
        onSaved={() => { setShowAdd(false); setPrefill(null); load(); }}
        onVendorCreated={(v) => setVendors((prev) => [...prev, v])}
      />
```

- [ ] **Step 4: Verify manually**

On a business with a valid `anthropic_api_key` configured in Settings (add a real key for this check):
- Web: the camera icon opens a file picker (since `launchCameraAsync` isn't supported on web); pick a photo of a receipt (or any image); confirm the Add Expense form opens with whatever fields Claude could extract pre-filled, and a "Detected on receipt: ..." hint shows if a vendor name came back.
- Native (iOS/Android simulator or device): the camera icon requests camera permission, opens the camera, and behaves the same way after taking a photo.
- With no `anthropic_api_key` configured: confirm the scan fails gracefully — the form still opens (empty) with the "Couldn't read that receipt" alert, not a crash or a dead end.

- [ ] **Step 5: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/src/lib/api.ts frontend/app/\(app\)/expenses.tsx
git commit -m "Add camera-based AI receipt scanning to Expenses"
```

---

## Self-review notes

- **Spec coverage:** Every section of `docs/superpowers/specs/2026-08-05-expense-management-design.md` maps to a task — data model (1), vendors (2, 8), categories + seeding (3, 4, 9), expenses + filters (5, 9), scanner (6, 10), frontend types (7). No spec requirement without a task.
- **Type consistency verified:** `ExpensePrefill` (Task 9) and `ScanReceiptResult` (Task 10) intentionally share the same field shape so Task 10's fetch result can be passed straight into `AddExpenseModal`'s `prefill` prop with no mapping step. `Vendor`/`ExpenseCategory`/`Expense` (Task 7) are used with identical field names in every later task.
- **No route registered before its screen exists:** Tasks 8, 9, and 10 each add their `Tabs.Screen` entry in the same task that creates the corresponding route file, so the app is never left pointing at a missing screen between tasks.
