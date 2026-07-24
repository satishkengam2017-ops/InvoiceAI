"""Customer CRUD routes."""
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_business
from app.db import get_db, to_dict
from app.models import Customer, Invoice
from app.models import new_id
from app.schemas import CustomerIn

router = APIRouter(prefix="/customers", tags=["customers"])


@router.get("")
async def list_customers(
    ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db), q: Optional[str] = None
):
    biz_id = ctx["business"]["id"]
    stmt = select(Customer).where(Customer.business_id == biz_id, Customer.archived.is_not(True))
    if q:
        like = f"%{q}%"
        stmt = stmt.where(or_(Customer.name.ilike(like), Customer.email.ilike(like), Customer.company.ilike(like)))
    stmt = stmt.order_by(Customer.name)
    rows = (await db.execute(stmt)).scalars().all()
    return [to_dict(r) for r in rows]


@router.post("")
async def create_customer(payload: CustomerIn, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)):
    biz_id = ctx["business"]["id"]
    customer = Customer(id=new_id(), business_id=biz_id, archived=False, **payload.model_dump())
    db.add(customer)
    await db.commit()
    await db.refresh(customer)
    return to_dict(customer)


@router.get("/{customer_id}")
async def get_customer(customer_id: str, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)):
    biz_id = ctx["business"]["id"]
    customer = (await db.execute(
        select(Customer).where(Customer.id == customer_id, Customer.business_id == biz_id)
    )).scalar_one_or_none()
    if not customer:
        raise HTTPException(status_code=404, detail="Customer not found")
    result = to_dict(customer)
    invs = (await db.execute(
        select(Invoice).where(Invoice.business_id == biz_id, Invoice.customer_id == customer_id)
    )).scalars().all()
    result["invoices"] = [to_dict(i) for i in invs]
    result["lifetime_revenue_cents"] = sum(int(i.amount_paid_cents or 0) for i in invs)
    return result


@router.patch("/{customer_id}")
async def update_customer(
    customer_id: str, payload: CustomerIn, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)
):
    biz_id = ctx["business"]["id"]
    customer = (await db.execute(
        select(Customer).where(Customer.id == customer_id, Customer.business_id == biz_id)
    )).scalar_one_or_none()
    if not customer:
        raise HTTPException(status_code=404, detail="Customer not found")
    for key, value in payload.model_dump().items():
        setattr(customer, key, value)
    customer.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(customer)
    return to_dict(customer)


@router.delete("/{customer_id}")
async def archive_customer(customer_id: str, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)):
    biz_id = ctx["business"]["id"]
    customer = (await db.execute(
        select(Customer).where(Customer.id == customer_id, Customer.business_id == biz_id)
    )).scalar_one_or_none()
    if customer:
        customer.archived = True
        await db.commit()
    return {"ok": True}
