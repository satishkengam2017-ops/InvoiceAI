# Send Email Hosted-PDF Revision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the web branch of `sendEmail` (currently: open a printable tab + `mailto:` with no attachment) with a backend-generated, Supabase-Storage-hosted PDF link included directly in the `mailto:` body.

**Architecture:** New FastAPI route on the existing `invoices` router renders client-supplied HTML to a PDF using Playwright's headless Chromium and uploads it to a public Supabase Storage bucket via its REST API, returning a public URL. The frontend's web branch calls this route instead of opening a printable tab, then includes the returned URL in the `mailto:` body.

**Tech Stack:** FastAPI, `playwright` (new), `httpx` (new), Supabase Storage REST API, React Native Web, `Linking.openURL`.

**Revision note:** this plan originally specified `weasyprint` for PDF rendering. A live implementation attempt (Task 3) hit a real, unavoidable blocker: WeasyPrint requires the GTK3 runtime, absent on the Windows dev machine and not pip-installable — confirmed via `OSError: cannot load library 'pango-1.0-0'`, not a hypothetical. Task 3 below has been rewritten to use Playwright's headless Chromium instead, which installs cleanly on Windows via pip + a binary download (no system library linking). See the design spec's second revision note for full detail.

## Global Constraints

- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are already present in `backend/.env` (added by the user) — read via `os.environ`, never logged or echoed.
- Storage path: `{business_id}/{invoice.number}.pdf` (per docs/superpowers/specs/2026-07-24-send-email-invoice-design.md's Revision note) — overwrite on re-send is intended behavior.
- The new route must use the exact same auth/tenant-scoping pattern as every other route in `backend/app/routers/invoices.py`: `Depends(get_business)` + `_get_invoice_with_items(db, invoice_id, biz_id)`, 404 if not found/not owned.
- Native platform behavior is unchanged — do not touch the `else` (native) branch of `sendEmail`.
- "Download PDF" and "Record Payment" are untouched.

---

### Task 3: Backend `POST /invoices/{invoice_id}/email-pdf` endpoint

**Files:**
- Modify: `backend/requirements.txt` (add `playwright`, `httpx`)
- Modify: `backend/app/schemas.py` (add `EmailPdfIn`)
- Modify: `backend/app/routers/invoices.py` (add the route)

**Interfaces:**
- Consumes: `get_business` (`app.auth`), `get_db` (`app.db`), `_get_invoice_with_items` (already defined earlier in `invoices.py`) — no new imports needed for these, they're already imported in this file.
- Produces: `POST /invoices/{invoice_id}/email-pdf` — request `{"html": str}`, response `{"url": str}`. This is the last task that touches the backend; nothing later depends on new backend exports beyond this route existing.

- [ ] **Step 1: Add dependencies**

Append to `backend/requirements.txt`:

```
playwright==1.49.1
httpx==0.28.1
```

Run, from `backend/`:

```bash
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe -m playwright install chromium
```

If this is a fresh worktree without a `.venv` yet, create one first:

```bash
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe -m playwright install chromium
```

Expected: `pip install` succeeds, then `playwright install chromium` downloads the Chromium browser binary (a few hundred MB — this step needs internet access and can take a couple of minutes; it does not require any system-level package manager or admin rights on Windows).

- [ ] **Step 2: Add the `EmailPdfIn` schema**

In `backend/app/schemas.py`, add this class right after `MarkPaidIn` (before `ClerkExchangeIn`):

```python
class EmailPdfIn(BaseModel):
    html: str
```

- [ ] **Step 3: Add the route**

In `backend/app/routers/invoices.py`, add these imports to the top of the file, alongside the existing imports:

```python
import os

import httpx
from playwright.async_api import async_playwright
```

(Full updated import block for reference — only the three lines above are new, everything else already exists:)

```python
"""Invoice routes: CRUD, line items, totals engine, plan-limit-gated
create/duplicate, mark-paid/send/void.
"""
import os
from datetime import date, datetime, timedelta, timezone
from typing import List, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from playwright.async_api import async_playwright
from sqlalchemy import select, update as sql_update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.auth import get_business
from app.db import get_db, to_dict
from app.models import Business, Customer, Invoice, LineItem, Payment, new_id
from app.routers.business import check_plan_limit
from app.schemas import EmailPdfIn, InvoiceIn, MarkPaidIn
```

Then add this route at the end of the file (after `duplicate_invoice`):

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
        browser = await p.chromium.launch()
        try:
            page = await browser.new_page()
            await page.set_content(payload.html, wait_until="networkidle")
            pdf_bytes = await page.pdf(format="A4", print_background=True)
        finally:
            await browser.close()

    supabase_url = os.environ["SUPABASE_URL"].rstrip("/")
    service_key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    object_path = f"{biz_id}/{inv.number}.pdf"
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
        raise HTTPException(status_code=502, detail="Failed to upload invoice PDF")

    public_url = f"{supabase_url}/storage/v1/object/public/InvoiceAI/{object_path}"
    return {"url": public_url}
```

Note: launching a fresh browser per request (rather than keeping one alive across requests via `app/main.py`'s startup/shutdown lifecycle) is a deliberate simplicity choice — this endpoint is called only when a user clicks "Send Email" (low volume), not on a hot path, so the few-hundred-ms launch cost per call isn't worth the added complexity of managing shared browser-process lifecycle state. Do not "optimize" this into a shared instance as part of this task.

- [ ] **Step 4: Static verification**

```bash
cd backend
.venv\Scripts\python.exe -c "from app.routers.invoices import router; print([r.path for r in router.routes if 'email-pdf' in r.path])"
```

Expected: `['/invoices/{invoice_id}/email-pdf']`.

- [ ] **Step 5: Live verification**

Load env vars from `backend/.env` (`set -a && source .env && set +a` in git-bash) — never print/echo the file's contents or any secret value. Build a throwaway script (do not commit it) that:

1. Mounts a minimal `FastAPI()` app with `app.routers.auth.router` + `app.routers.business.router` + `app.routers.customers.router` + `app.routers.invoices.router`.
2. Registers a fresh business + customer, creates an invoice.
3. `POST /invoices/{id}/email-pdf` with a small HTML string, e.g. `{"html": "<html><body><h1>Test Invoice</h1></body></html>"}` — confirm `200` and a `url` field starting with the `SUPABASE_URL` value.
4. Fetch that URL directly (a plain `GET`, no auth header) and confirm it returns `200` with `Content-Type: application/pdf` and a non-empty body starting with `%PDF` (the standard PDF file magic bytes).
5. Confirm tenant scoping: register a second business, confirm its token gets `404` when it tries `POST /invoices/{first business's invoice id}/email-pdf`.
6. Clean up test rows (both businesses/users/customers/invoices) at the end of the same script run. The uploaded test PDF objects in Supabase Storage are harmless to leave (tiny test files, non-sensitive placeholder content) — no cleanup needed for those.

- [ ] **Step 6: Commit**

```bash
git add backend/requirements.txt backend/app/schemas.py backend/app/routers/invoices.py
git commit -m "Add POST /invoices/{id}/email-pdf: render HTML to PDF and host on Supabase Storage"
```

---

### Task 4: Update frontend `sendEmail` to use the hosted-PDF link

**Files:**
- Modify: `frontend/app/invoices/[id].tsx`

**Interfaces:**
- Consumes: `POST /invoices/{id}/email-pdf` (Task 3) via the existing `api.post<{url: string}>(path, data)` client (`@/src/lib/api`, already imported in this file as `api`).
- Produces: nothing consumed by other tasks — this is the last task in the plan.

- [ ] **Step 1: Replace the web branch of `sendEmail`**

Find the current `sendEmail` function (added in the prior Send Email plan) — its web branch currently reads:

```typescript
      if (Platform.OS === "web") {
        // mailto: links cannot carry attachments (a hard browser limitation),
        // so also open the print-ready invoice in a separate tab so the user
        // can save it as a PDF and attach it themselves in the mail client
        // that's about to open.
        openHtmlInNewTab(invoiceHtml(invoice, business as Business), true);
        const params = new URLSearchParams({ subject, body });
        await Linking.openURL(`mailto:${recipientEmail ?? ""}?${params.toString()}`);
      } else {
```

Replace just that `if` block (leave the `else` native branch untouched) with:

```typescript
      if (Platform.OS === "web") {
        // mailto: links cannot carry attachments (a hard browser limitation),
        // so the backend renders the invoice to a PDF, hosts it on Supabase
        // Storage, and we link to it in the email body instead.
        const { url } = await api.post<{ url: string }>(`/invoices/${invoice.id}/email-pdf`, {
          html: invoiceHtml(invoice, business as Business),
        });
        const linkedBody = `${body} Download your invoice here: ${url}`;
        const params = new URLSearchParams({ subject, body: linkedBody });
        await Linking.openURL(`mailto:${recipientEmail ?? ""}?${params.toString()}`);
      } else {
```

- [ ] **Step 2: Remove the now-unused `openHtmlInNewTab` call site check**

`openHtmlInNewTab` is still used by `downloadPdf` elsewhere in this same file — do NOT remove the function itself or its other call site. This step is just confirming: after Step 1's edit, `sendEmail` no longer calls `openHtmlInNewTab` anywhere. Run:

```bash
cd frontend
grep -n "openHtmlInNewTab" app/invoices/\[id\].tsx
```

Expected: exactly one match, inside `downloadPdf` (not inside `sendEmail`).

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors referencing `frontend/app/invoices/[id].tsx`.

- [ ] **Step 4: Manual verification — web**

Start the web app (or reuse a running dev server pointed at this worktree), sign in, open a non-VOID invoice with a customer that has an email on file.

1. Click **Send Email**. Confirm: no new tab opens (unlike before), no print dialog appears, and the mail client opens with a body that includes a real `https://...supabase.co/storage/v1/object/public/InvoiceAI/...` URL.
2. Open that URL directly in a new browser tab — confirm it downloads/displays a real PDF matching the invoice (correct invoice number, line items, total).
3. If the invoice was DRAFT, confirm it's now SENT after the flow completes.
4. If the backend call fails (e.g., temporarily comment out `SUPABASE_URL` in `.env` and restart the server to simulate a failure, then restore it), confirm the "Send failed" alert appears and no `mailto:` window ever opens.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/invoices/\[id\].tsx
git commit -m "Send Email (web): link to a backend-hosted PDF instead of mailto+print-tab"
```

---

## Post-implementation note

This plan builds on top of the already-completed, already-committed Tasks 1-2 from `docs/superpowers/plans/2026-07-24-send-email-invoice.md` (the `expo-mail-composer` dependency and the initial `sendEmail` implementation). Native behavior, "Download PDF", and "Record Payment" remain unchanged throughout.
