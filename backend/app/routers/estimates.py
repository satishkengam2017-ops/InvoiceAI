"""Estimate routes: CRUD, line items, and lifecycle actions (send/accept/
decline/convert/duplicate/email-pdf, added in later tasks). Reuses the
invoice engine's totals math (app.totals) and PDF/SSRF infrastructure
(app.pdf_export) rather than duplicating either.
"""
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, update as sql_update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.auth import get_business
from app.db import get_db, to_dict
from app.models import Business, Customer, Estimate, EstimateLineItem, Invoice, LineItem, new_id
from app.pdf_export import render_and_upload_pdf
from app.routers.business import check_plan_limit
from app.routers.invoices import _get_invoice_with_items, _serialize_invoice
from app.schemas import EmailPdfIn, EstimateIn
from app.totals import compute_totals

router = APIRouter(prefix="/estimates", tags=["estimates"])


def _parse_estimate_date(raw: str) -> date:
    try:
        return date.fromisoformat(raw)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format, expected YYYY-MM-DD")


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
    issue = _parse_estimate_date(payload.issue_date) if payload.issue_date else now.date()
    expiry = _parse_estimate_date(payload.expiry_date) if payload.expiry_date else None

    estimate = Estimate(
        id=new_id(),
        business_id=biz_id,
        customer_id=payload.customer_id,
        number=number,
        status="DRAFT",
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
    est.issue_date = _parse_estimate_date(payload.issue_date) if payload.issue_date else est.issue_date
    est.expiry_date = _parse_estimate_date(payload.expiry_date) if payload.expiry_date else est.expiry_date
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
    # Flush the new invoice row now so its INSERT is issued before the
    # estimate's UPDATE below. Without this, SQLAlchemy's flush ordering has
    # no relationship() linking Estimate<->Invoice to infer the dependency
    # from, and can emit the estimates UPDATE (which sets
    # converted_invoice_id) before the invoices INSERT it references,
    # tripping the estimates_converted_invoice_id_fkey constraint. flush()
    # does not commit, so this stays in the same transaction as the single
    # db.commit() below.
    await db.flush()

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
