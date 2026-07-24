"""Catalog item CRUD routes."""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_business
from app.db import get_db, to_dict
from app.models import CatalogItem, new_id
from app.schemas import CatalogItemIn

router = APIRouter(prefix="/catalog", tags=["catalog"])


@router.get("")
async def list_catalog(ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)):
    biz_id = ctx["business"]["id"]
    rows = (await db.execute(
        select(CatalogItem)
        .where(CatalogItem.business_id == biz_id, CatalogItem.archived.is_not(True))
        .order_by(CatalogItem.name)
    )).scalars().all()
    return [to_dict(r) for r in rows]


@router.post("")
async def create_catalog_item(
    payload: CatalogItemIn, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)
):
    biz = ctx["business"]
    data = payload.model_dump()
    data["currency"] = data.get("currency") or biz.get("currency", "USD")
    item = CatalogItem(id=new_id(), business_id=biz["id"], archived=False, **data)
    db.add(item)
    await db.commit()
    await db.refresh(item)
    return to_dict(item)


@router.patch("/{item_id}")
async def update_catalog_item(
    item_id: str, payload: CatalogItemIn, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)
):
    biz_id = ctx["business"]["id"]
    item = (await db.execute(
        select(CatalogItem).where(CatalogItem.id == item_id, CatalogItem.business_id == biz_id)
    )).scalar_one_or_none()
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    for key, value in payload.model_dump().items():
        setattr(item, key, value)
    item.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(item)
    return to_dict(item)


@router.delete("/{item_id}")
async def delete_catalog_item(item_id: str, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)):
    biz_id = ctx["business"]["id"]
    item = (await db.execute(
        select(CatalogItem).where(CatalogItem.id == item_id, CatalogItem.business_id == biz_id)
    )).scalar_one_or_none()
    if item:
        item.archived = True
        await db.commit()
    return {"ok": True}
