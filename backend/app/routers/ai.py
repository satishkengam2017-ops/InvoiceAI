"""AI invoice-extraction route. Anthropic call/prompt unchanged from pre-migration."""
from datetime import datetime, timezone
from typing import Any

from anthropic import AsyncAnthropic
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_business
from app.db import get_db
from app.models import CatalogItem, Customer
from app.schemas import AIExtractIn

router = APIRouter(prefix="/ai", tags=["ai"])

EXTRACTION_TOOL = {
    "name": "draft_invoice",
    "description": "Extract a structured invoice draft from free text.",
    "input_schema": {
        "type": "object",
        "properties": {
            "customer_name": {"type": "string", "description": "Best-match name from known customers, or a new customer name if none match."},
            "customer_is_new": {"type": "boolean", "description": "True if no confident match with existing customer."},
            "line_items": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string"},
                        "description": {"type": "string"},
                        "quantity": {"type": "number"},
                        "unit_price_cents": {"type": "integer", "description": "Unit price in minor units (cents). E.g. $95.00 = 9500."},
                        "tax_percent": {"type": "number"},
                    },
                    "required": ["name", "quantity", "unit_price_cents"],
                },
            },
            "issue_date": {"type": "string", "description": "ISO YYYY-MM-DD. If not stated, use today."},
            "due_date": {"type": "string", "description": "ISO YYYY-MM-DD. If not stated, use today + default_due_days."},
            "notes": {"type": "string"},
            "warnings": {"type": "array", "items": {"type": "string"}, "description": "Ambiguities the human should verify."},
        },
        "required": ["customer_name", "line_items"],
    },
}


@router.post("/extract-invoice")
async def ai_extract_invoice(
    payload: AIExtractIn, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)
):
    biz = ctx["business"]
    api_key = biz.get("anthropic_api_key")
    if not api_key:
        raise HTTPException(status_code=400, detail="Anthropic API key not configured. Add it in Settings.")

    customers = (await db.execute(
        select(Customer).where(Customer.business_id == biz["id"], Customer.archived.is_not(True)).limit(100)
    )).scalars().all()
    catalog = (await db.execute(
        select(CatalogItem).where(CatalogItem.business_id == biz["id"], CatalogItem.archived.is_not(True)).limit(100)
    )).scalars().all()
    known_customers = [{"name": c.name, "email": c.email} for c in customers]
    known_catalog = [{"name": c.name, "unit_price_cents": c.unit_price_cents, "unit": c.unit} for c in catalog]

    today = datetime.now(timezone.utc).date().isoformat()
    system_prompt = (
        f"You extract structured invoice drafts from free text. Today is {today}. "
        f"Business default currency: {biz.get('currency', 'USD')}. "
        f"Default due days: {biz.get('default_due_days', 14)}.\n"
        f"Known customers: {known_customers}\n"
        f"Known catalog items: {known_catalog}\n"
        "Rules:\n"
        "- Match customer to known customers by fuzzy name; if no match, set customer_is_new=true.\n"
        "- Match line items to catalog names when similar; otherwise create free-form items.\n"
        "- Amounts in MINOR UNITS (cents). Never invent prices not stated or in the catalog.\n"
        "- If due date not stated, set issue_date=today and due_date = today + default_due_days.\n"
        "- List ambiguities in warnings[]."
    )

    client_ai = AsyncAnthropic(api_key=api_key)
    try:
        resp = await client_ai.messages.create(
            model="claude-sonnet-4-5",
            max_tokens=2048,
            system=system_prompt,
            tools=[EXTRACTION_TOOL],
            tool_choice={"type": "tool", "name": "draft_invoice"},
            messages=[{"role": "user", "content": payload.text[:4000]}],
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"AI extraction failed: {e}")

    extracted: Any = None
    for block in resp.content:
        if getattr(block, "type", None) == "tool_use":
            extracted = block.input
            break
    if not extracted:
        raise HTTPException(status_code=500, detail="AI returned no structured data")
    return {"draft": extracted}
