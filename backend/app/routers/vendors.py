"""Vendor CRUD routes."""
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_business
from app.db import get_db, to_dict
from app.models import Vendor, new_id
from app.schemas import VendorIn

router = APIRouter(prefix="/vendors", tags=["vendors"])


@router.get("")
async def list_vendors(
    ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db), q: Optional[str] = None
):
    biz_id = ctx["business"]["id"]
    stmt = select(Vendor).where(Vendor.business_id == biz_id, Vendor.archived.is_not(True))
    if q:
        like = f"%{q}%"
        stmt = stmt.where(or_(Vendor.name.ilike(like), Vendor.email.ilike(like)))
    stmt = stmt.order_by(Vendor.name)
    rows = (await db.execute(stmt)).scalars().all()
    return [to_dict(r) for r in rows]


@router.post("")
async def create_vendor(payload: VendorIn, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)):
    biz_id = ctx["business"]["id"]
    vendor = Vendor(id=new_id(), business_id=biz_id, archived=False, **payload.model_dump())
    db.add(vendor)
    await db.commit()
    await db.refresh(vendor)
    return to_dict(vendor)


@router.get("/{vendor_id}")
async def get_vendor(vendor_id: str, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)):
    biz_id = ctx["business"]["id"]
    vendor = (await db.execute(
        select(Vendor).where(Vendor.id == vendor_id, Vendor.business_id == biz_id)
    )).scalar_one_or_none()
    if not vendor:
        raise HTTPException(status_code=404, detail="Vendor not found")
    return to_dict(vendor)


@router.patch("/{vendor_id}")
async def update_vendor(
    vendor_id: str, payload: VendorIn, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)
):
    biz_id = ctx["business"]["id"]
    vendor = (await db.execute(
        select(Vendor).where(Vendor.id == vendor_id, Vendor.business_id == biz_id)
    )).scalar_one_or_none()
    if not vendor:
        raise HTTPException(status_code=404, detail="Vendor not found")
    for key, value in payload.model_dump().items():
        setattr(vendor, key, value)
    vendor.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(vendor)
    return to_dict(vendor)


@router.delete("/{vendor_id}")
async def archive_vendor(vendor_id: str, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)):
    biz_id = ctx["business"]["id"]
    vendor = (await db.execute(
        select(Vendor).where(Vendor.id == vendor_id, Vendor.business_id == biz_id)
    )).scalar_one_or_none()
    if vendor:
        vendor.archived = True
        await db.commit()
    return {"ok": True}
