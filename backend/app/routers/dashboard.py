"""Dashboard summary route."""
from datetime import datetime, timedelta, timezone

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

    # chart_days: daily revenue for the most recently COMPLETED calendar
    # month (not the current month's partial data).
    last_month_end = month_start - timedelta(days=1)
    last_month_start = last_month_end.replace(day=1)
    days_in_last_month = last_month_end.day
    chart_days = [{"day": d, "revenue_cents": 0} for d in range(1, days_in_last_month + 1)]
    for inv in invoices:
        if inv.paid_at:
            paid_dt = inv.paid_at if inv.paid_at.tzinfo else inv.paid_at.replace(tzinfo=timezone.utc)
            if paid_dt.year == last_month_start.year and paid_dt.month == last_month_start.month:
                chart_days[paid_dt.day - 1]["revenue_cents"] += int(inv.amount_paid_cents or 0)
    chart_days_range_label = (
        f"{last_month_start.strftime('%b')} 1 – "
        f"{last_month_end.strftime('%b')} {days_in_last_month}, {last_month_end.year}"
    )

    # chart_year: 12 fixed calendar months of the CURRENT year (not a
    # rolling window) - months after the current one stay at 0.
    chart_year_months = []
    for m in range(1, 13):
        chart_year_months.append(
            {"year": now.year, "month": m, "revenue_cents": 0, "label": datetime(now.year, m, 1).strftime("%b")}
        )
    for inv in invoices:
        if inv.paid_at:
            paid_dt = inv.paid_at if inv.paid_at.tzinfo else inv.paid_at.replace(tzinfo=timezone.utc)
            if paid_dt.year == now.year:
                chart_year_months[paid_dt.month - 1]["revenue_cents"] += int(inv.amount_paid_cents or 0)
    chart_year_range_label = f"Jan 1 – Dec 31, {now.year}"

    plan_status = await check_plan_limit(db, biz_id, biz.get("plan", "FREE"))

    return {
        "currency": biz.get("currency", "USD"),
        "revenue_this_month_cents": revenue_this_month,
        "outstanding_cents": outstanding,
        "overdue_cents": overdue,
        "total_paid_cents": total_paid,
        "invoice_count": len(invoices),
        "chart_days": {
            "range_label": chart_days_range_label,
            "total_cents": sum(d["revenue_cents"] for d in chart_days),
            "days": chart_days,
        },
        "chart_year": {
            "range_label": chart_year_range_label,
            "total_cents": sum(m["revenue_cents"] for m in chart_year_months),
            "current_month": now.month,
            "months": chart_year_months,
        },
        "plan": biz.get("plan", "FREE"),
        "plan_usage": plan_status,
    }
