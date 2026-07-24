"""Dashboard summary route."""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_business
from app.db import get_db
from app.models import Invoice
from app.routers.business import check_plan_limit

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


@router.get("/summary")
async def dashboard_summary(ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)):
    biz = ctx["business"]
    biz_id = biz["id"]
    now = datetime.now(timezone.utc)
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)

    invoices = (await db.execute(select(Invoice).where(Invoice.business_id == biz_id))).scalars().all()

    revenue_this_month = 0
    outstanding = 0
    overdue = 0
    total_paid = 0
    today = now.date().isoformat()

    for inv in invoices:
        paid = int(inv.amount_paid_cents or 0)
        total = int(inv.total_cents or 0)
        due_amt = total - paid
        if inv.paid_at:
            paid_dt = inv.paid_at if inv.paid_at.tzinfo else inv.paid_at.replace(tzinfo=timezone.utc)
            if paid_dt >= month_start:
                revenue_this_month += paid
        if inv.status in ("SENT", "VIEWED", "PARTIALLY_PAID"):
            outstanding += due_amt
            if inv.due_date and inv.due_date.isoformat() < today:
                overdue += due_amt
        total_paid += paid

    months = []
    for i in range(5, -1, -1):
        m = (month_start.month - i - 1) % 12 + 1
        y = month_start.year + ((month_start.month - i - 1) // 12)
        months.append({"year": y, "month": m, "revenue_cents": 0, "label": datetime(y, m, 1).strftime("%b")})
    for inv in invoices:
        if inv.paid_at:
            d = inv.paid_at
            for mrec in months:
                if d.year == mrec["year"] and d.month == mrec["month"]:
                    mrec["revenue_cents"] += int(inv.amount_paid_cents or 0)
                    break

    plan_status = await check_plan_limit(db, biz_id, biz.get("plan", "FREE"))

    return {
        "currency": biz.get("currency", "USD"),
        "revenue_this_month_cents": revenue_this_month,
        "outstanding_cents": outstanding,
        "overdue_cents": overdue,
        "total_paid_cents": total_paid,
        "invoice_count": len(invoices),
        "chart_months": months,
        "plan": biz.get("plan", "FREE"),
        "plan_usage": plan_status,
    }
