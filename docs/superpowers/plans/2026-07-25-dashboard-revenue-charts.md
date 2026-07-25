# Dashboard Revenue Charts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dashboard's "Revenue (6 months)" chart with two new charts: daily revenue for the most recently completed calendar month, and full-year (Jan–Dec) revenue with the current month highlighted.

**Architecture:** `GET /dashboard/summary` drops `chart_months` and adds `chart_days`/`chart_year`, computed with the same Python-side aggregation over the already-fetched `invoices` list the route already uses. The frontend replaces one chart `Card` with two, reusing the existing hand-rolled bar-chart style objects.

**Tech Stack:** FastAPI, Python's `datetime`/`timedelta` (stdlib only, no new dependency), React Native (Expo), `StyleSheet` (no charting library).

## Global Constraints

- `chart_days` = daily revenue for the most recently **completed** calendar month (not the current month's partial data).
- `chart_year` = 12 fixed calendar months of the **current** year (January–December), not a rolling window. Months after the current one show `revenue_cents: 0`.
- Revenue aggregation rule for both: sum of `amount_paid_cents` for invoices whose `paid_at` falls in the bucket — identical rule to what the removed `chart_months` used.
- No new frontend dependency — both charts are hand-rolled `View`/`Text`, reusing `chartRow`/`chartCol`/`barTrack`/`bar` from `dashboard.tsx`'s existing `StyleSheet`.
- `chart_months` is removed from the backend response and the frontend `DashboardSummary` type entirely — nothing else in the codebase reads it.

---

### Task 1: Backend — replace `chart_months` with `chart_days` and `chart_year`

**Files:**
- Modify: `backend/app/routers/dashboard.py`

**Interfaces:**
- Consumes: nothing new — same `Invoice` model, same `get_business`/`get_db` dependencies already imported in this file.
- Produces: `GET /dashboard/summary` response gains `chart_days: {range_label: str, total_cents: int, days: [{day: int, revenue_cents: int}]}` and `chart_year: {range_label: str, total_cents: int, current_month: int, months: [{year: int, month: int, revenue_cents: int, label: str}]}`; loses `chart_months`. Consumed by Task 3 (frontend).

- [ ] **Step 1: Replace the file**

Replace the full contents of `backend/app/routers/dashboard.py` with:

```python
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
```

- [ ] **Step 2: Static verification**

```bash
cd backend
.venv\Scripts\python.exe -c "from app.routers.dashboard import router; print([r.path for r in router.routes])"
```

Expected: `['/dashboard/summary']` (unchanged from before).

- [ ] **Step 3: Live verification**

Load env vars from `backend/.env` (`set -a && source .env && set +a` in git-bash, never print/echo secrets). Build a throwaway script (do not commit it) that:

1. Registers a fresh business + customer, confirms `GET /dashboard/summary` on zero invoices returns `chart_days.total_cents == 0`, `chart_days.days` has the correct number of entries for last month (compute expected day count yourself from the real current date, e.g. via Python's own `calendar.monthrange`), and `chart_year.total_cents == 0` with exactly 12 `months` entries.
2. Creates an invoice, marks it paid via `POST /invoices/{id}/mark-paid` (this sets `paid_at` to now, i.e. the current month) — confirms `chart_year.months[current_month - 1].revenue_cents` now reflects that payment, and `chart_days` is unaffected (since the payment is in the current month, not last month).
3. Directly manipulate the DB (via `SessionLocal`) to backdate one invoice's `paid_at` to a specific day in the previous calendar month, re-fetch `GET /dashboard/summary`, confirm `chart_days.days[<that day - 1>].revenue_cents` reflects it correctly.
4. Confirm the response no longer has a `chart_months` key at all.
5. Clean up test rows at the end of the same script run.

- [ ] **Step 4: Commit**

```bash
git add backend/app/routers/dashboard.py
git commit -m "Replace chart_months with chart_days and chart_year in dashboard summary"
```

---

### Task 2: Frontend — update the `DashboardSummary` type

**Files:**
- Modify: `frontend/src/lib/types.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: updated `DashboardSummary` type, consumed by Task 3.

- [ ] **Step 1: Update the type**

Find this in `frontend/src/lib/types.ts`:

```typescript
export type DashboardSummary = {
  currency: string;
  revenue_this_month_cents: number;
  outstanding_cents: number;
  overdue_cents: number;
  total_paid_cents: number;
  invoice_count: number;
  chart_months: { year: number; month: number; revenue_cents: number; label: string }[];
  plan: Plan;
  plan_usage: { used: number; limit: number; scope: string; over: boolean };
};
```

Replace the `chart_months` line with:

```typescript
export type DashboardSummary = {
  currency: string;
  revenue_this_month_cents: number;
  outstanding_cents: number;
  overdue_cents: number;
  total_paid_cents: number;
  invoice_count: number;
  chart_days: { range_label: string; total_cents: number; days: { day: number; revenue_cents: number }[] };
  chart_year: {
    range_label: string;
    total_cents: number;
    current_month: number;
    months: { year: number; month: number; revenue_cents: number; label: string }[];
  };
  plan: Plan;
  plan_usage: { used: number; limit: number; scope: string; over: boolean };
};
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/lib/types.ts
git commit -m "Update DashboardSummary type: chart_months -> chart_days/chart_year"
```

---

### Task 3: Frontend — replace the chart card with two new ones

**Files:**
- Modify: `frontend/app/(app)/dashboard.tsx`

**Interfaces:**
- Consumes: `summary.chart_days`/`summary.chart_year` (Tasks 1–2).
- Produces: nothing consumed by other tasks — this is the last task in the plan.

- [ ] **Step 1: Replace the `maxBar` line**

Find:

```typescript
  const maxBar = Math.max(1, ...(summary?.chart_months || []).map((m) => m.revenue_cents));
```

Replace with two separate max values, one per chart:

```typescript
  const maxDayBar = Math.max(1, ...(summary?.chart_days?.days || []).map((d) => d.revenue_cents));
  const maxMonthBar = Math.max(1, ...(summary?.chart_year?.months || []).map((m) => m.revenue_cents));
```

- [ ] **Step 2: Replace the chart Card**

Find this entire block:

```typescript
            {/* Chart */}
            <Card testID="dashboard-chart-card" style={{ marginTop: spacing.md }}>
              <Text style={styles.sectionTitle}>Revenue (6 months)</Text>
              <View style={styles.chartRow}>
                {(summary?.chart_months || []).map((m) => (
                  <View key={`${m.year}-${m.month}`} style={styles.chartCol}>
                    <View style={styles.barTrack}>
                      <View style={[styles.bar, { height: `${(m.revenue_cents / maxBar) * 100}%` }]} />
                    </View>
                    <Text style={styles.barLabel}>{m.label}</Text>
                  </View>
                ))}
              </View>
            </Card>
```

Replace it with two cards:

```typescript
            {/* Revenue (Last Month) */}
            <Card testID="dashboard-chart-days-card" style={{ marginTop: spacing.md }}>
              <View style={styles.chartHeader}>
                <Text style={styles.sectionTitle}>Revenue (Last Month)</Text>
                <View style={styles.rangeBadge}>
                  <Feather name="calendar" size={12} color={colors.muted} />
                  <Text style={styles.rangeBadgeText}>{summary?.chart_days?.range_label}</Text>
                </View>
              </View>
              <Text style={styles.chartTotal}>{formatMoney(summary?.chart_days?.total_cents || 0, currency)}</Text>
              <Text style={styles.chartTotalLabel}>Total Revenue</Text>
              <View style={[styles.chartRow, { marginTop: spacing.lg }]}>
                {(summary?.chart_days?.days || []).map((d) => (
                  <View key={d.day} style={styles.chartCol}>
                    <View style={styles.barTrack}>
                      <View style={[styles.bar, { height: `${(d.revenue_cents / maxDayBar) * 100}%` }]} />
                    </View>
                    {d.day === 1 || d.day % 5 === 0 ? <Text style={styles.barLabel}>{d.day}</Text> : null}
                  </View>
                ))}
              </View>
            </Card>

            {/* Revenue (Jan - Dec) */}
            <Card testID="dashboard-chart-year-card" style={{ marginTop: spacing.md }}>
              <View style={styles.chartHeader}>
                <Text style={styles.sectionTitle}>Revenue (Jan - Dec)</Text>
                <View style={styles.rangeBadge}>
                  <Feather name="calendar" size={12} color={colors.muted} />
                  <Text style={styles.rangeBadgeText}>{summary?.chart_year?.range_label}</Text>
                </View>
              </View>
              <Text style={styles.chartTotal}>{formatMoney(summary?.chart_year?.total_cents || 0, currency)}</Text>
              <Text style={styles.chartTotalLabel}>Total Revenue (Year to Date)</Text>
              <View style={[styles.chartRow, { marginTop: spacing.lg }]}>
                {(summary?.chart_year?.months || []).map((m) => {
                  const isCurrent = m.month === summary?.chart_year?.current_month;
                  return (
                    <View key={`${m.year}-${m.month}`} style={styles.chartCol}>
                      <View style={styles.barTrack}>
                        <View
                          style={[
                            styles.bar,
                            { height: `${(m.revenue_cents / maxMonthBar) * 100}%` },
                            isCurrent ? styles.barCurrent : null,
                          ]}
                        />
                      </View>
                      <Text style={styles.barLabel}>{m.label}</Text>
                    </View>
                  );
                })}
              </View>
              <View style={styles.legendRow}>
                <View style={styles.legendItem}>
                  <View style={[styles.legendSwatch, { backgroundColor: colors.brand }]} />
                  <Text style={styles.legendText}>Current Month</Text>
                </View>
                <View style={styles.legendItem}>
                  <View style={[styles.legendSwatch, { backgroundColor: colors.brandSecondary }]} />
                  <Text style={styles.legendText}>Other Months</Text>
                </View>
              </View>
            </Card>
```

- [ ] **Step 3: Update the default bar color and add the new styles**

Find:

```typescript
  bar: { width: "100%", backgroundColor: colors.brand, borderRadius: radius.sm, minHeight: 2 },
```

Replace with (default bars now use the lighter secondary color, since `colors.brand` is reserved for the yearly chart's current-month highlight):

```typescript
  bar: { width: "100%", backgroundColor: colors.brandSecondary, borderRadius: radius.sm, minHeight: 2 },
  barCurrent: { backgroundColor: colors.brand },
```

Then find:

```typescript
  barLabel: { fontSize: 11, color: colors.muted, marginTop: 6 },
```

Add the new style objects immediately after it:

```typescript
  barLabel: { fontSize: 11, color: colors.muted, marginTop: 6 },
  chartHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  rangeBadge: { flexDirection: "row", alignItems: "center", gap: 4 },
  rangeBadgeText: { fontSize: 11, color: colors.muted },
  chartTotal: { fontSize: 28, fontWeight: "600", color: colors.onSurface, marginTop: spacing.sm, letterSpacing: -0.5 },
  chartTotalLabel: { fontSize: typography.sm, color: colors.muted, marginTop: 2 },
  legendRow: { flexDirection: "row", gap: spacing.lg, marginTop: spacing.md, justifyContent: "center" },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 6 },
  legendSwatch: { width: 10, height: 10, borderRadius: 2 },
  legendText: { fontSize: 12, color: colors.muted },
```

- [ ] **Step 4: Typecheck**

```bash
cd frontend
npx tsc --noEmit
```

Expected: no errors referencing `frontend/app/(app)/dashboard.tsx` or `frontend/src/lib/types.ts`.

- [ ] **Step 5: Manual verification — web**

Start the web app against a backend running Task 1's updated route. Sign in, go to Dashboard, confirm:
1. "Revenue (6 months)" is gone; two new cards appear in its place: "Revenue (Last Month)" and "Revenue (Jan - Dec)".
2. Each shows a date-range badge with a calendar icon, a large total number, and a bar chart.
3. The daily chart shows day labels only at 1, 5, 10, 15, 20, 25, 30 (not every day).
4. The yearly chart's current month bar is visibly a different (darker) color than the others, with a legend below matching those two colors.
5. On a business with zero invoices, both charts render with empty/flat bars rather than crashing (confirms the `Math.max(1, ...)` guard works the same way it did before).

- [ ] **Step 6: Commit**

```bash
git add "frontend/app/(app)/dashboard.tsx"
git commit -m "Replace 6-month dashboard chart with daily-last-month and full-year charts"
```
