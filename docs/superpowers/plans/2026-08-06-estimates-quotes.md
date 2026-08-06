# Estimates & Quotes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let InvoiceAI create, send, and track quotes that a customer approves before any billable work is committed, converting an accepted estimate into a real invoice with one action.

**Architecture:** Estimates are a structural clone of the existing Invoice/LineItem engine — same totals math, same atomic numbering, same DRAFT-is-editable rule — sharing code with `invoices.py` rather than duplicating it. Two small extractions (`compute_totals` → `app/totals.py`, the PDF-render/SSRF-guard/Supabase-upload logic → `app/pdf_export.py`) happen first so both routers import the same code. A new `estimates.py` router adds CRUD plus five lifecycle actions (send/accept/decline/convert/duplicate) and reuses `invoices.py`'s own serialization helper when it creates a real invoice on convert. On the frontend, Estimates fold into the existing Invoices screen via a segmented toggle rather than a new tab.

**Tech Stack:** FastAPI, SQLAlchemy async + asyncpg, Alembic, Playwright (PDF render), Expo Router / React Native Web.

## Global Constraints

- Money fields are `_cents` integer minor units throughout — never floats. (Spec, reused from the invoice engine.)
- Stored estimate status lifecycle is exactly `DRAFT → SENT → ACCEPTED / DECLINED → CONVERTED`. No `VIEWED`, no stored `EXPIRED` — an estimate's `expiry_date` having passed is a UI-computed badge on a `SENT` estimate, never written to the database. (Spec, Scope.)
- Acceptance/decline is manual only — no customer-facing accept/decline page exists or is built by this plan. (Spec, Scope.)
- `POST /estimates/{id}/convert` is allowed from DRAFT, SENT, or ACCEPTED; blocked (400) from DECLINED or CONVERTED. It creates a real `Invoice` and therefore re-runs the same plan-limit check `create_invoice` does. (Spec, Backend.)
- `DELETE /estimates/{id}` is a genuine hard delete, but only while `status == "DRAFT"` (400 otherwise) — unlike invoices, which never hard-delete. (Spec, Backend.)
- Estimates get no new tab-bar slot. They fold into the existing `frontend/app/(app)/invoices.tsx` screen via an Invoices/Estimates segmented toggle. (Spec, Scope — tab bar is already at 6 items.)
- `compute_totals` and the SSRF-guard/PDF-render/Supabase-upload logic move out of `invoices.py` into `backend/app/totals.py` and `backend/app/pdf_export.py` respectively, imported by both `invoices.py` and `estimates.py` — neither is duplicated. (Spec, Backend "Shared-code note".)
- Every new router/schema/model follows the exact conventions already in `backend/app/routers/invoices.py`: `PG_UUID(as_uuid=False)` string PKs via `new_id()`, the `get_business` dependency, `to_dict()`-based serialization, business-scoped queries, atomic numbering via `sql_update(...).returning(...)`.
- New frontend screens mirror `frontend/app/invoices/new.tsx` / `[id].tsx` structurally, but the Estimates creation form is manual-entry only — no AI-draft mode, no Stripe payment URL field (estimates don't take payment).
- Backend tests are black-box HTTP integration tests against a running server using `requests` (see `backend/tests/test_backend.py`, `backend/tests/conftest.py`) — `TEST_`-prefixed data, `auth_client`/`fresh_business` fixtures.

---

### Task 1: Extract `compute_totals` into `backend/app/totals.py`

**Files:**
- Create: `backend/app/totals.py`
- Modify: `backend/app/routers/invoices.py` (remove the function definition, add an import)

**Interfaces:**
- Produces: `compute_totals(line_items: List[dict], discount_type: Optional[str] = None, discount_value: int = 0) -> dict` — importable from `app.totals`, identical signature and behavior to the function it replaces. Used by Task 4's `estimates.py`.

- [ ] **Step 1: Create the shared totals module**

Create `backend/app/totals.py`:

```python
"""Line-item totals engine (single source of truth) — shared by invoices
and estimates so their money math can never drift apart.
"""
from typing import List, Optional


def compute_totals(
    line_items: List[dict],
    discount_type: Optional[str] = None,
    discount_value: int = 0,
) -> dict:
    subtotal = 0
    tax_total = 0
    tax_breakdown: dict = {}

    for li in line_items:
        qty = float(li.get("quantity", 1))
        unit_price = int(li.get("unit_price_cents", 0))
        line_subtotal = round(qty * unit_price)
        tax_pct = float(li.get("tax_percent", 0) or 0)
        line_tax = round(line_subtotal * tax_pct / 100)
        subtotal += line_subtotal
        tax_total += line_tax
        if tax_pct > 0:
            key = f"{tax_pct}"
            tax_breakdown[key] = tax_breakdown.get(key, 0) + line_tax

    discount_cents = 0
    if discount_type == "PERCENT" and discount_value:
        discount_cents = round(subtotal * (discount_value / 10000))
    elif discount_type == "FIXED" and discount_value:
        discount_cents = int(discount_value)

    total = subtotal + tax_total - discount_cents
    if total < 0:
        total = 0

    return {
        "subtotal_cents": subtotal,
        "tax_total_cents": tax_total,
        "tax_breakdown": [{"percent": float(k), "amount_cents": v} for k, v in tax_breakdown.items()],
        "discount_cents": discount_cents,
        "total_cents": total,
    }
```

- [ ] **Step 2: Remove the function from `invoices.py` and import it instead**

In `backend/app/routers/invoices.py`, delete the entire `compute_totals` function definition — the block starting with:
```python
# ---------------------------------------------------------------------------
# Totals engine (single source of truth) — unchanged logic from pre-migration
# ---------------------------------------------------------------------------
def compute_totals(
```
and ending at the closing `}` / return statement right before `def _line_item_dict(li: LineItem) -> dict:`.

Add this import near the top of the file, alongside the other `from app.*` imports:
```python
from app.totals import compute_totals
```

Every existing call site (`compute_totals(...)` inside `create_invoice`, `update_invoice`, `_serialize_invoice`) is unchanged — same name, same signature, same behavior.

- [ ] **Step 3: Verify no regression**

This worktree needs its own venv, `.env`, and a running server — see the "Running the backend server and tests" note in Task 4 (the first task that adds new tests) for the exact setup. For this task, once the server is running:

Run: `pytest tests/test_backend.py -k TestInvoicesLifecycle -v`
Expected: all pass, identical to before this change (the totals math is byte-for-byte the same code, just relocated).

- [ ] **Step 4: Commit**

```bash
git add backend/app/totals.py backend/app/routers/invoices.py
git commit -m "Extract compute_totals into a shared app.totals module"
```

---

### Task 2: Extract the PDF/SSRF logic into `backend/app/pdf_export.py`

**Files:**
- Create: `backend/app/pdf_export.py`
- Modify: `backend/app/routers/invoices.py` (remove the SSRF helpers and the render/upload body of `email_pdf`, replace with a call to the extracted function)

**Interfaces:**
- Produces: `async def render_and_upload_pdf(html: str, business_id: str, object_id: str) -> str` — importable from `app.pdf_export`, returns the uploaded PDF's public URL, raises `HTTPException(502, ...)` on upload failure. Used by Task 6's `estimates.py` email-pdf endpoint.

- [ ] **Step 1: Create the shared PDF export module**

Create `backend/app/pdf_export.py`:

```python
"""Shared PDF rendering + hosting for the "Email PDF" action on both
invoices and estimates: Playwright renders client-supplied HTML to a PDF,
which is uploaded to Supabase Storage and returned as a public URL. Also
holds the SSRF guard, which must not drift between the two callers.
"""
import asyncio
import ipaddress
import os
import socket
from typing import Optional
from urllib.parse import urlparse

import httpx
from fastapi import HTTPException
from playwright.async_api import async_playwright


def _is_blocked_address(ip_str: str) -> bool:
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        return True  # unparseable -> fail closed
    return ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified


async def _is_blocked_host(hostname: Optional[str]) -> bool:
    """SSRF guard for the Chromium instance below: it renders client-supplied
    HTML with network access enabled (needed for a business's logo_url, the
    only legitimate external fetch the HTML templates embed) - without this,
    any authenticated business could point an <img> at an internal service or
    cloud metadata endpoint (e.g. 169.254.169.254) and have the response
    rendered straight into the returned PDF."""
    if not hostname:
        return True
    try:
        # Resolving here (rather than just regexing the URL string) also
        # blocks a hostname that merely *resolves* to a private/link-local
        # address, not just a literal IP in the URL.
        infos = await asyncio.to_thread(socket.getaddrinfo, hostname, None)
    except socket.gaierror:
        return True  # can't resolve -> fail closed
    return any(_is_blocked_address(info[4][0]) for info in infos)


async def _block_private_network_requests(route) -> None:
    url = route.request.url
    if url.startswith(("data:", "about:", "blob:")):
        await route.continue_()
        return
    hostname = urlparse(url).hostname
    if await _is_blocked_host(hostname):
        await route.abort()
    else:
        await route.continue_()


async def render_and_upload_pdf(html: str, business_id: str, object_id: str) -> str:
    """Render `html` to a PDF via a sandboxed headless Chromium (SSRF-guarded),
    upload it to the shared Supabase Storage bucket under
    `<business_id>/<object_id>.pdf`, and return its public URL.

    `object_id` must be a value with no user-controlled content (e.g. a
    database-generated UUID) - it becomes part of a shared public bucket's
    object path, and a tenant-settable field (like an invoice/estimate
    number, which is influenced by the unsanitized Business.invoice_prefix/
    estimate_prefix) could otherwise inject "/" or "../" into that path.
    """
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        try:
            page = await browser.new_page()
            await page.route("**/*", _block_private_network_requests)
            await page.set_content(html, wait_until="networkidle")
            pdf_bytes = await page.pdf(format="A4", print_background=True)
        finally:
            await browser.close()

    supabase_url = os.environ["SUPABASE_URL"].rstrip("/")
    service_key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    object_path = f"{business_id}/{object_id}.pdf"
    upload_url = f"{supabase_url}/storage/v1/object/InvoiceAI/{object_path}"

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            upload_url,
            content=pdf_bytes,
            headers={
                "Authorization": f"Bearer {service_key}",
                "Content-Type": "application/pdf",
                "x-upsert": "true",
            },
        )
    if resp.status_code >= 300:
        raise HTTPException(status_code=502, detail="Failed to upload PDF")

    return f"{supabase_url}/storage/v1/object/public/InvoiceAI/{object_path}"
```

- [ ] **Step 2: Simplify `invoices.py`'s `email_pdf` endpoint and drop now-unused imports**

In `backend/app/routers/invoices.py`, delete these top-of-file imports (they are used exclusively by the code being removed in this step):
```python
import asyncio
import ipaddress
import os
import socket
```
and
```python
from urllib.parse import urlparse
```
and
```python
import httpx
```
and
```python
from playwright.async_api import async_playwright
```

Delete the entire `_is_blocked_address`, `_is_blocked_host`, and `_block_private_network_requests` function definitions.

Replace the body of the `email_pdf` endpoint. It currently ends with:
```python
@router.post("/{invoice_id}/email-pdf")
async def email_pdf(
    invoice_id: str, payload: EmailPdfIn, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)
):
    biz_id = ctx["business"]["id"]
    inv = await _get_invoice_with_items(db, invoice_id, biz_id)
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")

    async with async_playwright() as p:
        ...
    public_url = f"{supabase_url}/storage/v1/object/public/InvoiceAI/{object_path}"
    return {"url": public_url}
```

Replace the whole function with:
```python
@router.post("/{invoice_id}/email-pdf")
async def email_pdf(
    invoice_id: str, payload: EmailPdfIn, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)
):
    biz_id = ctx["business"]["id"]
    inv = await _get_invoice_with_items(db, invoice_id, biz_id)
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")
    url = await render_and_upload_pdf(payload.html, biz_id, inv.id)
    return {"url": url}
```

Add the import near the top of the file:
```python
from app.pdf_export import render_and_upload_pdf
```

- [ ] **Step 3: Verify no regression**

Run: `pytest tests/test_backend.py -k "TestInvoicesLifecycle or test_email_pdf_from_other_business_rejected" -v`
Expected: all pass. `test_email_pdf_from_other_business_rejected` only exercises the 404-before-any-render path (no real Playwright/Supabase round trip needed), so this confirms the extraction preserved that behavior exactly.

- [ ] **Step 4: Commit**

```bash
git add backend/app/pdf_export.py backend/app/routers/invoices.py
git commit -m "Extract PDF render/upload and SSRF guard into a shared app.pdf_export module"
```

---

### Task 3: Estimate/EstimateLineItem models, Business columns, and migration

**Files:**
- Modify: `backend/app/models.py` (add two `Business` columns, append `Estimate`/`EstimateLineItem` classes)
- Create: `backend/alembic/versions/c4f27de91a83_add_estimates.py`

**Interfaces:**
- Produces: `Estimate`, `EstimateLineItem` ORM classes and the `estimates`/`estimate_line_items` tables; `Business.estimate_prefix`/`Business.next_estimate_no` columns.

- [ ] **Step 1: Add the two new `Business` columns**

In `backend/app/models.py`, inside the `Business` class, add these two lines directly after the existing `invoice_prefix`/`next_invoice_no` pair:
```python
    estimate_prefix: Mapped[str] = mapped_column(String, default="EST")
    next_estimate_no: Mapped[int] = mapped_column(Integer, default=1)
```

- [ ] **Step 2: Add the `Estimate` and `EstimateLineItem` models**

Append to the end of `backend/app/models.py`, after the `PasswordResetCode` class:

```python
class Estimate(Base):
    __tablename__ = "estimates"

    id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), primary_key=True, default=new_id)
    business_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), ForeignKey("businesses.id", ondelete="CASCADE"), index=True)
    customer_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), ForeignKey("customers.id"), index=True)
    number: Mapped[str] = mapped_column(String)
    status: Mapped[str] = mapped_column(String, default="DRAFT")
    currency: Mapped[str] = mapped_column(String, default="USD")
    issue_date: Mapped[str] = mapped_column(Date)
    expiry_date: Mapped[Optional[str]] = mapped_column(Date, nullable=True)
    discount_type: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    discount_value: Mapped[int] = mapped_column(Integer, default=0)
    subtotal_cents: Mapped[int] = mapped_column(Integer, default=0)
    tax_total_cents: Mapped[int] = mapped_column(Integer, default=0)
    discount_cents: Mapped[int] = mapped_column(Integer, default=0)
    total_cents: Mapped[int] = mapped_column(Integer, default=0)
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    terms: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    converted_invoice_id: Mapped[Optional[str]] = mapped_column(PG_UUID(as_uuid=False), ForeignKey("invoices.id"), nullable=True)
    sent_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    accepted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    declined_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    converted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True, onupdate=func.now())

    line_items: Mapped[list["EstimateLineItem"]] = relationship(
        back_populates="estimate", cascade="all, delete-orphan", order_by="EstimateLineItem.sort_order"
    )


class EstimateLineItem(Base):
    __tablename__ = "estimate_line_items"

    id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), primary_key=True, default=new_id)
    estimate_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), ForeignKey("estimates.id", ondelete="CASCADE"), index=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    name: Mapped[str] = mapped_column(String)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    quantity: Mapped[float] = mapped_column(Numeric(12, 4))
    unit_price_cents: Mapped[int] = mapped_column(Integer)
    tax_percent: Mapped[float] = mapped_column(Numeric(5, 2), default=0)

    estimate: Mapped["Estimate"] = relationship(back_populates="line_items")
```

- [ ] **Step 3: Write the Alembic migration**

Create `backend/alembic/versions/c4f27de91a83_add_estimates.py`:

```python
"""add_estimates

Revision ID: c4f27de91a83
Revises: aed6229aa1a1
Create Date: 2026-08-06 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = 'c4f27de91a83'
down_revision: Union[str, None] = 'aed6229aa1a1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('businesses', sa.Column('estimate_prefix', sa.String(), nullable=False, server_default='EST'))
    op.add_column('businesses', sa.Column('next_estimate_no', sa.Integer(), nullable=False, server_default='1'))

    op.create_table(
        'estimates',
        sa.Column('id', postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column('business_id', postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column('customer_id', postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column('number', sa.String(), nullable=False),
        sa.Column('status', sa.String(), nullable=False),
        sa.Column('currency', sa.String(), nullable=False),
        sa.Column('issue_date', sa.Date(), nullable=False),
        sa.Column('expiry_date', sa.Date(), nullable=True),
        sa.Column('discount_type', sa.String(), nullable=True),
        sa.Column('discount_value', sa.Integer(), nullable=False),
        sa.Column('subtotal_cents', sa.Integer(), nullable=False),
        sa.Column('tax_total_cents', sa.Integer(), nullable=False),
        sa.Column('discount_cents', sa.Integer(), nullable=False),
        sa.Column('total_cents', sa.Integer(), nullable=False),
        sa.Column('notes', sa.Text(), nullable=True),
        sa.Column('terms', sa.Text(), nullable=True),
        sa.Column('converted_invoice_id', postgresql.UUID(as_uuid=False), nullable=True),
        sa.Column('sent_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('accepted_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('declined_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('converted_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['business_id'], ['businesses.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['customer_id'], ['customers.id']),
        sa.ForeignKeyConstraint(['converted_invoice_id'], ['invoices.id']),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_estimates_business_id'), 'estimates', ['business_id'], unique=False)
    op.create_index(op.f('ix_estimates_customer_id'), 'estimates', ['customer_id'], unique=False)

    op.create_table(
        'estimate_line_items',
        sa.Column('id', postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column('estimate_id', postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column('sort_order', sa.Integer(), nullable=False),
        sa.Column('name', sa.String(), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('quantity', sa.Numeric(12, 4), nullable=False),
        sa.Column('unit_price_cents', sa.Integer(), nullable=False),
        sa.Column('tax_percent', sa.Numeric(5, 2), nullable=False),
        sa.ForeignKeyConstraint(['estimate_id'], ['estimates.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_estimate_line_items_estimate_id'), 'estimate_line_items', ['estimate_id'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_estimate_line_items_estimate_id'), table_name='estimate_line_items')
    op.drop_table('estimate_line_items')
    op.drop_index(op.f('ix_estimates_customer_id'), table_name='estimates')
    op.drop_index(op.f('ix_estimates_business_id'), table_name='estimates')
    op.drop_table('estimates')
    op.drop_column('businesses', 'next_estimate_no')
    op.drop_column('businesses', 'estimate_prefix')
```

- [ ] **Step 4: Set up this worktree's backend environment, then run and verify the migration**

This worktree has no `.env` and no venv yet (both git-ignored, not shared across worktrees):
```bash
cp "C:/Users/satis/OneDrive/Desktop/InvoiceAI/backend/.env" "C:/Users/satis/OneDrive/Desktop/InvoiceAI/.worktrees/estimates-quotes/backend/.env"
cd "C:/Users/satis/OneDrive/Desktop/InvoiceAI/.worktrees/estimates-quotes/backend"
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r requirements.txt
.venv/Scripts/python.exe -m playwright install chromium
```

Then run the migration and verify it's reversible:
```bash
.venv/Scripts/python.exe -m alembic upgrade head
.venv/Scripts/python.exe -m alembic downgrade -1
.venv/Scripts/python.exe -m alembic upgrade head
```
Expected: all three commands exit 0; final `alembic current` shows `c4f27de91a83 (head)`.

- [ ] **Step 5: Commit**

```bash
git add backend/app/models.py backend/alembic/versions/c4f27de91a83_add_estimates.py
git commit -m "Add Estimate and EstimateLineItem tables"
```

---

### Task 4: `EstimateIn` schema + Estimates CRUD router

**Files:**
- Modify: `backend/app/schemas.py` (add `EstimateIn`, after `InvoiceIn`)
- Create: `backend/app/routers/estimates.py`
- Modify: `backend/app/main.py` (register the router)
- Modify: `backend/tests/test_backend.py` (append `TestEstimatesCRUD`, after `TestInvoicesLifecycle`)

**Interfaces:**
- Consumes: `Estimate`, `EstimateLineItem`, `new_id()` (Task 3); `compute_totals` (Task 1).
- Produces: `GET/POST /estimates`, `GET/PATCH/DELETE /estimates/{id}`; the module-level helpers `_serialize_estimate(db, est, tax_breakdown=None)`, `_get_estimate_with_items(db, estimate_id, business_id)`, and `_line_item_dict(li)` — Task 5 and Task 6 add more endpoints to this same file and reuse these three helpers directly.

- [ ] **Step 1: Add the `EstimateIn` schema**

In `backend/app/schemas.py`, add directly after `InvoiceIn`:

```python
class EstimateIn(BaseModel):
    customer_id: str
    issue_date: Optional[str] = None
    expiry_date: Optional[str] = None
    line_items: List[LineItemIn]
    discount_type: Optional[str] = None  # PERCENT | FIXED
    discount_value: Optional[int] = 0
    notes: Optional[str] = None
    terms: Optional[str] = None
    status: Optional[str] = "DRAFT"
```

- [ ] **Step 2: Create the estimates router with the CRUD endpoints**

Create `backend/app/routers/estimates.py`:

```python
"""Estimate routes: CRUD, line items, and lifecycle actions (send/accept/
decline/convert/duplicate/email-pdf, added in later tasks). Reuses the
invoice engine's totals math (app.totals) and PDF/SSRF infrastructure
(app.pdf_export) rather than duplicating either.
"""
from datetime import date, datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, update as sql_update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.auth import get_business
from app.db import get_db, to_dict
from app.models import Business, Customer, Estimate, EstimateLineItem, new_id
from app.schemas import EstimateIn
from app.totals import compute_totals

router = APIRouter(prefix="/estimates", tags=["estimates"])


def _line_item_dict(li: EstimateLineItem) -> dict:
    return {
        "name": li.name,
        "description": li.description,
        "quantity": float(li.quantity),
        "unit_price_cents": li.unit_price_cents,
        "tax_percent": float(li.tax_percent),
    }


async def _serialize_estimate(db: AsyncSession, est: Estimate, tax_breakdown: Optional[list] = None) -> dict:
    data = to_dict(est)
    data["line_items"] = [_line_item_dict(li) for li in sorted(est.line_items, key=lambda x: x.sort_order)]
    data["tax_breakdown"] = tax_breakdown if tax_breakdown is not None else compute_totals(
        data["line_items"], data["discount_type"], data["discount_value"]
    )["tax_breakdown"]
    cust = (await db.execute(
        select(Customer).where(Customer.id == est.customer_id, Customer.business_id == est.business_id)
    )).scalar_one_or_none()
    data["customer"] = to_dict(cust) if cust else None
    return data


async def _get_estimate_with_items(db: AsyncSession, estimate_id: str, business_id: str) -> Optional[Estimate]:
    return (await db.execute(
        select(Estimate)
        .options(selectinload(Estimate.line_items))
        .where(Estimate.id == estimate_id, Estimate.business_id == business_id)
    )).scalar_one_or_none()


@router.get("")
async def list_estimates(
    ctx: dict = Depends(get_business),
    db: AsyncSession = Depends(get_db),
    status_filter: Optional[str] = None,
    q: Optional[str] = None,
):
    biz_id = ctx["business"]["id"]
    stmt = select(Estimate).options(selectinload(Estimate.line_items)).where(Estimate.business_id == biz_id)
    if status_filter and status_filter.upper() != "ALL":
        stmt = stmt.where(Estimate.status == status_filter.upper())
    stmt = stmt.order_by(Estimate.created_at.desc())
    rows = (await db.execute(stmt)).scalars().all()
    results = []
    for est in rows:
        item = await _serialize_estimate(db, est)
        if q:
            hay = " ".join([item.get("number") or "", (item.get("customer") or {}).get("name") or ""]).lower()
            if q.lower() not in hay:
                continue
        results.append(item)
    return results


@router.get("/{estimate_id}")
async def get_estimate(estimate_id: str, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)):
    biz_id = ctx["business"]["id"]
    est = await _get_estimate_with_items(db, estimate_id, biz_id)
    if not est:
        raise HTTPException(status_code=404, detail="Estimate not found")
    return await _serialize_estimate(db, est)


@router.post("")
async def create_estimate(payload: EstimateIn, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)):
    biz = ctx["business"]
    biz_id = biz["id"]

    cust = (await db.execute(
        select(Customer).where(Customer.id == payload.customer_id, Customer.business_id == biz_id)
    )).scalar_one_or_none()
    if not cust:
        raise HTTPException(status_code=400, detail="Customer not found for this business")

    seq = (await db.execute(
        sql_update(Business)
        .where(Business.id == biz_id)
        .values(next_estimate_no=Business.next_estimate_no + 1)
        .returning(Business.next_estimate_no)
    )).scalar_one() - 1
    prefix = biz.get("estimate_prefix", "EST")
    number = f"{prefix}-{str(seq).zfill(4)}"

    line_item_dicts = [li.model_dump() for li in payload.line_items]
    totals = compute_totals(line_item_dicts, payload.discount_type, payload.discount_value or 0)

    now = datetime.now(timezone.utc)
    issue = date.fromisoformat(payload.issue_date) if payload.issue_date else now.date()
    expiry = date.fromisoformat(payload.expiry_date) if payload.expiry_date else None

    estimate = Estimate(
        id=new_id(),
        business_id=biz_id,
        customer_id=payload.customer_id,
        number=number,
        status=(payload.status or "DRAFT").upper(),
        currency=biz.get("currency", "USD"),
        issue_date=issue,
        expiry_date=expiry,
        discount_type=payload.discount_type,
        discount_value=payload.discount_value or 0,
        subtotal_cents=totals["subtotal_cents"],
        tax_total_cents=totals["tax_total_cents"],
        discount_cents=totals["discount_cents"],
        total_cents=totals["total_cents"],
        notes=payload.notes,
        terms=payload.terms or biz.get("default_terms"),
    )
    for idx, li in enumerate(line_item_dicts):
        estimate.line_items.append(EstimateLineItem(sort_order=idx, **li))
    db.add(estimate)
    await db.commit()
    est = await _get_estimate_with_items(db, estimate.id, biz_id)
    return await _serialize_estimate(db, est, totals["tax_breakdown"])


@router.patch("/{estimate_id}")
async def update_estimate(
    estimate_id: str, payload: EstimateIn, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)
):
    biz_id = ctx["business"]["id"]
    est = await _get_estimate_with_items(db, estimate_id, biz_id)
    if not est:
        raise HTTPException(status_code=404, detail="Estimate not found")
    if est.status != "DRAFT":
        raise HTTPException(status_code=400, detail="Only DRAFT estimates can be edited")

    cust = (await db.execute(
        select(Customer).where(Customer.id == payload.customer_id, Customer.business_id == biz_id)
    )).scalar_one_or_none()
    if not cust:
        raise HTTPException(status_code=400, detail="Customer not found for this business")

    line_item_dicts = [li.model_dump() for li in payload.line_items]
    totals = compute_totals(line_item_dicts, payload.discount_type, payload.discount_value or 0)

    est.customer_id = payload.customer_id
    est.discount_type = payload.discount_type
    est.discount_value = payload.discount_value or 0
    est.subtotal_cents = totals["subtotal_cents"]
    est.tax_total_cents = totals["tax_total_cents"]
    est.discount_cents = totals["discount_cents"]
    est.total_cents = totals["total_cents"]
    est.notes = payload.notes
    est.terms = payload.terms
    est.issue_date = date.fromisoformat(payload.issue_date) if payload.issue_date else est.issue_date
    est.expiry_date = date.fromisoformat(payload.expiry_date) if payload.expiry_date else est.expiry_date
    est.updated_at = datetime.now(timezone.utc)

    est.line_items.clear()
    for idx, li in enumerate(line_item_dicts):
        est.line_items.append(EstimateLineItem(sort_order=idx, **li))

    await db.commit()
    est = await _get_estimate_with_items(db, estimate_id, biz_id)
    return await _serialize_estimate(db, est, totals["tax_breakdown"])


@router.delete("/{estimate_id}")
async def delete_estimate(estimate_id: str, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)):
    biz_id = ctx["business"]["id"]
    est = await _get_estimate_with_items(db, estimate_id, biz_id)
    if not est:
        return {"ok": True}
    if est.status != "DRAFT":
        raise HTTPException(status_code=400, detail="Only DRAFT estimates can be deleted")
    await db.delete(est)
    await db.commit()
    return {"ok": True}
```

- [ ] **Step 3: Register the router**

In `backend/app/main.py`, add `estimates` to the import line and register it after `invoices.router`:

```python
from app.routers import ai, auth, business, catalog, customers, dashboard, estimates, expense_categories, expenses, invoices, vendors, webhooks
```

```python
api.include_router(estimates.router)
```
(insert this line immediately after `api.include_router(invoices.router)`)

- [ ] **Step 4: Write the tests**

Append to `backend/tests/test_backend.py`, directly after the `TestInvoicesLifecycle` class ends (before the `TestDashboard` class):

```python
# ---------------------------------------------------------------------------
# Estimates CRUD + business isolation
# ---------------------------------------------------------------------------
class TestEstimatesCRUD:
    def _make_customer(self, s, name="TEST_Cust_Est"):
        r = s.post(f"{API}/customers", json={"name": name})
        assert r.status_code == 200, r.text
        return r.json()["id"]

    def test_estimate_crud(self, fresh_business):
        s = fresh_business["session"]
        cid = self._make_customer(s)
        payload = {
            "customer_id": cid,
            "line_items": [{"name": "Item A", "quantity": 2, "unit_price_cents": 10000, "tax_percent": 10}],
            "discount_type": "FIXED",
            "discount_value": 2000,
        }
        r = s.post(f"{API}/estimates", json=payload)
        assert r.status_code == 200, r.text
        est = r.json()
        assert est["number"].startswith("EST-")
        assert est["number"].endswith("0001")
        assert est["subtotal_cents"] == 20000
        assert est["tax_total_cents"] == 2000
        assert est["discount_cents"] == 2000
        assert est["total_cents"] == 20000
        assert est["status"] == "DRAFT"
        eid = est["id"]

        r = s.get(f"{API}/estimates/{eid}")
        assert r.status_code == 200
        assert r.json()["id"] == eid

        r = s.get(f"{API}/estimates")
        assert r.status_code == 200
        assert any(e["id"] == eid for e in r.json())

        r = s.patch(f"{API}/estimates/{eid}", json={
            "customer_id": cid,
            "line_items": [{"name": "Item B", "quantity": 1, "unit_price_cents": 5000}],
        })
        assert r.status_code == 200
        assert r.json()["total_cents"] == 5000
        names = [li["name"] for li in r.json()["line_items"]]
        assert names == ["Item B"]

        r = s.delete(f"{API}/estimates/{eid}")
        assert r.status_code == 200
        r = s.get(f"{API}/estimates/{eid}")
        assert r.status_code == 404

    def test_delete_blocked_once_sent(self, fresh_business):
        s = fresh_business["session"]
        cid = self._make_customer(s)
        r = s.post(f"{API}/estimates", json={
            "customer_id": cid,
            "line_items": [{"name": "Item", "quantity": 1, "unit_price_cents": 1000}],
        })
        assert r.status_code == 200
        eid = r.json()["id"]

        r = s.post(f"{API}/estimates/{eid}/send")
        assert r.status_code == 200
        assert r.json()["status"] == "SENT"

        r = s.delete(f"{API}/estimates/{eid}")
        assert r.status_code == 400

        r = s.patch(f"{API}/estimates/{eid}", json={
            "customer_id": cid,
            "line_items": [{"name": "Item", "quantity": 1, "unit_price_cents": 1000}],
        })
        assert r.status_code == 400

    def test_business_isolation(self, auth_client, fresh_business):
        r = auth_client.post(f"{API}/customers", json={"name": "TEST_ISO_Est_Cust"})
        assert r.status_code == 200
        cid = r.json()["id"]
        r = auth_client.post(f"{API}/estimates", json={
            "customer_id": cid,
            "line_items": [{"name": "Item", "quantity": 1, "unit_price_cents": 1000}],
        })
        assert r.status_code == 200
        primary_eid = r.json()["id"]

        s = fresh_business["session"]
        r = s.get(f"{API}/estimates")
        assert r.status_code == 200
        assert not any(e["id"] == primary_eid for e in r.json())
        r = s.get(f"{API}/estimates/{primary_eid}")
        assert r.status_code == 404


```

- [ ] **Step 5: Run the tests**

Run: `cd backend && EXPO_PUBLIC_BACKEND_URL=http://localhost:8099 .venv/Scripts/python.exe -m pytest tests/test_backend.py -k TestEstimatesCRUD -v`
(Start the server first: `.venv/Scripts/python.exe -m uvicorn app.main:app --port 8099 --env-file .env`, in the background.)
Expected: 3 passed.

- [ ] **Step 6: Commit**

```bash
git add backend/app/schemas.py backend/app/routers/estimates.py backend/app/main.py backend/tests/test_backend.py
git commit -m "Add Estimates CRUD API"
```

---

### Task 5: Lifecycle actions — send / accept / decline / duplicate

**Files:**
- Modify: `backend/app/routers/estimates.py`
- Modify: `backend/tests/test_backend.py` (append `TestEstimatesLifecycle`, after `TestEstimatesCRUD`)

**Interfaces:**
- Consumes: `_serialize_estimate`, `_get_estimate_with_items` (Task 4).
- Produces: `POST /estimates/{id}/send`, `/accept`, `/decline`, `/duplicate`.

- [ ] **Step 1: Add the four endpoints**

Append to the end of `backend/app/routers/estimates.py`:

```python
@router.post("/{estimate_id}/send")
async def send_estimate(estimate_id: str, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)):
    biz_id = ctx["business"]["id"]
    est = await _get_estimate_with_items(db, estimate_id, biz_id)
    if not est:
        raise HTTPException(status_code=404, detail="Estimate not found")
    if est.status == "DRAFT":
        est.status = "SENT"
        est.sent_at = datetime.now(timezone.utc)
        est.updated_at = datetime.now(timezone.utc)
        await db.commit()
        est = await _get_estimate_with_items(db, estimate_id, biz_id)
    return await _serialize_estimate(db, est)


@router.post("/{estimate_id}/accept")
async def accept_estimate(estimate_id: str, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)):
    biz_id = ctx["business"]["id"]
    est = await _get_estimate_with_items(db, estimate_id, biz_id)
    if not est:
        raise HTTPException(status_code=404, detail="Estimate not found")
    if est.status != "SENT":
        raise HTTPException(status_code=400, detail="Only SENT estimates can be accepted")
    est.status = "ACCEPTED"
    est.accepted_at = datetime.now(timezone.utc)
    est.updated_at = datetime.now(timezone.utc)
    await db.commit()
    est = await _get_estimate_with_items(db, estimate_id, biz_id)
    return await _serialize_estimate(db, est)


@router.post("/{estimate_id}/decline")
async def decline_estimate(estimate_id: str, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)):
    biz_id = ctx["business"]["id"]
    est = await _get_estimate_with_items(db, estimate_id, biz_id)
    if not est:
        raise HTTPException(status_code=404, detail="Estimate not found")
    if est.status != "SENT":
        raise HTTPException(status_code=400, detail="Only SENT estimates can be declined")
    est.status = "DECLINED"
    est.declined_at = datetime.now(timezone.utc)
    est.updated_at = datetime.now(timezone.utc)
    await db.commit()
    est = await _get_estimate_with_items(db, estimate_id, biz_id)
    return await _serialize_estimate(db, est)


@router.post("/{estimate_id}/duplicate")
async def duplicate_estimate(estimate_id: str, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)):
    biz = ctx["business"]
    biz_id = biz["id"]
    est = await _get_estimate_with_items(db, estimate_id, biz_id)
    if not est:
        raise HTTPException(status_code=404, detail="Estimate not found")

    seq = (await db.execute(
        sql_update(Business)
        .where(Business.id == biz_id)
        .values(next_estimate_no=Business.next_estimate_no + 1)
        .returning(Business.next_estimate_no)
    )).scalar_one() - 1
    number = f"{biz.get('estimate_prefix', 'EST')}-{str(seq).zfill(4)}"

    new_estimate = Estimate(
        id=new_id(),
        business_id=biz_id,
        customer_id=est.customer_id,
        number=number,
        status="DRAFT",
        currency=est.currency,
        issue_date=est.issue_date,
        expiry_date=est.expiry_date,
        discount_type=est.discount_type,
        discount_value=est.discount_value,
        subtotal_cents=est.subtotal_cents,
        tax_total_cents=est.tax_total_cents,
        discount_cents=est.discount_cents,
        total_cents=est.total_cents,
        notes=est.notes,
        terms=est.terms,
    )
    for li in sorted(est.line_items, key=lambda x: x.sort_order):
        new_estimate.line_items.append(EstimateLineItem(
            sort_order=li.sort_order, name=li.name, description=li.description,
            quantity=li.quantity, unit_price_cents=li.unit_price_cents, tax_percent=li.tax_percent,
        ))
    db.add(new_estimate)
    await db.commit()
    result_est = await _get_estimate_with_items(db, new_estimate.id, biz_id)
    return await _serialize_estimate(db, result_est)
```

- [ ] **Step 2: Write the tests**

Append to `backend/tests/test_backend.py`, directly after `TestEstimatesCRUD`:

```python
# ---------------------------------------------------------------------------
# Estimate lifecycle: send / accept / decline / duplicate
# ---------------------------------------------------------------------------
class TestEstimatesLifecycle:
    def _make_estimate(self, s, cust_name="TEST_Cust_EstLC"):
        r = s.post(f"{API}/customers", json={"name": cust_name})
        assert r.status_code == 200
        cid = r.json()["id"]
        r = s.post(f"{API}/estimates", json={
            "customer_id": cid,
            "line_items": [{"name": "Item", "quantity": 1, "unit_price_cents": 5000}],
        })
        assert r.status_code == 200, r.text
        return r.json()

    def test_send_accept_flow(self, fresh_business):
        s = fresh_business["session"]
        est = self._make_estimate(s)

        r = s.post(f"{API}/estimates/{est['id']}/send")
        assert r.status_code == 200
        assert r.json()["status"] == "SENT"
        assert r.json()["sent_at"]

        r = s.post(f"{API}/estimates/{est['id']}/accept")
        assert r.status_code == 200
        assert r.json()["status"] == "ACCEPTED"
        assert r.json()["accepted_at"]

    def test_accept_before_send_rejected(self, fresh_business):
        s = fresh_business["session"]
        est = self._make_estimate(s)
        r = s.post(f"{API}/estimates/{est['id']}/accept")
        assert r.status_code == 400

    def test_decline_flow(self, fresh_business):
        s = fresh_business["session"]
        est = self._make_estimate(s)
        s.post(f"{API}/estimates/{est['id']}/send")

        r = s.post(f"{API}/estimates/{est['id']}/decline")
        assert r.status_code == 200
        assert r.json()["status"] == "DECLINED"
        assert r.json()["declined_at"]

        # A declined estimate can't then be accepted.
        r = s.post(f"{API}/estimates/{est['id']}/accept")
        assert r.status_code == 400

    def test_duplicate(self, fresh_business):
        s = fresh_business["session"]
        est = self._make_estimate(s)
        s.post(f"{API}/estimates/{est['id']}/send")

        r = s.post(f"{API}/estimates/{est['id']}/duplicate")
        assert r.status_code == 200
        dup = r.json()
        assert dup["id"] != est["id"]
        assert dup["status"] == "DRAFT"
        assert dup["number"].endswith("0002")
        assert dup["total_cents"] == est["total_cents"]
        names = [li["name"] for li in dup["line_items"]]
        assert names == ["Item"]
```

- [ ] **Step 3: Run the tests**

Run: `pytest tests/test_backend.py -k TestEstimatesLifecycle -v`
Expected: 4 passed.

- [ ] **Step 4: Commit**

```bash
git add backend/app/routers/estimates.py backend/tests/test_backend.py
git commit -m "Add estimate lifecycle actions: send, accept, decline, duplicate"
```

---

### Task 6: Convert-to-invoice and email-pdf actions

**Files:**
- Modify: `backend/app/routers/estimates.py`
- Modify: `backend/tests/test_backend.py` (append `TestEstimatesConvertAndEmail`, after `TestEstimatesLifecycle`)

**Interfaces:**
- Consumes: `check_plan_limit` from `app.routers.business` (existing); `_get_invoice_with_items`/`_serialize_invoice` from `app.routers.invoices` (existing — reused directly rather than duplicating invoice serialization a second time); `render_and_upload_pdf` from `app.pdf_export` (Task 2).
- Produces: `POST /estimates/{id}/convert`, `POST /estimates/{id}/email-pdf`.

- [ ] **Step 1: Add the imports this task needs**

At the top of `backend/app/routers/estimates.py`, update the `datetime` import line to add `timedelta`:
```python
from datetime import date, datetime, timedelta, timezone
```

Add these imports alongside the existing ones:
```python
from app.models import Invoice, LineItem
from app.pdf_export import render_and_upload_pdf
from app.routers.business import check_plan_limit
from app.routers.invoices import _get_invoice_with_items, _serialize_invoice
from app.schemas import EmailPdfIn
```
(the existing `from app.schemas import EstimateIn` line can be combined with this one, or left as a separate line — either is fine)

- [ ] **Step 2: Add the convert endpoint**

Append to the end of `backend/app/routers/estimates.py`:

```python
@router.post("/{estimate_id}/convert")
async def convert_estimate(estimate_id: str, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)):
    biz = ctx["business"]
    biz_id = biz["id"]
    est = await _get_estimate_with_items(db, estimate_id, biz_id)
    if not est:
        raise HTTPException(status_code=404, detail="Estimate not found")
    if est.status in ("DECLINED", "CONVERTED"):
        raise HTTPException(status_code=400, detail=f"Cannot convert an estimate that is {est.status}")

    plan_status = await check_plan_limit(db, biz_id, biz.get("plan", "FREE"))
    if plan_status["over"]:
        raise HTTPException(
            status_code=402,
            detail={
                "error": "PLAN_LIMIT_REACHED",
                "message": f"Your {biz.get('plan', 'FREE')} plan allows {plan_status['limit']} invoices per {plan_status['scope']}. Upgrade to create more.",
                **plan_status,
            },
        )

    seq = (await db.execute(
        sql_update(Business)
        .where(Business.id == biz_id)
        .values(next_invoice_no=Business.next_invoice_no + 1)
        .returning(Business.next_invoice_no)
    )).scalar_one() - 1
    number = f"{biz.get('invoice_prefix', 'INV')}-{str(seq).zfill(4)}"

    now = datetime.now(timezone.utc)
    due = (now + timedelta(days=biz.get("default_due_days", 14))).date()
    new_invoice = Invoice(
        id=new_id(),
        business_id=biz_id,
        customer_id=est.customer_id,
        number=number,
        status="DRAFT",
        currency=est.currency,
        issue_date=now.date(),
        due_date=due,
        discount_type=est.discount_type,
        discount_value=est.discount_value,
        subtotal_cents=est.subtotal_cents,
        tax_total_cents=est.tax_total_cents,
        discount_cents=est.discount_cents,
        total_cents=est.total_cents,
        amount_paid_cents=0,
        notes=est.notes,
        terms=est.terms or biz.get("default_terms"),
        stripe_payment_url=biz.get("stripe_payment_url_default"),
    )
    for li in sorted(est.line_items, key=lambda x: x.sort_order):
        new_invoice.line_items.append(LineItem(
            sort_order=li.sort_order, name=li.name, description=li.description,
            quantity=li.quantity, unit_price_cents=li.unit_price_cents, tax_percent=li.tax_percent,
        ))
    db.add(new_invoice)

    est.status = "CONVERTED"
    est.converted_invoice_id = new_invoice.id
    est.converted_at = now
    est.updated_at = now

    await db.commit()
    result_inv = await _get_invoice_with_items(db, new_invoice.id, biz_id)
    return await _serialize_invoice(db, result_inv)


@router.post("/{estimate_id}/email-pdf")
async def email_pdf(
    estimate_id: str, payload: EmailPdfIn, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)
):
    biz_id = ctx["business"]["id"]
    est = await _get_estimate_with_items(db, estimate_id, biz_id)
    if not est:
        raise HTTPException(status_code=404, detail="Estimate not found")
    url = await render_and_upload_pdf(payload.html, biz_id, est.id)
    return {"url": url}
```

`convert_estimate` returns the newly created invoice's own full serialized shape (via `invoices.py`'s `_serialize_invoice`), not the estimate — the frontend detail screen navigates straight to `/invoices/[id]` with this response's `id` after a successful convert, matching how `duplicate_invoice` in `invoices.py` returns the new invoice, not the old one.

- [ ] **Step 3: Write the tests**

Append to `backend/tests/test_backend.py`, directly after `TestEstimatesLifecycle`:

```python
# ---------------------------------------------------------------------------
# Estimate convert-to-invoice and email-pdf
# ---------------------------------------------------------------------------
class TestEstimatesConvertAndEmail:
    def _make_estimate(self, s, cust_name="TEST_Cust_EstConv"):
        r = s.post(f"{API}/customers", json={"name": cust_name})
        assert r.status_code == 200
        cid = r.json()["id"]
        r = s.post(f"{API}/estimates", json={
            "customer_id": cid,
            "line_items": [{"name": "Roof repair", "quantity": 1, "unit_price_cents": 45000, "tax_percent": 5}],
        })
        assert r.status_code == 200, r.text
        return r.json()

    def test_convert_creates_matching_invoice(self, fresh_business):
        s = fresh_business["session"]
        est = self._make_estimate(s)
        s.post(f"{API}/estimates/{est['id']}/send")
        s.post(f"{API}/estimates/{est['id']}/accept")

        r = s.post(f"{API}/estimates/{est['id']}/convert")
        assert r.status_code == 200, r.text
        inv = r.json()
        assert inv["number"].startswith("INV-")
        assert inv["status"] == "DRAFT"
        assert inv["total_cents"] == est["total_cents"]
        assert inv["customer"]["id"] == est["customer_id"]
        names = [li["name"] for li in inv["line_items"]]
        assert names == ["Roof repair"]

        r = s.get(f"{API}/estimates/{est['id']}")
        assert r.status_code == 200
        updated_est = r.json()
        assert updated_est["status"] == "CONVERTED"
        assert updated_est["converted_invoice_id"] == inv["id"]
        assert updated_est["converted_at"]

        # The resulting invoice is real and independently fetchable.
        r = s.get(f"{API}/invoices/{inv['id']}")
        assert r.status_code == 200
        assert r.json()["total_cents"] == est["total_cents"]

    def test_convert_blocked_from_declined(self, fresh_business):
        s = fresh_business["session"]
        est = self._make_estimate(s)
        s.post(f"{API}/estimates/{est['id']}/send")
        s.post(f"{API}/estimates/{est['id']}/decline")

        r = s.post(f"{API}/estimates/{est['id']}/convert")
        assert r.status_code == 400

    def test_convert_blocked_when_already_converted(self, fresh_business):
        s = fresh_business["session"]
        est = self._make_estimate(s)
        r = s.post(f"{API}/estimates/{est['id']}/convert")
        assert r.status_code == 200

        r = s.post(f"{API}/estimates/{est['id']}/convert")
        assert r.status_code == 400

    def test_email_pdf_from_other_business_rejected(self, auth_client, fresh_business):
        # Same regression shape as invoices.py's equivalent test: the 404
        # check runs before any PDF rendering or Supabase upload, so this
        # needs no external infra beyond the app itself.
        s = fresh_business["session"]
        est = self._make_estimate(s, cust_name="TEST_Cust_EstEmail")

        r = auth_client.post(f"{API}/estimates/{est['id']}/email-pdf", json={
            "html": "<html><body>Should not render</body></html>",
        })
        assert r.status_code == 404
```

- [ ] **Step 4: Run the tests**

Run: `pytest tests/test_backend.py -k TestEstimatesConvertAndEmail -v`
Expected: 4 passed.

- [ ] **Step 5: Run the full backend suite**

Run: `pytest tests/test_backend.py -v`
Expected: same 2 pre-existing unrelated failures as the rest of this codebase (a Stripe URL env mismatch in `TestBusiness`, a missing `chart_months` key in `TestDashboard`) — nothing else should fail. Stop the background server when done.

- [ ] **Step 6: Commit**

```bash
git add backend/app/routers/estimates.py backend/tests/test_backend.py
git commit -m "Add estimate convert-to-invoice and email-pdf actions"
```

---

### Task 7: Frontend types, StatusPill, and status colors

**Files:**
- Modify: `frontend/src/lib/types.ts` (add `EstimateStatus`, `Estimate`)
- Modify: `frontend/src/lib/theme.ts` (add `ACCEPTED`/`DECLINED`/`CONVERTED` to `statusColors`)
- Modify: `frontend/src/components/StatusPill.tsx` (widen the `status` prop type)

**Interfaces:**
- Produces: `EstimateStatus`, `Estimate` types; `StatusPill` now accepts `InvoiceStatus | EstimateStatus`. Consumed by Tasks 8, 9, 10, 11.

- [ ] **Step 1: Add the types**

In `frontend/src/lib/types.ts`, add after the `Invoice` type:

```typescript
export type EstimateStatus = "DRAFT" | "SENT" | "ACCEPTED" | "DECLINED" | "CONVERTED";

export type Estimate = {
  id: string;
  business_id: string;
  customer_id: string;
  customer?: Customer | null;
  number: string;
  status: EstimateStatus;
  currency: string;
  issue_date: string;
  expiry_date?: string | null;
  line_items: LineItemDto[];
  subtotal_cents: number;
  tax_total_cents: number;
  discount_cents: number;
  discount_type?: "PERCENT" | "FIXED" | null;
  discount_value?: number;
  total_cents: number;
  notes?: string | null;
  terms?: string | null;
  converted_invoice_id?: string | null;
  sent_at?: string | null;
  accepted_at?: string | null;
  declined_at?: string | null;
  converted_at?: string | null;
  created_at: string;
};
```

- [ ] **Step 2: Add the new status colors**

In `frontend/src/lib/theme.ts`, inside the `statusColors` object, add these three entries (leave `DRAFT`, `SENT`, `VOID`, etc. untouched — `DRAFT` and `SENT` are reused as-is by estimates):

```typescript
  ACCEPTED: { bg: colors.brandTertiary, fg: colors.brand, label: "Accepted" },
  DECLINED: { bg: "#FEE2E2", fg: colors.error, label: "Declined" },
  CONVERTED: { bg: colors.surfaceTertiary, fg: colors.onSurfaceTertiary, label: "Converted" },
```

- [ ] **Step 3: Widen `StatusPill`'s prop type**

In `frontend/src/components/StatusPill.tsx`, change:
```tsx
import type { InvoiceStatus } from "@/src/lib/types";

export function StatusPill({ status, testID }: { status: InvoiceStatus; testID?: string }) {
```
to:
```tsx
import type { EstimateStatus, InvoiceStatus } from "@/src/lib/types";

export function StatusPill({ status, testID }: { status: InvoiceStatus | EstimateStatus; testID?: string }) {
```
No other change needed — `statusColors` is already typed `Record<string, {...}>`, so it accepts the new keys without modification.

- [ ] **Step 4: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: the one pre-existing unrelated error in `app/invoices/new.tsx` (`LineItemDto[]` vs `LineItem[]`), nothing new.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/types.ts frontend/src/lib/theme.ts frontend/src/components/StatusPill.tsx
git commit -m "Add EstimateStatus/Estimate types and widen StatusPill"
```

---

### Task 8: `estimatePdf.ts`

**Files:**
- Create: `frontend/src/lib/estimatePdf.ts`

**Interfaces:**
- Consumes: `Estimate`, `Business` types (Task 7).
- Produces: `estimateHtml(estimate, business)`, `estimateFileName(estimate)`, `generateEstimatePdfFile(estimate, business)` — used by Task 10's detail screen.

- [ ] **Step 1: Create the estimate PDF template**

Create `frontend/src/lib/estimatePdf.ts`, structurally identical to `frontend/src/lib/invoicePdf.ts` (same `esc()` helper, same A4/mobile-viewport CSS, same file-rename-after-render pattern), with estimate-specific content: "ESTIMATE" instead of "INVOICE", a status badge driven by the estimate lifecycle instead of payment status, "Estimate date"/"Expires" instead of "Invoice date"/"Due date", and no payment/balance block (estimates don't take payment):

```typescript
// Estimate PDF generation: A4 print-ready HTML template (expo-print) plus a
// helper that renders it to a properly named PDF file on device. Mirrors
// invoicePdf.ts's structure; kept as a separate file per this codebase's
// convention of parallel screens/modules over shared abstraction.
import * as FileSystem from "expo-file-system/legacy";
import * as Print from "expo-print";

import { formatMoney } from "@/src/lib/money";
import type { Business, Estimate } from "@/src/lib/types";

function esc(s: string | null | undefined): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function estimateFileName(estimate: Estimate): string {
  return `Estimate-${estimate.number}.pdf`;
}

/** Lifecycle status shown on the PDF — estimates have no payment state. */
function estimateStatusBadge(estimate: Estimate): { label: string; fg: string; bg: string } {
  if (estimate.status === "ACCEPTED") return { label: "ACCEPTED", fg: "#0D683A", bg: "#E6F3EB" };
  if (estimate.status === "DECLINED") return { label: "DECLINED", fg: "#9F3A38", bg: "#FBEAE9" };
  if (estimate.status === "CONVERTED") return { label: "CONVERTED", fg: "#6B6B69", bg: "#EAEAE8" };
  if (estimate.status === "SENT") return { label: "SENT", fg: "#8A5A00", bg: "#FBF0DA" };
  return { label: "DRAFT", fg: "#6B6B69", bg: "#EAEAE8" };
}

export function estimateHtml(estimate: Estimate, business: Business): string {
  const cust = estimate.customer;
  const status = estimateStatusBadge(estimate);

  const rows = estimate.line_items
    .map((li) => {
      const qty = li.quantity;
      const price = formatMoney(li.unit_price_cents, estimate.currency);
      const lineTotal = formatMoney(
        Math.round(qty * li.unit_price_cents * (1 + (li.tax_percent || 0) / 100)),
        estimate.currency
      );
      const tax = li.tax_percent ? `${li.tax_percent}%` : "—";
      return `
        <tr>
          <td class="td td-desc">
            <div class="li-name">${esc(li.name)}</div>
            ${li.description ? `<div class="li-desc">${esc(li.description)}</div>` : ""}
          </td>
          <td class="td num">${qty}</td>
          <td class="td num">${price}</td>
          <td class="td num">${tax}</td>
          <td class="td num li-total">${lineTotal}</td>
        </tr>`;
    })
    .join("");

  const logoBlock = business.logo_url
    ? `<img src="${esc(business.logo_url)}" alt="" style="max-height:56px;max-width:180px;object-fit:contain;margin-bottom:10px;display:block;" />`
    : "";

  const bizLines = [
    business.email,
    business.phone,
    business.website,
    business.address_line1,
    [business.city, business.region, business.postal_code].filter(Boolean).join(", "),
    business.country,
  ]
    .filter(Boolean)
    .map((l) => `<div class="muted-13">${esc(l as string)}</div>`)
    .join("");

  const taxIds = (business.tax_numbers || [])
    .map((t: { label?: string; value?: string }) =>
      t?.value ? `<div class="muted-13">${esc(t.label || "Tax ID")}: ${esc(t.value)}</div>` : ""
    )
    .join("");

  const custLines = [
    cust?.company,
    cust?.email,
    cust?.phone,
    cust?.address_line1,
    [cust?.city, cust?.region, cust?.postal_code].filter(Boolean).join(", "),
    cust?.country,
  ]
    .filter(Boolean)
    .map((l) => `<div class="dark-13">${esc(l as string)}</div>`)
    .join("");

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Estimate-${esc(estimate.number)}</title>
  <style>
    @page { size: A4; margin: 14mm 14mm 16mm 14mm; }
    * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    html, body { margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: #FFFFFF; color: #111110; font-size: 14px; line-height: 1.45;
    }
    .page { max-width: 182mm; margin: 0 auto; }
    @media screen {
      body { background: #E9E9E7; padding: 24px 16px; }
      .page {
        background: #FFFFFF; padding: 14mm;
        box-shadow: 0 1px 3px rgba(17,17,16,0.12), 0 8px 24px rgba(17,17,16,0.08);
        border-radius: 4px;
      }
    }
    @media screen and (max-width: 480px) {
      body { padding: 12px 8px; font-size: 13px; }
      .page { padding: 16px; }
      .table-wrap { overflow-x: auto; }
      .th, .td { padding: 8px 6px; }
    }
    .table-wrap { width: 100%; }
    .muted-13 { font-size: 13px; color: #6B6B69; }
    .dark-13 { font-size: 13px; color: #3E3E3C; }
    .section-label {
      font-size: 11px; font-weight: 600; color: #6B6B69;
      letter-spacing: 0.6px; text-transform: uppercase; margin-bottom: 6px;
    }
    table { width: 100%; border-collapse: collapse; }
    thead { display: table-header-group; }
    tr { page-break-inside: avoid; }
    .th {
      text-align: right; padding: 10px 8px; font-size: 11px; font-weight: 600;
      color: #6B6B69; text-transform: uppercase; letter-spacing: 0.6px;
      border-bottom: 2px solid #111110;
    }
    .th-desc { text-align: left; }
    .td { padding: 11px 8px; border-bottom: 1px solid #EAEAE8; vertical-align: top; }
    .num { text-align: right; white-space: nowrap; color: #3E3E3C; }
    .td-desc { text-align: left; }
    .li-name { font-weight: 500; color: #111110; }
    .li-desc { font-size: 12px; color: #6B6B69; margin-top: 2px; }
    .li-total { font-weight: 500; color: #111110; }
    .totals-row { display: flex; justify-content: space-between; padding: 7px 0; }
    .badge {
      display: inline-block; padding: 5px 14px; border-radius: 999px;
      font-size: 12px; font-weight: 700; letter-spacing: 0.8px;
      color: ${status.fg}; background: ${status.bg};
    }
    .notes-block { page-break-inside: avoid; }
  </style>
</head>
<body>
  <div class="page">
    <!-- Header -->
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:30px;">
      <div>
        ${logoBlock}
        <div style="font-size:22px;font-weight:600;color:#111110;">${esc(business.name)}</div>
        ${business.legal_name && business.legal_name !== business.name ? `<div class="muted-13">${esc(business.legal_name)}</div>` : ""}
        <div style="margin-top:4px;">${bizLines}</div>
        ${taxIds}
      </div>
      <div style="text-align:right;">
        <div style="font-size:30px;font-weight:600;color:#0D683A;letter-spacing:-0.5px;">ESTIMATE</div>
        <div style="font-size:14px;color:#3E3E3C;margin:4px 0 10px;">${esc(estimate.number)}</div>
        <span class="badge">${status.label}</span>
      </div>
    </div>

    <!-- Prepared for / Dates -->
    <div style="display:flex;justify-content:space-between;margin-bottom:28px;gap:24px;">
      <div style="flex:1;">
        <div class="section-label">Prepared for</div>
        <div style="font-size:15px;font-weight:600;color:#111110;">${esc(cust?.name || "")}</div>
        ${custLines}
      </div>
      <div style="text-align:right;">
        <div style="margin-bottom:10px;">
          <div class="section-label" style="margin-bottom:2px;">Estimate date</div>
          <div style="font-size:14px;font-weight:500;">${esc(estimate.issue_date)}</div>
        </div>
        <div>
          <div class="section-label" style="margin-bottom:2px;">Expires</div>
          <div style="font-size:14px;font-weight:500;">${esc(estimate.expiry_date || "—")}</div>
        </div>
      </div>
    </div>

    <!-- Line items -->
    <div class="table-wrap" style="margin-bottom:20px;">
      <table>
        <thead>
          <tr>
            <th class="th th-desc">Description</th>
            <th class="th">Qty</th>
            <th class="th">Unit price</th>
            <th class="th">Tax</th>
            <th class="th">Amount</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>

    <!-- Totals -->
    <div style="display:flex;justify-content:flex-end;margin-bottom:8px;page-break-inside:avoid;">
      <div style="width:300px;">
        <div class="totals-row">
          <span class="muted-13" style="font-size:14px;">Subtotal</span>
          <span style="font-size:14px;">${formatMoney(estimate.subtotal_cents, estimate.currency)}</span>
        </div>
        ${estimate.tax_total_cents ? `<div class="totals-row">
          <span class="muted-13" style="font-size:14px;">Tax</span>
          <span style="font-size:14px;">${formatMoney(estimate.tax_total_cents, estimate.currency)}</span>
        </div>` : ""}
        ${estimate.discount_cents ? `<div class="totals-row">
          <span class="muted-13" style="font-size:14px;">Discount</span>
          <span style="font-size:14px;">- ${formatMoney(estimate.discount_cents, estimate.currency)}</span>
        </div>` : ""}
        <div class="totals-row" style="border-top:2px solid #111110;margin-top:6px;padding-top:11px;">
          <span style="font-weight:600;font-size:16px;">Total</span>
          <span style="font-weight:600;color:#0D683A;font-size:20px;">${formatMoney(estimate.total_cents, estimate.currency)}</span>
        </div>
      </div>
    </div>

    ${estimate.notes ? `<div class="notes-block" style="margin-top:24px;">
      <div class="section-label">Notes</div>
      <div style="font-size:13px;color:#3E3E3C;line-height:1.6;">${esc(estimate.notes)}</div>
    </div>` : ""}
    ${estimate.terms ? `<div class="notes-block" style="margin-top:16px;padding-top:16px;border-top:1px solid #EAEAE8;">
      <div class="section-label">Terms &amp; Conditions</div>
      <div style="font-size:12px;color:#6B6B69;line-height:1.6;">${esc(estimate.terms)}</div>
    </div>` : ""}

    <div style="margin-top:28px;padding-top:14px;border-top:1px solid #EAEAE8;text-align:center;">
      <div style="font-size:11px;color:#9B9B99;">Thank you for considering us — ${esc(business.name)}</div>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Render the estimate to a PDF file named `Estimate-<number>.pdf` (native
 * only). Mirrors invoicePdf.ts's generateInvoicePdfFile exactly.
 */
export async function generateEstimatePdfFile(
  estimate: Estimate,
  business: Business
): Promise<{ uri: string; fileName: string }> {
  const html = estimateHtml(estimate, business);
  const { uri } = await Print.printToFileAsync({ html, base64: false });
  const fileName = estimateFileName(estimate);
  const dest = `${FileSystem.cacheDirectory}${fileName}`;
  try {
    await FileSystem.deleteAsync(dest, { idempotent: true });
    await FileSystem.moveAsync({ from: uri, to: dest });
    return { uri: dest, fileName };
  } catch {
    return { uri, fileName };
  }
}
```

- [ ] **Step 2: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: same single pre-existing baseline error, nothing new.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/estimatePdf.ts
git commit -m "Add estimatePdf.ts"
```

---

### Task 9: `frontend/app/estimates/new.tsx`

**Files:**
- Create: `frontend/app/estimates/new.tsx`

**Interfaces:**
- Consumes: `Estimate` type (Task 7); `POST /estimates` (Task 4).

- [ ] **Step 1: Create the manual-entry estimate creation screen**

Create `frontend/app/estimates/new.tsx`. This mirrors the `MANUAL` branch of `frontend/app/invoices/new.tsx` — same customer picker, line-item editor, and catalog picker — but drops the AI-draft mode entirely (not requested by the spec) and the Stripe payment URL field (estimates don't take payment), and uses "Issue date"/"Expiry date" instead of "Issue date"/"Due date":

```tsx
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React, { useEffect, useMemo, useState } from "react";
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
import { SafeAreaView } from "react-native-safe-area-context";

import { AddCustomerModal } from "@/src/components/AddCustomerModal";
import { Button } from "@/src/components/Button";
import { Card } from "@/src/components/Card";
import { DateField } from "@/src/components/DateField";
import { Input } from "@/src/components/Input";
import { api } from "@/src/lib/api";
import { computeTotals, formatMoney, parseCents } from "@/src/lib/money";
import { colors, radius, spacing, typography, webContent } from "@/src/lib/theme";
import type { CatalogItem, Customer, Estimate, LineItemDto } from "@/src/lib/types";

export default function NewEstimate() {
  const router = useRouter();

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [showPickCustomer, setShowPickCustomer] = useState(false);
  const [showAddCustomer, setShowAddCustomer] = useState(false);
  const [showPickCatalog, setShowPickCatalog] = useState(false);
  const [lineItems, setLineItems] = useState<LineItemDto[]>([
    { name: "", quantity: 1, unit_price_cents: 0, tax_percent: 0 },
  ]);
  const [notes, setNotes] = useState("");
  const [terms, setTerms] = useState("");
  const [issueDate, setIssueDate] = useState<string>("");
  const [expiryDate, setExpiryDate] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  useEffect(() => {
    api.get<Customer[]>("/customers").then(setCustomers).catch(() => {});
    api.get<CatalogItem[]>("/catalog").then(setCatalog).catch(() => {});
  }, []);

  const totals = useMemo(() => computeTotals(lineItems), [lineItems]);
  const selectedCustomer = customers.find((c) => c.id === customerId);

  const setLine = (idx: number, patch: Partial<LineItemDto>) => {
    setLineItems((prev) => prev.map((li, i) => (i === idx ? { ...li, ...patch } : li)));
  };
  const addLine = () => setLineItems((p) => [...p, { name: "", quantity: 1, unit_price_cents: 0, tax_percent: 0 }]);
  const removeLine = (idx: number) => setLineItems((p) => p.filter((_, i) => i !== idx));

  const addFromCatalog = (item: CatalogItem) => {
    setLineItems((p) => {
      const empty = p.findIndex((li) => !li.name && !li.unit_price_cents);
      const line: LineItemDto = {
        name: item.name,
        description: item.description || undefined,
        quantity: 1,
        unit_price_cents: item.unit_price_cents,
        tax_percent: item.tax_percent || 0,
      };
      if (empty >= 0) {
        return p.map((li, i) => (i === empty ? line : li));
      }
      return [...p, line];
    });
  };

  const save = async () => {
    setSaveErr(null);
    if (!customerId) return setSaveErr("Please select a customer");
    const validLines = lineItems.filter((li) => li.name && (li.unit_price_cents > 0 || li.quantity > 0));
    if (validLines.length === 0) return setSaveErr("Add at least one line item");
    setSaving(true);
    try {
      const est = await api.post<Estimate>("/estimates", {
        customer_id: customerId,
        line_items: validLines,
        notes: notes || null,
        terms: terms || null,
        issue_date: issueDate || undefined,
        expiry_date: expiryDate || undefined,
      });
      router.replace({ pathname: "/estimates/[id]", params: { id: est.id } });
    } catch (e: unknown) {
      const err = e as Error;
      setSaveErr(err.message || "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <View style={styles.topbar}>
        <TouchableOpacity testID="new-estimate-back" onPress={() => router.back()}>
          <Feather name="x" size={22} color={colors.onSurface} />
        </TouchableOpacity>
        <Text style={styles.topbarTitle}>New Estimate</Text>
        <View style={{ width: 24 }} />
      </View>

      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={[styles.scroll, webContent]} keyboardShouldPersistTaps="handled">
          {/* Customer */}
          <Card style={styles.card}>
            <Text style={styles.sectionTitle}>Customer</Text>
            {selectedCustomer ? (
              <View style={styles.selectedCustomer}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.customerName}>{selectedCustomer.name}</Text>
                  {selectedCustomer.email ? <Text style={styles.muted}>{selectedCustomer.email}</Text> : null}
                </View>
                <TouchableOpacity testID="change-customer" onPress={() => setShowPickCustomer(true)}>
                  <Text style={styles.link}>Change</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <View style={{ flexDirection: "row", gap: spacing.sm }}>
                <Button testID="pick-customer-btn" title="Select" variant="secondary" style={{ flex: 1 }} onPress={() => setShowPickCustomer(true)} />
                <Button testID="new-customer-btn" title="+ New" variant="secondary" style={{ flex: 1 }} onPress={() => setShowAddCustomer(true)} />
              </View>
            )}
          </Card>

          {/* Line items */}
          <Card style={styles.card}>
            <View style={styles.sectionRow}>
              <Text style={styles.sectionTitle}>Line items</Text>
              {catalog.length > 0 ? (
                <TouchableOpacity testID="show-catalog-btn" onPress={() => setShowPickCatalog(true)}>
                  <Text style={styles.link}>From catalog</Text>
                </TouchableOpacity>
              ) : null}
            </View>

            {lineItems.map((li, idx) => (
              <View key={idx} style={styles.lineItem}>
                <View style={styles.lineHeader}>
                  <Text style={styles.lineLabel}>Item {idx + 1}</Text>
                  {lineItems.length > 1 ? (
                    <TouchableOpacity testID={`remove-line-${idx}`} onPress={() => removeLine(idx)}>
                      <Feather name="trash-2" size={16} color={colors.error} />
                    </TouchableOpacity>
                  ) : null}
                </View>
                <Input
                  testID={`line-name-${idx}`}
                  label="Description"
                  value={li.name}
                  onChangeText={(v) => setLine(idx, { name: v })}
                  placeholder="e.g. Electrical work"
                />
                <View style={{ flexDirection: "row", gap: spacing.sm }}>
                  <View style={{ flex: 1 }}>
                    <Input
                      testID={`line-qty-${idx}`}
                      label="Qty"
                      keyboardType="decimal-pad"
                      value={String(li.quantity)}
                      onChangeText={(v) => setLine(idx, { quantity: parseFloat(v) || 0 })}
                    />
                  </View>
                  <View style={{ flex: 1.2 }}>
                    <Input
                      testID={`line-price-${idx}`}
                      label="Unit price"
                      keyboardType="decimal-pad"
                      value={(li.unit_price_cents / 100).toString()}
                      onChangeText={(v) => setLine(idx, { unit_price_cents: parseCents(v) })}
                    />
                  </View>
                  <View style={{ flex: 0.8 }}>
                    <Input
                      testID={`line-tax-${idx}`}
                      label="Tax %"
                      keyboardType="decimal-pad"
                      value={String(li.tax_percent || 0)}
                      onChangeText={(v) => setLine(idx, { tax_percent: parseFloat(v) || 0 })}
                    />
                  </View>
                </View>
                <Text style={styles.lineTotal}>
                  Line total: {formatMoney(Math.round(li.quantity * li.unit_price_cents * (1 + (li.tax_percent || 0) / 100)), "USD")}
                </Text>
              </View>
            ))}
            <TouchableOpacity testID="add-line-btn" style={styles.addLineBtn} onPress={addLine}>
              <Feather name="plus-circle" size={16} color={colors.brand} />
              <Text style={styles.link}>Add another line</Text>
            </TouchableOpacity>
          </Card>

          {/* Meta */}
          <Card style={styles.card}>
            <Text style={styles.sectionTitle}>Details</Text>
            <View style={{ flexDirection: "row", gap: spacing.md }}>
              <View style={{ flex: 1 }}>
                <DateField testID="estimate-issue-date" label="Issue date" value={issueDate} onChange={setIssueDate} placeholder="auto" maximumDate={expiryDate ? new Date(expiryDate) : undefined} />
              </View>
              <View style={{ flex: 1 }}>
                <DateField testID="estimate-expiry-date" label="Expiry date" value={expiryDate} onChange={setExpiryDate} placeholder="optional" minimumDate={issueDate ? new Date(issueDate) : undefined} />
              </View>
            </View>
            <Input testID="estimate-notes" label="Notes" multiline value={notes} onChangeText={setNotes} />
            <Input testID="estimate-terms" label="Terms" multiline value={terms} onChangeText={setTerms} />
          </Card>

          <View style={{ height: 100 }} />
        </ScrollView>

        <View style={styles.bottomBar}>
          <View style={{ flex: 1 }}>
            <Text style={styles.bottomBarLabel}>Total</Text>
            <Text style={styles.bottomBarTotal}>{formatMoney(totals.total, "USD")}</Text>
          </View>
          {saveErr ? <Text style={[styles.err, { position: "absolute", top: -22, left: spacing.lg, right: spacing.lg }]}>{saveErr}</Text> : null}
          <Button testID="save-estimate-btn" title="Save & Preview" loading={saving} onPress={save} />
        </View>
      </KeyboardAvoidingView>

      {/* Customer picker */}
      <Modal visible={showPickCustomer} animationType="slide" transparent onRequestClose={() => setShowPickCustomer(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Select a customer</Text>
              <TouchableOpacity testID="pick-customer-close" onPress={() => setShowPickCustomer(false)}>
                <Feather name="x" size={22} color={colors.muted} />
              </TouchableOpacity>
            </View>
            <ScrollView style={{ maxHeight: 400 }}>
              {customers.length === 0 ? (
                <Text style={styles.muted}>No customers yet.</Text>
              ) : (
                customers.map((c) => (
                  <TouchableOpacity
                    key={c.id}
                    testID={`pick-customer-${c.id}`}
                    style={styles.pickRow}
                    onPress={() => { setCustomerId(c.id); setShowPickCustomer(false); }}
                  >
                    <Text style={styles.customerName}>{c.name}</Text>
                    {c.email ? <Text style={styles.muted}>{c.email}</Text> : null}
                  </TouchableOpacity>
                ))
              )}
            </ScrollView>
            <Button
              testID="pick-customer-new"
              title="+ Add new customer"
              variant="secondary"
              onPress={() => { setShowPickCustomer(false); setShowAddCustomer(true); }}
              style={{ marginTop: spacing.md }}
            />
          </View>
        </View>
      </Modal>

      {/* Catalog picker */}
      <Modal visible={showPickCatalog} animationType="slide" transparent onRequestClose={() => setShowPickCatalog(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Pick from catalog</Text>
              <TouchableOpacity testID="pick-catalog-close" onPress={() => setShowPickCatalog(false)}>
                <Feather name="x" size={22} color={colors.muted} />
              </TouchableOpacity>
            </View>
            <ScrollView style={{ maxHeight: 400 }}>
              {catalog.map((it) => (
                <TouchableOpacity
                  key={it.id}
                  testID={`pick-catalog-${it.id}`}
                  style={styles.pickRow}
                  onPress={() => { addFromCatalog(it); setShowPickCatalog(false); }}
                >
                  <Text style={styles.customerName}>{it.name}</Text>
                  <Text style={styles.muted}>{formatMoney(it.unit_price_cents, it.currency || "USD")}{it.unit ? ` / ${it.unit}` : ""}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>

      <AddCustomerModal
        visible={showAddCustomer}
        onClose={() => setShowAddCustomer(false)}
        onSaved={(c) => {
          setCustomers((prev) => [...prev, c]);
          setCustomerId(c.id);
          setShowAddCustomer(false);
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  topbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  topbarTitle: { fontSize: typography.lg, fontWeight: "500", color: colors.onSurface },
  scroll: { padding: spacing.lg, paddingBottom: 40 },
  card: { marginBottom: spacing.md },
  sectionRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: spacing.md },
  sectionTitle: { fontSize: typography.lg, fontWeight: "500", color: colors.onSurface, marginBottom: spacing.md },
  link: { color: colors.brand, fontWeight: "500", fontSize: typography.base },
  selectedCustomer: {
    flexDirection: "row",
    alignItems: "center",
    padding: spacing.md,
    backgroundColor: colors.brandTertiary,
    borderRadius: radius.md,
  },
  customerName: { fontSize: typography.lg, fontWeight: "500", color: colors.onSurface },
  muted: { fontSize: typography.base, color: colors.muted, marginTop: 2 },
  lineItem: {
    borderTopWidth: 1,
    borderTopColor: colors.divider,
    paddingTop: spacing.md,
    marginTop: spacing.sm,
  },
  lineHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: spacing.sm },
  lineLabel: { fontSize: typography.sm, color: colors.muted, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: "500" },
  lineTotal: { fontSize: typography.sm, color: colors.onSurface, marginTop: spacing.xs, fontWeight: "500" },
  addLineBtn: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: spacing.md },
  err: { color: colors.error, fontSize: typography.base, marginBottom: spacing.md },
  bottomBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
    backgroundColor: colors.surfaceSecondary,
  },
  bottomBarLabel: { fontSize: typography.sm, color: colors.muted },
  bottomBarTotal: { fontSize: 24, fontWeight: "600", color: colors.onSurface, letterSpacing: -0.5 },
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  modalCard: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: spacing.lg,
    paddingBottom: spacing.xxxl,
    maxHeight: "80%",
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: spacing.lg,
  },
  modalTitle: { fontSize: 20, fontWeight: "600", color: colors.onSurface },
  pickRow: {
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceSecondary,
    marginBottom: spacing.sm,
  },
});
```

Note: the bottom-bar and line-total `formatMoney` calls above use `"USD"` as a hardcoded fallback currency, matching the fact that this screen (unlike the invoice screen, which reads `business?.currency` via `useAuth()`) doesn't need the business context otherwise — if a wired-in currency reads oddly during manual testing in Task 11's verification pass, pull in `useAuth()` the same way `frontend/app/invoices/new.tsx` does and use `business?.currency || "USD"` instead; this is a one-line change if needed and not worth a separate task.

- [ ] **Step 2: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: same single pre-existing baseline error, nothing new.

- [ ] **Step 3: Commit**

```bash
git add frontend/app/estimates/new.tsx
git commit -m "Add New Estimate screen"
```

---

### Task 10: `frontend/app/estimates/[id].tsx`

**Files:**
- Create: `frontend/app/estimates/[id].tsx`

**Interfaces:**
- Consumes: `Estimate` type (Task 7); `estimateHtml`/`generateEstimatePdfFile` (Task 8); `GET/POST /estimates/{id}/*` endpoints (Tasks 4-6).

- [ ] **Step 1: Create the estimate detail screen**

Create `frontend/app/estimates/[id].tsx`, mirroring `frontend/app/invoices/[id].tsx`'s structure (topbar, status row, amount hero, sections, action bar, actions-sheet modal) but with estimate-specific actions instead of payment ones:

```tsx
import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as MailComposer from "expo-mail-composer";
import * as Sharing from "expo-sharing";
import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { StatusPill } from "@/src/components/StatusPill";
import { useAuth } from "@/src/context/AuthContext";
import { api } from "@/src/lib/api";
import { estimateHtml, generateEstimatePdfFile } from "@/src/lib/estimatePdf";
import { formatMoney } from "@/src/lib/money";
import { colors, radius, spacing, typography, webContent } from "@/src/lib/theme";
import type { Business, Estimate, Invoice } from "@/src/lib/types";

export default function EstimateDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { business } = useAuth();

  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [showActions, setShowActions] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const est = await api.get<Estimate>(`/estimates/${id}`);
      setEstimate(est);
    } catch (e) {
      Alert.alert("Error", e instanceof Error ? e.message : "Failed to load");
      router.back();
    } finally {
      setLoading(false);
    }
  }, [id, router]);

  useEffect(() => { load(); }, [load]);

  if (loading || !estimate || !business) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <ActivityIndicator style={{ marginTop: 60 }} size="large" color={colors.brand} />
      </SafeAreaView>
    );
  }

  const isDraft = estimate.status === "DRAFT";
  const isSent = estimate.status === "SENT";
  const isDeclined = estimate.status === "DECLINED";
  const isConverted = estimate.status === "CONVERTED";
  const canConvert = !isDeclined && !isConverted;

  const openHtmlInNewTab = (html: string, autoPrint: boolean) => {
    if (typeof window === "undefined") return false;
    const win = window.open("", "_blank");
    if (!win) {
      Alert.alert("Popup blocked", "Please allow popups for this site, then try again.");
      return false;
    }
    win.document.open();
    win.document.write(html);
    win.document.close();
    if (autoPrint) {
      setTimeout(() => { try { win.focus(); win.print(); } catch { /* ignore */ } }, 400);
    }
    return true;
  };

  const markSentIfDraft = async () => {
    if (estimate?.status === "DRAFT") {
      try {
        const updated = await api.post<Estimate>(`/estimates/${estimate.id}/send`, {});
        setEstimate(updated);
      } catch { /* ignore */ }
    }
  };

  const sendEmail = async () => {
    if (!estimate || !business) return;
    setBusy(true);
    try {
      const subject = `Estimate ${estimate.number} from ${business.name}`;
      const customerName = estimate.customer?.name ?? "there";
      const total = formatMoney(estimate.total_cents, estimate.currency);
      const body = `Hi ${customerName}, please find attached Estimate ${estimate.number} for ${total}. Thank you!`;
      const recipientEmail = estimate.customer?.email ?? undefined;

      if (Platform.OS === "web") {
        const { url } = await api.post<{ url: string }>(`/estimates/${estimate.id}/email-pdf`, {
          html: estimateHtml(estimate, business as Business),
        });
        const webBody = `Hi ${customerName},\n\nPlease find your estimate here:\n${url}\n\nTotal: ${total}. Thank you!`;
        const encodedSubject = encodeURIComponent(subject);
        const encodedBody = encodeURIComponent(webBody);
        await Linking.openURL(`mailto:${recipientEmail ?? ""}?subject=${encodedSubject}&body=${encodedBody}`);
      } else {
        const { uri } = await generateEstimatePdfFile(estimate, business as Business);
        const canCompose = await MailComposer.isAvailableAsync();
        if (!canCompose) {
          Alert.alert("Email unavailable", "No mail app is configured on this device.");
          return;
        }
        await MailComposer.composeAsync({
          recipients: recipientEmail ? [recipientEmail] : [],
          subject,
          body,
          attachments: [uri],
        });
      }
      await markSentIfDraft();
    } catch (e) {
      Alert.alert("Send failed", e instanceof Error ? e.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  };

  const downloadPdf = async () => {
    if (!estimate) return;
    setBusy(true);
    try {
      if (Platform.OS === "web") {
        openHtmlInNewTab(estimateHtml(estimate, business as Business), true);
      } else {
        const { uri, fileName } = await generateEstimatePdfFile(estimate, business as Business);
        const canShare = await Sharing.isAvailableAsync();
        if (!canShare) {
          Alert.alert("Download unavailable", "PDF download isn't available on this device.");
          return;
        }
        await Sharing.shareAsync(uri, {
          mimeType: "application/pdf",
          dialogTitle: `Save ${fileName}`,
          UTI: "com.adobe.pdf",
        });
      }
    } catch (e) {
      Alert.alert("Download failed", e instanceof Error ? e.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  };

  const acceptEstimate = async () => {
    setBusy(true);
    try {
      const updated = await api.post<Estimate>(`/estimates/${estimate.id}/accept`, {});
      setEstimate(updated);
    } catch (e) {
      Alert.alert("Error", e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  const declineEstimate = async () => {
    Alert.alert("Decline estimate?", "This can't be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Decline",
        style: "destructive",
        onPress: async () => {
          setBusy(true);
          try {
            const updated = await api.post<Estimate>(`/estimates/${estimate.id}/decline`, {});
            setEstimate(updated);
          } catch (e) {
            Alert.alert("Error", e instanceof Error ? e.message : "Failed");
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  };

  const convertToInvoice = async () => {
    setBusy(true);
    try {
      const inv = await api.post<Invoice>(`/estimates/${estimate.id}/convert`, {});
      router.replace({ pathname: "/invoices/[id]", params: { id: inv.id } });
    } catch (e: unknown) {
      const err = e as Error & { body?: { detail?: { error?: string; message?: string } } };
      if (err.body?.detail?.error === "PLAN_LIMIT_REACHED") {
        Alert.alert("Plan limit reached", err.body.detail.message || "Upgrade in Settings.");
      } else {
        Alert.alert("Error", err.message || "Failed to convert");
      }
    } finally {
      setBusy(false);
    }
  };

  const duplicate = async () => {
    setBusy(true);
    try {
      const newEst = await api.post<Estimate>(`/estimates/${estimate.id}/duplicate`, {});
      setShowActions(false);
      router.replace({ pathname: "/estimates/[id]", params: { id: newEst.id } });
    } catch (e) {
      Alert.alert("Error", e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  const deleteDraft = async () => {
    Alert.alert("Delete estimate?", "This can't be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          setBusy(true);
          try {
            await api.del(`/estimates/${estimate.id}`);
            setShowActions(false);
            router.back();
          } catch (e) {
            Alert.alert("Error", e instanceof Error ? e.message : "Failed");
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <View style={styles.topbar}>
        <TouchableOpacity testID="estimate-back" onPress={() => router.back()}>
          <Feather name="chevron-left" size={24} color={colors.onSurface} />
        </TouchableOpacity>
        <Text style={styles.topbarTitle}>{estimate.number}</Text>
        <TouchableOpacity testID="estimate-more" onPress={() => setShowActions(true)}>
          <Feather name="more-horizontal" size={22} color={colors.onSurface} />
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={[styles.scroll, Platform.OS === "web" && styles.scrollWeb]}>
        <View style={paperStyle}>
          {/* Status row */}
          <View style={styles.statusRow}>
            <StatusPill status={estimate.status} testID="estimate-status" />
            <Text style={styles.metaText}>{estimate.expiry_date ? `Expires ${estimate.expiry_date}` : "No expiry"}</Text>
          </View>

          {/* Amount hero */}
          <View style={styles.amountCard}>
            <Text style={styles.amountLabel}>Total</Text>
            <Text testID="estimate-total" style={styles.amountValue}>{formatMoney(estimate.total_cents, estimate.currency)}</Text>
            {isConverted && estimate.converted_invoice_id ? (
              <TouchableOpacity
                testID="estimate-view-invoice"
                onPress={() => router.push({ pathname: "/invoices/[id]", params: { id: estimate.converted_invoice_id as string } })}
              >
                <Text style={[styles.link, { marginTop: spacing.sm }]}>View converted invoice →</Text>
              </TouchableOpacity>
            ) : null}
          </View>

          {/* Prepared for */}
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Prepared for</Text>
            <Text style={styles.customerName}>{estimate.customer?.name}</Text>
            {estimate.customer?.company ? <Text style={styles.muted}>{estimate.customer.company}</Text> : null}
            {estimate.customer?.email ? <Text style={styles.muted}>{estimate.customer.email}</Text> : null}
          </View>

          {/* Line items */}
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Line items</Text>
            {estimate.line_items.map((li, idx) => (
              <View key={idx} style={styles.lineItem}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.lineName}>{li.name}</Text>
                  {li.description ? <Text style={styles.muted}>{li.description}</Text> : null}
                  <Text style={styles.muted}>
                    {li.quantity} × {formatMoney(li.unit_price_cents, estimate.currency)}
                    {li.tax_percent ? ` · ${li.tax_percent}% tax` : ""}
                  </Text>
                </View>
                <Text style={styles.lineTotal}>
                  {formatMoney(Math.round(li.quantity * li.unit_price_cents * (1 + (li.tax_percent || 0) / 100)), estimate.currency)}
                </Text>
              </View>
            ))}

            <View style={styles.totalsBlock}>
              <TotalRow label="Subtotal" value={formatMoney(estimate.subtotal_cents, estimate.currency)} />
              {estimate.tax_total_cents ? <TotalRow label="Tax" value={formatMoney(estimate.tax_total_cents, estimate.currency)} /> : null}
              {estimate.discount_cents ? <TotalRow label="Discount" value={`- ${formatMoney(estimate.discount_cents, estimate.currency)}`} /> : null}
              <View style={styles.totalDivider} />
              <TotalRow label="Total" value={formatMoney(estimate.total_cents, estimate.currency)} bold />
            </View>
          </View>

          {estimate.notes ? (
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>Notes</Text>
              <Text style={styles.notes}>{estimate.notes}</Text>
            </View>
          ) : null}

          {estimate.terms ? (
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>Terms</Text>
              <Text style={styles.terms}>{estimate.terms}</Text>
            </View>
          ) : null}
        </View>
        <View style={{ height: Platform.OS === "web" ? 40 : 160 }} />
      </ScrollView>

      {/* Action bar */}
      <View style={styles.actionBar}>
        <View style={[styles.actionBarInner, webContent]}>
          <TouchableOpacity
            testID="estimate-download-pdf-btn"
            style={[styles.actionBtn, styles.actionBtnOutline]}
            onPress={downloadPdf}
            disabled={busy}
            activeOpacity={0.85}
          >
            <Feather name="download" size={20} color={colors.brand} />
            <Text style={[styles.actionBtnText, { color: colors.brand }]}>Download PDF</Text>
          </TouchableOpacity>
          {isSent ? (
            <>
              <TouchableOpacity
                testID="estimate-decline-btn"
                style={[styles.actionBtn, styles.actionBtnOutline, { borderColor: colors.error }]}
                onPress={declineEstimate}
                disabled={busy}
              >
                <Feather name="x" size={20} color={colors.error} />
                <Text style={[styles.actionBtnText, { color: colors.error }]}>Decline</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID="estimate-accept-btn"
                style={styles.actionBtn}
                onPress={acceptEstimate}
                disabled={busy}
              >
                <Feather name="check" size={20} color={colors.onBrandPrimary} />
                <Text style={styles.actionBtnText}>Accept</Text>
              </TouchableOpacity>
            </>
          ) : (
            <TouchableOpacity
              testID="estimate-send-email-btn"
              style={styles.actionBtn}
              onPress={sendEmail}
              disabled={busy}
              activeOpacity={0.85}
            >
              <Feather name="mail" size={20} color={colors.onBrandPrimary} />
              <Text style={styles.actionBtnText}>Send Email</Text>
            </TouchableOpacity>
          )}
        </View>
        {canConvert ? (
          <View style={[webContent, { marginTop: spacing.sm }]}>
            <TouchableOpacity
              testID="estimate-convert-btn"
              style={styles.convertBtn}
              onPress={convertToInvoice}
              disabled={busy}
              activeOpacity={0.85}
            >
              <Feather name="repeat" size={18} color={colors.brand} />
              <Text style={styles.convertBtnText}>Convert to Invoice</Text>
            </TouchableOpacity>
          </View>
        ) : null}
      </View>

      {/* Actions modal */}
      <Modal visible={showActions} transparent animationType="fade" onRequestClose={() => setShowActions(false)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setShowActions(false)}>
          <View style={styles.actionsSheet}>
            <TouchableOpacity testID="estimate-duplicate" style={styles.actionRow} onPress={duplicate}>
              <Feather name="copy" size={18} color={colors.onSurface} />
              <Text style={styles.actionRowText}>Duplicate</Text>
            </TouchableOpacity>
            {isDraft ? (
              <TouchableOpacity testID="estimate-delete" style={styles.actionRow} onPress={deleteDraft}>
                <Feather name="trash-2" size={18} color={colors.error} />
                <Text style={[styles.actionRowText, { color: colors.error }]}>Delete estimate</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity style={[styles.actionRow, { justifyContent: "center" }]} onPress={() => setShowActions(false)}>
              <Text style={styles.actionRowText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    </SafeAreaView>
  );
}

function TotalRow({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <View style={styles.totalRow}>
      <Text style={[styles.totalLabel, bold && { fontWeight: "600", color: colors.onSurface }]}>{label}</Text>
      <Text style={[styles.totalValue, bold && { fontSize: 20, color: colors.brand, fontWeight: "600" }]}>{value}</Text>
    </View>
  );
}

const paperStyle =
  Platform.OS === "web"
    ? ({
        width: "100%",
        maxWidth: 640,
        alignSelf: "center",
        backgroundColor: colors.surfaceSecondary,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 12,
        paddingHorizontal: 36,
        paddingVertical: 40,
        minHeight: 900,
        boxShadow: "0 1px 2px rgba(17,17,16,0.05), 0 10px 30px -8px rgba(17,17,16,0.10)",
      } as object)
    : undefined;

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  scrollWeb: { paddingVertical: spacing.xxl },
  topbar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  topbarTitle: { fontSize: typography.lg, fontWeight: "500", color: colors.onSurface },
  scroll: { padding: spacing.lg },
  statusRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: spacing.lg },
  metaText: { color: colors.muted, fontSize: typography.base },
  amountCard: {
    padding: spacing.xl,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    marginBottom: spacing.lg,
  },
  amountLabel: { fontSize: 11, color: colors.muted, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: "500" },
  amountValue: { fontSize: 44, fontWeight: "600", color: colors.onSurface, letterSpacing: -1.5, marginTop: 4 },
  link: { color: colors.brand, fontWeight: "500", fontSize: typography.base },
  section: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  sectionLabel: { fontSize: 11, fontWeight: "500", color: colors.muted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: spacing.sm },
  customerName: { fontSize: typography.lg, fontWeight: "500", color: colors.onSurface },
  muted: { fontSize: typography.base, color: colors.muted, marginTop: 2 },
  lineItem: {
    flexDirection: "row",
    paddingVertical: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
  },
  lineName: { fontSize: typography.lg, fontWeight: "500", color: colors.onSurface },
  lineTotal: { fontSize: typography.lg, fontWeight: "500", color: colors.onSurface, marginLeft: spacing.md },
  totalsBlock: { marginTop: spacing.md, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.divider },
  totalRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 6 },
  totalLabel: { color: colors.muted, fontSize: typography.base },
  totalValue: { color: colors.onSurface, fontSize: typography.base },
  totalDivider: { height: 2, backgroundColor: colors.onSurface, marginVertical: spacing.sm },
  notes: { color: colors.onSurface, fontSize: typography.base, lineHeight: 22 },
  terms: { color: colors.muted, fontSize: typography.sm, lineHeight: 20 },
  actionBar: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: Platform.OS === "ios" ? spacing.md : spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
    backgroundColor: colors.surfaceSecondary,
  },
  actionBarInner: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  actionBtn: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    backgroundColor: colors.brand,
    paddingVertical: spacing.sm,
    paddingHorizontal: 4,
    borderRadius: radius.md,
    minHeight: 56,
  },
  actionBtnOutline: {
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.brand,
  },
  actionBtnText: {
    color: colors.onBrandPrimary,
    fontWeight: "500",
    fontSize: 12,
    textAlign: "center",
  },
  convertBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    height: 44,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.brand,
    backgroundColor: colors.brandTertiary,
  },
  convertBtnText: { color: colors.brand, fontWeight: "500", fontSize: typography.base },
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  actionsSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: spacing.md,
    paddingBottom: spacing.xxxl,
  },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.md,
  },
  actionRowText: { color: colors.onSurface, fontSize: typography.lg, fontWeight: "500" },
});
```

- [ ] **Step 2: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: same single pre-existing baseline error, nothing new.

- [ ] **Step 3: Commit**

```bash
git add frontend/app/estimates/[id].tsx
git commit -m "Add Estimate detail screen with lifecycle actions"
```

---

### Task 11: Invoices/Estimates segmented toggle

**Files:**
- Modify: `frontend/app/(app)/invoices.tsx`

**Interfaces:**
- Consumes: `Estimate`, `EstimateStatus` types (Task 7); `/estimates` list endpoint (Task 4); `/estimates/new` and `/estimates/[id]` routes (Tasks 9, 10).

- [ ] **Step 1: Add the segmented toggle and estimate list support**

Replace the full contents of `frontend/app/(app)/invoices.tsx` with:

```tsx
import { Feather } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import React, { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { EmptyState } from "@/src/components/Card";
import { DateField } from "@/src/components/DateField";
import { StatusPill } from "@/src/components/StatusPill";
import { api } from "@/src/lib/api";
import { downloadCsv, toCsv, todayStamp } from "@/src/lib/csv";
import { formatMoney } from "@/src/lib/money";
import { colors, radius, spacing, typography, webContent } from "@/src/lib/theme";
import type { Estimate, EstimateStatus, Invoice, InvoiceStatus } from "@/src/lib/types";

type Mode = "INVOICES" | "ESTIMATES";

const INVOICE_FILTERS: ({ key: "ALL"; label: string } | { key: InvoiceStatus; label: string })[] = [
  { key: "ALL", label: "All" },
  { key: "DRAFT", label: "Draft" },
  { key: "SENT", label: "Sent" },
  { key: "PAID", label: "Paid" },
  { key: "OVERDUE", label: "Overdue" },
  { key: "VOID", label: "Void" },
];

const ESTIMATE_FILTERS: ({ key: "ALL"; label: string } | { key: EstimateStatus; label: string })[] = [
  { key: "ALL", label: "All" },
  { key: "DRAFT", label: "Draft" },
  { key: "SENT", label: "Sent" },
  { key: "ACCEPTED", label: "Accepted" },
  { key: "DECLINED", label: "Declined" },
  { key: "CONVERTED", label: "Converted" },
];

export default function Invoices() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("INVOICES");

  const [invoiceItems, setInvoiceItems] = useState<Invoice[]>([]);
  const [invoiceFilter, setInvoiceFilter] = useState<"ALL" | InvoiceStatus>("ALL");

  const [estimateItems, setEstimateItems] = useState<Estimate[]>([]);
  const [estimateFilter, setEstimateFilter] = useState<"ALL" | EstimateStatus>("ALL");

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const load = useCallback(async () => {
    try {
      const [invoices, estimates] = await Promise.all([
        api.get<Invoice[]>("/invoices"),
        api.get<Estimate[]>("/estimates"),
      ]);
      setInvoiceItems(invoices);
      setEstimateItems(estimates);
    } catch {
      /* ignore — AuthContext redirects if the session is invalid */
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const filteredInvoices = useMemo(() => {
    return invoiceItems.filter((inv) => {
      if (invoiceFilter !== "ALL" && inv.status !== invoiceFilter) return false;
      if (search) {
        const hay = `${inv.number} ${inv.customer?.name || ""}`.toLowerCase();
        if (!hay.includes(search.toLowerCase())) return false;
      }
      return true;
    });
  }, [invoiceItems, invoiceFilter, search]);

  const filteredEstimates = useMemo(() => {
    return estimateItems.filter((est) => {
      if (estimateFilter !== "ALL" && est.status !== estimateFilter) return false;
      if (search) {
        const hay = `${est.number} ${est.customer?.name || ""}`.toLowerCase();
        if (!hay.includes(search.toLowerCase())) return false;
      }
      return true;
    });
  }, [estimateItems, estimateFilter, search]);

  const exportCsv = async () => {
    // ISO YYYY-MM-DD strings compare correctly as plain strings.
    const inRange = (inv: Invoice) => {
      const d = inv.issue_date || (inv.created_at || "").slice(0, 10);
      if (fromDate.trim() && d < fromDate.trim()) return false;
      if (toDate.trim() && d > toDate.trim()) return false;
      return true;
    };
    const rows = filteredInvoices.filter(inRange).map((inv) => {
      const lineDesc = inv.line_items
        .map((li) => `${li.quantity} x ${li.name}${li.description ? ` (${li.description})` : ""}`)
        .join("; ");
      const invoiceStatus = inv.status === "PAID" ? "Paid" : inv.status === "VOID" ? "Void" : "Unpaid";
      const payStatus =
        inv.status === "PAID" ? "Paid" : (inv.amount_paid_cents || 0) > 0 ? "Partially Paid" : "Unpaid";
      return [
        inv.issue_date,
        invoiceStatus,
        inv.customer?.name || "",
        lineDesc,
        formatMoney(inv.total_cents, inv.currency),
        payStatus,
      ];
    });
    const csv = toCsv(
      ["Invoice Date", "Invoice Status", "Customer Name", "Description / Line Items", "Amount Charged", "Payment Status"],
      rows
    );
    await downloadCsv(`invoices_report_${todayStamp()}.csv`, csv);
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={[styles.header, webContent]}>
        <Text style={styles.title}>{mode === "INVOICES" ? "Invoices" : "Estimates"}</Text>
        <TouchableOpacity
          testID="invoices-new-btn"
          onPress={() => router.push(mode === "INVOICES" ? "/invoices/new" : "/estimates/new")}
          style={styles.newBtn}
          activeOpacity={0.85}
        >
          <Feather name="plus" size={16} color={colors.onBrandPrimary} />
          <Text style={styles.newBtnText}>New</Text>
        </TouchableOpacity>
      </View>

      {/* Invoices/Estimates segmented toggle */}
      <View style={[styles.segmentRow, webContent]}>
        <TouchableOpacity
          testID="mode-invoices"
          onPress={() => setMode("INVOICES")}
          style={[styles.segment, mode === "INVOICES" && styles.segmentActive]}
        >
          <Text style={[styles.segmentText, mode === "INVOICES" && styles.segmentTextActive]}>Invoices</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="mode-estimates"
          onPress={() => setMode("ESTIMATES")}
          style={[styles.segment, mode === "ESTIMATES" && styles.segmentActive]}
        >
          <Text style={[styles.segmentText, mode === "ESTIMATES" && styles.segmentTextActive]}>Estimates</Text>
        </TouchableOpacity>
      </View>

      <View style={[styles.searchWrap, webContent]}>
        <Feather name="search" size={16} color={colors.muted} />
        <TextInput
          testID="invoices-search"
          placeholder={mode === "INVOICES" ? "Search by number or customer" : "Search by number or customer"}
          placeholderTextColor={colors.muted}
          style={styles.searchInput}
          value={search}
          onChangeText={setSearch}
        />
      </View>

      {/* Report export: date range + CSV download — invoices only */}
      {mode === "INVOICES" ? (
        <View style={[styles.exportSection, webContent]}>
          <View style={styles.dateRow}>
            <View style={styles.dateFieldWrap}>
              <DateField testID="invoices-from-date" placeholder="From date" value={fromDate} onChange={setFromDate} maximumDate={toDate ? new Date(toDate) : undefined} />
            </View>
            <View style={styles.dateFieldWrap}>
              <DateField testID="invoices-to-date" placeholder="To date" value={toDate} onChange={setToDate} minimumDate={fromDate ? new Date(fromDate) : undefined} />
            </View>
          </View>
          <TouchableOpacity testID="invoices-download-csv" style={styles.csvBtn} onPress={exportCsv} activeOpacity={0.85}>
            <Feather name="download" size={14} color={colors.brand} />
            <Text style={styles.csvBtnText}>Download CSV</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chipsRow}
        style={[styles.chipsScroll, webContent]}
      >
        {(mode === "INVOICES" ? INVOICE_FILTERS : ESTIMATE_FILTERS).map((f) => {
          const active = mode === "INVOICES" ? invoiceFilter === f.key : estimateFilter === f.key;
          return (
            <TouchableOpacity
              key={f.key}
              testID={`invoices-chip-${f.key.toLowerCase()}`}
              onPress={() => (mode === "INVOICES" ? setInvoiceFilter(f.key as "ALL" | InvoiceStatus) : setEstimateFilter(f.key as "ALL" | EstimateStatus))}
              activeOpacity={0.85}
              style={[styles.chip, active && styles.chipActive]}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>{f.label}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} size="large" color={colors.brand} />
      ) : mode === "INVOICES" ? (
        filteredInvoices.length === 0 ? (
          <EmptyState
            testID="invoices-empty"
            title="No invoices match this filter"
            subtitle="Try a different filter or create a new invoice."
          />
        ) : (
          <FlatList
            data={filteredInvoices}
            keyExtractor={(i) => i.id}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.brand} />}
            contentContainerStyle={[styles.list, webContent]}
            renderItem={({ item }) => (
              <TouchableOpacity
                testID={`invoice-card-${item.number}`}
                style={styles.card}
                onPress={() => router.push({ pathname: "/invoices/[id]", params: { id: item.id } })}
                activeOpacity={0.85}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardNumber}>{item.number}</Text>
                  <Text style={styles.cardCustomer}>{item.customer?.name || "—"}</Text>
                  <Text style={styles.cardDate}>Due {item.due_date}</Text>
                </View>
                <View style={{ alignItems: "flex-end", gap: 6 }}>
                  <Text style={styles.cardAmount}>{formatMoney(item.total_cents, item.currency)}</Text>
                  <StatusPill status={item.status} />
                </View>
              </TouchableOpacity>
            )}
          />
        )
      ) : filteredEstimates.length === 0 ? (
        <EmptyState
          testID="estimates-empty"
          title="No estimates match this filter"
          subtitle="Try a different filter or create a new estimate."
        />
      ) : (
        <FlatList
          data={filteredEstimates}
          keyExtractor={(i) => i.id}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.brand} />}
          contentContainerStyle={[styles.list, webContent]}
          renderItem={({ item }) => (
            <TouchableOpacity
              testID={`estimate-card-${item.number}`}
              style={styles.card}
              onPress={() => router.push({ pathname: "/estimates/[id]", params: { id: item.id } })}
              activeOpacity={0.85}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.cardNumber}>{item.number}</Text>
                <Text style={styles.cardCustomer}>{item.customer?.name || "—"}</Text>
                <Text style={styles.cardDate}>{item.expiry_date ? `Expires ${item.expiry_date}` : "No expiry"}</Text>
              </View>
              <View style={{ alignItems: "flex-end", gap: 6 }}>
                <Text style={styles.cardAmount}>{formatMoney(item.total_cents, item.currency)}</Text>
                <StatusPill status={item.status} />
              </View>
            </TouchableOpacity>
          )}
        />
      )}
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
  segmentRow: {
    flexDirection: "row",
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    backgroundColor: colors.surfaceTertiary,
    borderRadius: radius.pill,
    padding: 3,
  },
  segment: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    height: 36,
    borderRadius: radius.pill,
  },
  segmentActive: { backgroundColor: colors.surfaceSecondary },
  segmentText: { fontSize: typography.base, fontWeight: "500", color: colors.onSurfaceTertiary },
  segmentTextActive: { color: colors.onSurface },
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
  exportSection: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
  },
  dateRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  dateFieldWrap: { flex: 1 },
  csvBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "flex-end",
    gap: 6,
    height: 40,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.brand,
    backgroundColor: colors.brandTertiary,
  },
  csvBtnText: { color: colors.brand, fontWeight: "500", fontSize: typography.sm },
  chipsScroll: { flexGrow: 0, marginTop: spacing.sm, maxHeight: 56 },
  chipsRow: { paddingHorizontal: spacing.lg, gap: spacing.sm, alignItems: "center", height: 56 },
  chip: {
    flexShrink: 0,
    height: 36,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceSecondary,
    alignItems: "center",
    justifyContent: "center",
  },
  chipActive: { backgroundColor: colors.brandTertiary, borderColor: colors.brand },
  chipText: { color: colors.onSurfaceTertiary, fontSize: typography.base, fontWeight: "500" },
  chipTextActive: { color: colors.brand },
  list: { padding: spacing.lg, paddingBottom: 100 },
  card: {
    flexDirection: "row",
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.sm,
    alignItems: "center",
  },
  cardNumber: { fontSize: typography.lg, fontWeight: "500", color: colors.onSurface },
  cardCustomer: { fontSize: typography.base, color: colors.onSurfaceTertiary, marginTop: 2 },
  cardDate: { fontSize: typography.sm, color: colors.muted, marginTop: 4 },
  cardAmount: { fontSize: 18, fontWeight: "500", color: colors.onSurface },
});
```

- [ ] **Step 2: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: same single pre-existing baseline error, nothing new.

- [ ] **Step 3: Verify manually**

Run the app (`cd frontend && npx expo start`), sign in. Confirm:
- The Invoices screen defaults to the Invoices segment, unchanged from before (existing invoice list/filters/CSV export/search all still work).
- Tapping "Estimates" swaps the list to estimates, shows the estimate-specific filter chips (Draft/Sent/Accepted/Declined/Converted), and hides the date-range/CSV export row.
- "New" creates an estimate when on the Estimates segment, an invoice when on the Invoices segment.
- Creating an estimate, sending it, accepting it, and converting it lands on the resulting invoice's detail screen, and that invoice's line items/total match the estimate's.
- A declined estimate shows no "Convert to Invoice" button.
- Deleting a DRAFT estimate works from the "..." menu; the option doesn't appear once the estimate is SENT or later.

- [ ] **Step 4: Commit**

```bash
git add frontend/app/\(app\)/invoices.tsx
git commit -m "Add Invoices/Estimates segmented toggle"
```

---

## Self-review notes

- **Spec coverage:** Every section of `docs/superpowers/specs/2026-08-06-estimates-quotes-design.md` maps to a task — shared-code extraction (1, 2), data model (3), CRUD (4), lifecycle (5), convert/email (6), frontend types/StatusPill (7), PDF template (8), creation screen (9), detail screen (10), segmented toggle (11). No spec requirement without a task.
- **Type consistency verified:** `Estimate`/`EstimateStatus` (Task 7) are used with identical field names across Tasks 8–11. The backend's `_serialize_estimate`/`_get_estimate_with_items`/`_line_item_dict` helpers (Task 4) are the exact names Tasks 5 and 6 build on. `convert_estimate` (Task 6) deliberately reuses `invoices.py`'s own `_serialize_invoice`/`_get_invoice_with_items` rather than writing a second, parallel invoice-serialization function — this cross-router import of underscore-prefixed helpers is a small convention bend, accepted here specifically to avoid a second copy of invoice serialization logic that could drift from the first.
- **No route registered before its screen exists:** Task 11 (the toggle, which links to `/estimates/new` and `/estimates/[id]`) is deliberately last among the frontend tasks, after Tasks 9 and 10 create those routes.
