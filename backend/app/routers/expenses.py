"""Expense CRUD routes."""
from datetime import date, datetime, timezone
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
        conditions.append(Expense.date >= date.fromisoformat(from_date))
    if to_date:
        conditions.append(Expense.date <= date.fromisoformat(to_date))
    stmt = select(Expense).where(and_(*conditions)).order_by(Expense.date.desc())
    rows = (await db.execute(stmt)).scalars().all()
    return [to_dict(r) for r in rows]


@router.post("")
async def create_expense(payload: ExpenseIn, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)):
    biz = ctx["business"]
    data = payload.model_dump()
    data["currency"] = data.get("currency") or biz.get("currency", "USD")
    data["date"] = date.fromisoformat(data["date"])
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
    data = payload.model_dump()
    data["currency"] = data.get("currency") or expense.currency
    data["date"] = date.fromisoformat(data["date"])
    for key, value in data.items():
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
