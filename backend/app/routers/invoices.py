"""Invoice routes: CRUD, line items, totals engine, plan-limit-gated
create/duplicate, mark-paid/send/void.
"""
import asyncio
import ipaddress
import os
import socket
from datetime import date, datetime, timedelta, timezone
from typing import List, Optional
from urllib.parse import urlparse

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
from app.totals import compute_totals

router = APIRouter(prefix="/invoices", tags=["invoices"])



def _line_item_dict(li: LineItem) -> dict:
    return {
        "name": li.name,
        "description": li.description,
        "quantity": float(li.quantity),
        "unit_price_cents": li.unit_price_cents,
        "tax_percent": float(li.tax_percent),
    }


async def _serialize_invoice(db: AsyncSession, inv: Invoice, tax_breakdown: Optional[list] = None) -> dict:
    """Attach customer summary and line items to an invoice for list/detail
    views, mirroring the pre-migration dict shape exactly."""
    data = to_dict(inv)
    data["line_items"] = [_line_item_dict(li) for li in sorted(inv.line_items, key=lambda x: x.sort_order)]
    data["tax_breakdown"] = tax_breakdown if tax_breakdown is not None else compute_totals(
        data["line_items"], data["discount_type"], data["discount_value"]
    )["tax_breakdown"]
    cust = (await db.execute(
        select(Customer).where(Customer.id == inv.customer_id, Customer.business_id == inv.business_id)
    )).scalar_one_or_none()
    data["customer"] = to_dict(cust) if cust else None
    return data


async def _get_invoice_with_items(db: AsyncSession, invoice_id: str, business_id: str) -> Optional[Invoice]:
    return (await db.execute(
        select(Invoice)
        .options(selectinload(Invoice.line_items))
        .where(Invoice.id == invoice_id, Invoice.business_id == business_id)
    )).scalar_one_or_none()


@router.get("")
async def list_invoices(
    ctx: dict = Depends(get_business),
    db: AsyncSession = Depends(get_db),
    status_filter: Optional[str] = None,
    q: Optional[str] = None,
):
    biz_id = ctx["business"]["id"]
    stmt = select(Invoice).options(selectinload(Invoice.line_items)).where(Invoice.business_id == biz_id)
    if status_filter and status_filter.upper() != "ALL":
        stmt = stmt.where(Invoice.status == status_filter.upper())
    stmt = stmt.order_by(Invoice.created_at.desc())
    rows = (await db.execute(stmt)).scalars().all()
    results = []
    for inv in rows:
        item = await _serialize_invoice(db, inv)
        if q:
            hay = " ".join([item.get("number") or "", (item.get("customer") or {}).get("name") or ""]).lower()
            if q.lower() not in hay:
                continue
        results.append(item)
    return results


@router.get("/{invoice_id}")
async def get_invoice(invoice_id: str, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)):
    biz_id = ctx["business"]["id"]
    inv = await _get_invoice_with_items(db, invoice_id, biz_id)
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")
    return await _serialize_invoice(db, inv)


@router.post("")
async def create_invoice(payload: InvoiceIn, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)):
    biz = ctx["business"]
    biz_id = biz["id"]

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

    cust = (await db.execute(
        select(Customer).where(Customer.id == payload.customer_id, Customer.business_id == biz_id)
    )).scalar_one_or_none()
    if not cust:
        raise HTTPException(status_code=400, detail="Customer not found for this business")

    # Atomic invoice numbering (equivalent of Mongo's find_one_and_update $inc)
    seq = (await db.execute(
        sql_update(Business)
        .where(Business.id == biz_id)
        .values(next_invoice_no=Business.next_invoice_no + 1)
        .returning(Business.next_invoice_no)
    )).scalar_one() - 1
    prefix = biz.get("invoice_prefix", "INV")
    number = f"{prefix}-{str(seq).zfill(4)}"

    line_item_dicts = [li.model_dump() for li in payload.line_items]
    totals = compute_totals(line_item_dicts, payload.discount_type, payload.discount_value or 0)

    now = datetime.now(timezone.utc)
    issue = date.fromisoformat(payload.issue_date) if payload.issue_date else now.date()
    due = date.fromisoformat(payload.due_date) if payload.due_date else (now + timedelta(days=biz.get("default_due_days", 14))).date()

    invoice = Invoice(
        id=new_id(),
        business_id=biz_id,
        customer_id=payload.customer_id,
        number=number,
        status=(payload.status or "DRAFT").upper(),
        currency=biz.get("currency", "USD"),
        issue_date=issue,
        due_date=due,
        discount_type=payload.discount_type,
        discount_value=payload.discount_value or 0,
        subtotal_cents=totals["subtotal_cents"],
        tax_total_cents=totals["tax_total_cents"],
        discount_cents=totals["discount_cents"],
        total_cents=totals["total_cents"],
        amount_paid_cents=0,
        notes=payload.notes,
        terms=payload.terms or biz.get("default_terms"),
        stripe_payment_url=payload.stripe_payment_url or biz.get("stripe_payment_url_default"),
        ai_source_text=payload.ai_source_text,
    )
    for idx, li in enumerate(line_item_dicts):
        invoice.line_items.append(LineItem(sort_order=idx, **li))
    db.add(invoice)
    await db.commit()
    inv = await _get_invoice_with_items(db, invoice.id, biz_id)
    return await _serialize_invoice(db, inv, totals["tax_breakdown"])


@router.patch("/{invoice_id}")
async def update_invoice(
    invoice_id: str, payload: InvoiceIn, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)
):
    biz_id = ctx["business"]["id"]
    inv = await _get_invoice_with_items(db, invoice_id, biz_id)
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")
    if inv.status != "DRAFT":
        raise HTTPException(status_code=400, detail="Only DRAFT invoices can be edited")

    cust = (await db.execute(
        select(Customer).where(Customer.id == payload.customer_id, Customer.business_id == biz_id)
    )).scalar_one_or_none()
    if not cust:
        raise HTTPException(status_code=400, detail="Customer not found for this business")

    line_item_dicts = [li.model_dump() for li in payload.line_items]
    totals = compute_totals(line_item_dicts, payload.discount_type, payload.discount_value or 0)

    inv.customer_id = payload.customer_id
    inv.discount_type = payload.discount_type
    inv.discount_value = payload.discount_value or 0
    inv.subtotal_cents = totals["subtotal_cents"]
    inv.tax_total_cents = totals["tax_total_cents"]
    inv.discount_cents = totals["discount_cents"]
    inv.total_cents = totals["total_cents"]
    inv.notes = payload.notes
    inv.terms = payload.terms
    inv.stripe_payment_url = payload.stripe_payment_url
    inv.issue_date = date.fromisoformat(payload.issue_date) if payload.issue_date else inv.issue_date
    inv.due_date = date.fromisoformat(payload.due_date) if payload.due_date else inv.due_date
    inv.updated_at = datetime.now(timezone.utc)

    inv.line_items.clear()
    for idx, li in enumerate(line_item_dicts):
        inv.line_items.append(LineItem(sort_order=idx, **li))

    await db.commit()
    inv = await _get_invoice_with_items(db, invoice_id, biz_id)
    return await _serialize_invoice(db, inv, totals["tax_breakdown"])


@router.post("/{invoice_id}/mark-paid")
async def mark_paid(
    invoice_id: str, payload: MarkPaidIn, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)
):
    biz_id = ctx["business"]["id"]
    inv = await _get_invoice_with_items(db, invoice_id, biz_id)
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")

    amount = payload.amount_cents if payload.amount_cents is not None else (inv.total_cents - (inv.amount_paid_cents or 0))
    if amount <= 0:
        raise HTTPException(status_code=400, detail="Amount must be greater than zero")

    new_paid = (inv.amount_paid_cents or 0) + amount
    now = datetime.now(timezone.utc)
    if new_paid >= inv.total_cents:
        inv.status = "PAID"
        inv.paid_at = now
    else:
        inv.status = "PARTIALLY_PAID"

    db.add(Payment(invoice_id=invoice_id, business_id=biz_id, amount_cents=amount, method=payload.method, paid_at=now))
    inv.amount_paid_cents = new_paid
    inv.updated_at = now
    await db.commit()
    inv = await _get_invoice_with_items(db, invoice_id, biz_id)
    return await _serialize_invoice(db, inv)


@router.post("/{invoice_id}/send")
async def mark_sent(invoice_id: str, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)):
    biz_id = ctx["business"]["id"]
    inv = await _get_invoice_with_items(db, invoice_id, biz_id)
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")
    if inv.status == "DRAFT":
        inv.status = "SENT"
        inv.sent_at = datetime.now(timezone.utc)
        inv.updated_at = datetime.now(timezone.utc)
        await db.commit()
        inv = await _get_invoice_with_items(db, invoice_id, biz_id)
    return await _serialize_invoice(db, inv)


@router.post("/{invoice_id}/void")
async def void_invoice(invoice_id: str, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)):
    biz_id = ctx["business"]["id"]
    inv = await _get_invoice_with_items(db, invoice_id, biz_id)
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")
    if inv.status == "PAID":
        raise HTTPException(status_code=400, detail="Cannot void a paid invoice")
    inv.status = "VOID"
    inv.voided_at = datetime.now(timezone.utc)
    inv.updated_at = datetime.now(timezone.utc)
    await db.commit()
    inv = await _get_invoice_with_items(db, invoice_id, biz_id)
    return await _serialize_invoice(db, inv)


@router.post("/{invoice_id}/duplicate")
async def duplicate_invoice(invoice_id: str, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)):
    biz = ctx["business"]
    biz_id = biz["id"]
    inv = await _get_invoice_with_items(db, invoice_id, biz_id)
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")

    plan_status = await check_plan_limit(db, biz_id, biz.get("plan", "FREE"))
    if plan_status["over"]:
        raise HTTPException(status_code=402, detail={"error": "PLAN_LIMIT_REACHED", **plan_status})

    seq = (await db.execute(
        sql_update(Business)
        .where(Business.id == biz_id)
        .values(next_invoice_no=Business.next_invoice_no + 1)
        .returning(Business.next_invoice_no)
    )).scalar_one() - 1
    number = f"{biz.get('invoice_prefix', 'INV')}-{str(seq).zfill(4)}"

    now = datetime.now(timezone.utc)
    new_invoice = Invoice(
        id=new_id(),
        business_id=biz_id,
        customer_id=inv.customer_id,
        number=number,
        status="DRAFT",
        currency=inv.currency,
        issue_date=inv.issue_date,
        due_date=inv.due_date,
        discount_type=inv.discount_type,
        discount_value=inv.discount_value,
        subtotal_cents=inv.subtotal_cents,
        tax_total_cents=inv.tax_total_cents,
        discount_cents=inv.discount_cents,
        total_cents=inv.total_cents,
        amount_paid_cents=0,
        notes=inv.notes,
        terms=inv.terms,
        stripe_payment_url=inv.stripe_payment_url,
        ai_source_text=inv.ai_source_text,
    )
    for li in sorted(inv.line_items, key=lambda x: x.sort_order):
        new_invoice.line_items.append(LineItem(
            sort_order=li.sort_order, name=li.name, description=li.description,
            quantity=li.quantity, unit_price_cents=li.unit_price_cents, tax_percent=li.tax_percent,
        ))
    db.add(new_invoice)
    await db.commit()
    result_inv = await _get_invoice_with_items(db, new_invoice.id, biz_id)
    return await _serialize_invoice(db, result_inv)


def _is_blocked_address(ip_str: str) -> bool:
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        return True  # unparseable -> fail closed
    return ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified


async def _is_blocked_host(hostname: Optional[str]) -> bool:
    """SSRF guard for email_pdf's Chromium instance: this endpoint renders
    client-supplied HTML with network access enabled (needed for
    business.logo_url, the only legitimate external fetch invoiceHtml()
    embeds) - without this, any authenticated business could point an <img>
    at an internal service or cloud metadata endpoint (e.g. 169.254.169.254)
    and have the response rendered straight into the returned PDF."""
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
            await page.route("**/*", _block_private_network_requests)
            await page.set_content(payload.html, wait_until="networkidle")
            pdf_bytes = await page.pdf(format="A4", print_background=True)
        finally:
            await browser.close()

    supabase_url = os.environ["SUPABASE_URL"].rstrip("/")
    service_key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    # inv.id (not inv.number) in the path: invoice numbers are influenced by
    # the tenant-settable, unsanitized Business.invoice_prefix field, so a
    # malicious business could otherwise inject "/" or "../" into a shared
    # public bucket's object path. inv.id is a database-generated UUID with
    # no user-controlled content, so it's safe by construction.
    object_path = f"{biz_id}/{inv.id}.pdf"
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
