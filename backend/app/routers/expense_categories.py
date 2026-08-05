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
