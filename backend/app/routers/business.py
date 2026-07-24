"""Business profile, settings, and subscription plan routes."""
import os
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_business
from app.db import get_db, to_dict
from app.models import Business, Invoice, TaxNumber
from app.schemas import BusinessUpdate, SettingsUpdate

router = APIRouter(tags=["business"])

PLAN_LIMITS = {
    "FREE": {"scope": "lifetime", "limit": 5},
    "STARTER": {"scope": "month", "limit": 10},
    "PRO": {"scope": "month", "limit": 50},
}

PLAN_META = {
    "FREE":    {"label": "Free",    "price_cents": 0,   "price_label": "$0",     "description": "5 invoices lifetime"},
    "STARTER": {"label": "Starter", "price_cents": 100, "price_label": "$1/mo",  "description": "10 invoices per month"},
    "PRO":     {"label": "Pro",     "price_cents": 500, "price_label": "$5/mo",  "description": "50 invoices per month"},
}


def _plan_upgrade_url(plan: str) -> Optional[str]:
    if plan == "STARTER":
        return os.environ.get("STRIPE_STARTER_URL") or None
    if plan == "PRO":
        return os.environ.get("STRIPE_PRO_URL") or None
    return None


async def check_plan_limit(db: AsyncSession, business_id: str, plan: str) -> dict:
    cfg = PLAN_LIMITS.get(plan, PLAN_LIMITS["FREE"])
    if cfg["scope"] == "lifetime":
        used = (await db.execute(
            select(func.count()).select_from(Invoice).where(Invoice.business_id == business_id)
        )).scalar_one()
    else:
        month_start = datetime.now(timezone.utc).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        used = (await db.execute(
            select(func.count()).select_from(Invoice).where(
                Invoice.business_id == business_id, Invoice.created_at >= month_start
            )
        )).scalar_one()
    return {"used": used, "limit": cfg["limit"], "scope": cfg["scope"], "over": used >= cfg["limit"]}


def _hide_anthropic_key(biz: dict) -> dict:
    biz["has_anthropic_key"] = bool(biz.get("anthropic_api_key"))
    biz.pop("anthropic_api_key", None)
    return biz


async def _with_tax_numbers(db: AsyncSession, biz_dict: dict, business_id: str) -> dict:
    rows = (await db.execute(select(TaxNumber).where(TaxNumber.business_id == business_id))).scalars().all()
    biz_dict["tax_numbers"] = [{"label": t.label, "value": t.value} for t in rows]
    return biz_dict


@router.get("/business/me")
async def get_my_business(ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)):
    biz = _hide_anthropic_key(dict(ctx["business"]))
    return await _with_tax_numbers(db, biz, biz["id"])


@router.patch("/business/me")
async def update_my_business(
    payload: BusinessUpdate, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)
):
    biz_id = ctx["business"]["id"]
    update = payload.model_dump(exclude_unset=True)
    # tax_numbers is a child table, not a plain column — handled separately below.
    tax_numbers_update = update.pop("tax_numbers", None)

    if update:
        biz = (await db.execute(select(Business).where(Business.id == biz_id))).scalar_one()
        for key, value in update.items():
            setattr(biz, key, value)
        biz.updated_at = datetime.now(timezone.utc)
        await db.commit()
    else:
        biz = (await db.execute(select(Business).where(Business.id == biz_id))).scalar_one()

    if tax_numbers_update is not None:
        await db.execute(delete(TaxNumber).where(TaxNumber.business_id == biz_id))
        for tn in tax_numbers_update:
            db.add(TaxNumber(business_id=biz_id, label=tn.get("label"), value=tn.get("value")))
        await db.commit()

    await db.refresh(biz)
    result = _hide_anthropic_key(to_dict(biz))
    return await _with_tax_numbers(db, result, biz_id)


@router.patch("/settings")
async def update_settings(
    payload: SettingsUpdate, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)
):
    biz_id = ctx["business"]["id"]
    update = {k: v for k, v in payload.model_dump(exclude_unset=True).items() if v is not None}
    if "plan" in update and update["plan"] not in PLAN_LIMITS:
        raise HTTPException(status_code=400, detail="Invalid plan")
    biz = (await db.execute(select(Business).where(Business.id == biz_id))).scalar_one()
    if update:
        for key, value in update.items():
            setattr(biz, key, value)
        biz.updated_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(biz)
    result = _hide_anthropic_key(to_dict(biz))
    return await _with_tax_numbers(db, result, biz_id)


@router.get("/plans")
async def list_plans(ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)):
    biz = ctx["business"]
    current = biz.get("plan", "FREE")
    plans = []
    for key, meta in PLAN_META.items():
        plans.append({
            "key": key,
            **meta,
            "limit": PLAN_LIMITS[key]["limit"],
            "scope": PLAN_LIMITS[key]["scope"],
            "is_current": key == current,
            "upgrade_url": _plan_upgrade_url(key),
        })
    return {
        "current": current,
        "plans": plans,
        "usage": await check_plan_limit(db, biz["id"], current),
    }
