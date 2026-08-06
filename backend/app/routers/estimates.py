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
