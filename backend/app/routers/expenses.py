"""Expense CRUD routes."""
import base64
from datetime import date, datetime, timezone
from typing import Optional

from anthropic import AsyncAnthropic
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy import and_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_business
from app.db import get_db, to_dict
from app.models import Expense, ExpenseCategory, new_id
from app.schemas import ExpenseIn

router = APIRouter(prefix="/expenses", tags=["expenses"])

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
