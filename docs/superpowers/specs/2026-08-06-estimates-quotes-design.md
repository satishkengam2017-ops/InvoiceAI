# Design: Estimates & Quotes

## Problem

InvoiceAI can only create invoices — there's no way to send a customer a quote for approval before committing to billable work. This is the next module in the Business OS expansion plan (`docs/superpowers/specs/2026-08-05-expense-management-design.md`'s sibling spec for Sales & Money In), and is designed to reuse the existing Invoice engine as closely as possible rather than building a parallel system.

## Scope

- New `Estimate`/`EstimateLineItem` tables and a CRUD + lifecycle router, reusing `compute_totals()` from `backend/app/routers/invoices.py` as the single source of truth for totals math (imported, not duplicated).
- Estimate numbering follows the exact same atomic-increment pattern as invoices, via two new `Business` columns (`estimate_prefix`, `next_estimate_no`).
- Status lifecycle: `DRAFT → SENT → ACCEPTED / DECLINED → CONVERTED`. No `VIEWED` (no customer portal exists to track a view) and no stored `EXPIRED` (an estimate's `expiry_date` having passed is a UI-computed badge on a `SENT` estimate, never a stored transition — this codebase has no cron/background-job infrastructure, and building one is out of scope for this module).
- Acceptance/decline is manual: the business owner marks an estimate Accepted or Declined themselves (after a call, email reply, etc.). No customer-facing accept/decline page — that's deferred to the future Customer Portal module.
- "Convert to Invoice" creates a new DRAFT `Invoice` copying the estimate's customer, line items, and discount, using the same copy logic as `invoices.py`'s existing `duplicate_invoice`. Convert is allowed from DRAFT, SENT, or ACCEPTED (not gated strictly behind ACCEPTED — a single-owner manual workflow shouldn't require two separate actions when one decision covers it), and blocked from DECLINED/CONVERTED.
- Estimates fold into the existing Invoices screen via a segmented Invoices/Estimates toggle — no new tab-bar slot (the tab bar is already at 6 items after the Expenses module shipped).
- Explicitly out of scope: converting an estimate directly to a "Job" (Job Management doesn't exist yet), any customer-facing acceptance surface, automatic expiry.

## Data model

New Alembic migration, following this codebase's existing conventions (`PG_UUID(as_uuid=False)` string PKs via `new_id()`, `business_id` FK with `ondelete="CASCADE"` + index, `_cents` integer money columns):

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

`Business` gets two new nullable-with-default columns, mirroring `invoice_prefix`/`next_invoice_no` exactly: `estimate_prefix` (default `"EST"`), `next_estimate_no` (default `1`).

## Backend

New router `backend/app/routers/estimates.py`, structured like `invoices.py` (same `get_business`/`get_db` dependencies, same `_serialize_estimate`/`_get_estimate_with_items` helper pair, same `_line_item_dict` shape). Imports and reuses `compute_totals()` from `invoices.py` rather than reimplementing it.

| Endpoint | Behavior |
|---|---|
| `GET /estimates` | List, filters `status_filter`/`q`, same shape as `list_invoices` |
| `POST /estimates` | Create as DRAFT; atomic numbering via `Business.next_estimate_no` (same `sql_update(...).returning(...)` pattern as invoice numbering) |
| `GET /estimates/{id}` | Detail with line items + customer summary |
| `PATCH /estimates/{id}` | Edit; blocked (400) once `status != "DRAFT"`, same rule as `update_invoice` |
| `DELETE /estimates/{id}` | Hard delete, but only while `status == "DRAFT"` (400 otherwise) — unlike invoices (which never hard-delete, only void), an estimate that was never sent has no downstream references worth preserving |
| `POST /estimates/{id}/send` | `DRAFT → SENT`, sets `sent_at` |
| `POST /estimates/{id}/accept` | `SENT → ACCEPTED`, sets `accepted_at`; 400 if not currently SENT |
| `POST /estimates/{id}/decline` | `SENT → DECLINED`, sets `declined_at`; 400 if not currently SENT |
| `POST /estimates/{id}/convert` | Creates a new DRAFT `Invoice` (same field-copy + line-item-copy logic as `duplicate_invoice`), sets `converted_invoice_id`, `converted_at`, `status = "CONVERTED"` on the estimate. Allowed from DRAFT/SENT/ACCEPTED; 400 from DECLINED/CONVERTED. Runs the invoice plan-limit check (`check_plan_limit`) exactly like `create_invoice` does, since it does create a real invoice. |
| `POST /estimates/{id}/duplicate` | Mirrors `duplicate_invoice`: new DRAFT estimate, fresh number, copied line items |
| `POST /estimates/{id}/email-pdf` | Reuses `invoices.py`'s Playwright-render-to-PDF + Supabase Storage upload + SSRF-guard (`_is_blocked_host`/`_block_private_network_requests`) verbatim — these helpers move to a shared location (see below) so both routers call the same code, not two copies of an SSRF guard |

**Shared-code note:** `compute_totals` currently lives in `invoices.py`; it moves to a new `backend/app/totals.py` (pure calculation, no I/O), imported by both `invoices.py` and `estimates.py`. `_is_blocked_address`, `_is_blocked_host`, and `_block_private_network_requests` (the SSRF guard) plus the shared Playwright-render + Supabase-upload logic move to a new `backend/app/pdf_export.py`, imported the same way by both routers' `email-pdf` endpoints. This avoids either duplicating the SSRF guard (a security-sensitive piece of code that must not drift between two copies) or having `estimates.py` import private-looking helpers out of `invoices.py`.

New Pydantic schemas in `backend/app/schemas.py`: `EstimateIn` (mirrors `InvoiceIn`'s shape: `customer_id`, `issue_date`, `expiry_date`, `line_items: List[LineItemIn]` — reusing the existing `LineItemIn`, `discount_type`, `discount_value`, `notes`, `terms`, `status`).

## Frontend

- `frontend/app/(app)/invoices.tsx` gains a segmented Invoices/Estimates control at the top of the screen. Selecting Estimates swaps the list's data source to `GET /estimates` and reuses the existing row/search/status-pill rendering — the toggle only changes which endpoint backs the list and which "New" action it triggers.
- New `frontend/app/estimates/new.tsx` and `frontend/app/estimates/[id].tsx`, parallel files structured like `frontend/app/invoices/new.tsx`/`[id].tsx` (separate files, not a shared abstraction extracted from the invoice screens — matching this codebase's existing convention of parallel near-duplicate screens over premature sharing, e.g. `customers.tsx`/`vendors.tsx`).
- `frontend/src/components/StatusPill.tsx`'s `status` prop widens from `InvoiceStatus` to `InvoiceStatus | EstimateStatus` (its underlying `statusColors` lookup in `theme.ts` is already `Record<string, ...>`, so no change needed there beyond adding new entries). New `EstimateStatus` type added to `frontend/src/lib/types.ts`: `"DRAFT" | "SENT" | "ACCEPTED" | "DECLINED" | "CONVERTED"`. `DRAFT` and `SENT` already have color entries in `statusColors`; add `ACCEPTED`, `DECLINED`, `CONVERTED`.
- The estimate detail screen (`[id].tsx`) gets the lifecycle action buttons: Send, Accept, Decline, Convert to Invoice, Duplicate, Email PDF — same button-row layout pattern as the invoice detail screen, with buttons conditionally shown/enabled based on the estimate's current status (matching how the invoice detail screen already conditionally shows Send/Void/Mark Paid).
- New `frontend/src/lib/estimatePdf.ts`, structurally identical to `frontend/src/lib/invoicePdf.ts` with "Estimate" branding/copy instead of "Invoice" (including the same mobile-viewport `@media screen` fixes already present in `invoicePdf.ts`).

## Error handling

- Every lifecycle transition (`send`/`accept`/`decline`/`convert`) validates the estimate's current status server-side and returns 400 with a clear message on an invalid transition — mirrors `void_invoice`'s "Cannot void a paid invoice" pattern exactly. The frontend also conditionally hides/disables buttons for invalid transitions, but the backend check is the actual guard.
- `convert` re-runs the same plan-limit check `create_invoice` does (creating an invoice from an estimate still counts against the plan's invoice limit) and returns the same `402 PLAN_LIMIT_REACHED` shape on failure.
- `PATCH`/`DELETE` on a non-DRAFT estimate return 400, not a silent no-op.

## Testing

Backend: `pytest` coverage in `backend/tests/test_backend.py`, following the existing black-box HTTP integration convention (`TEST_`-prefixed data, `auth_client`/`fresh_business` fixtures) — CRUD, business-scoping isolation, the full lifecycle (`DRAFT → SENT → ACCEPTED → CONVERTED`, verifying `converted_invoice_id` points at a real invoice with matching line items and total), the DECLINED path, delete-blocked-once-sent, and convert-blocked-from-DECLINED/CONVERTED.

Frontend/manual: verify against the real backend, following this project's established practice — register a fresh business, create an estimate, send it, accept it, convert it to an invoice, confirm the resulting invoice has the same customer/line items/total, confirm the Invoices/Estimates toggle correctly filters the list, confirm a declined estimate can't be converted.
