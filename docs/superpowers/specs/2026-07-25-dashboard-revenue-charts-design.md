# Design: Daily-last-month and full-year revenue charts on the dashboard

## Problem

The dashboard's "Revenue (6 months)" chart (a hand-rolled bar chart, `frontend/app/(app)/dashboard.tsx`) is being replaced by two new charts matching a reference design: a daily bar chart for the most recently completed calendar month, and a 12-month bar chart for the current calendar year with the current month highlighted.

## Scope

- Backend: `GET /dashboard/summary` (`backend/app/routers/dashboard.py`) drops `chart_months` (the old rolling 6-month field) and adds `chart_days` and `chart_year`.
- Frontend: `frontend/app/(app)/dashboard.tsx` removes the "Revenue (6 months)" card and adds two new cards in its place, directly under the FREE PLAN usage bar.
- No new dependencies — both charts are hand-rolled with `View`/`Text`, matching the existing chart's implementation style (confirmed: no charting library is installed anywhere in `frontend/package.json`).
- No interactive tooltips/hover states (a deliberate simplification, matching the existing chart's plain-bar style) — the yearly chart gets a static current-month highlight color instead, which needs no interaction.

## Backend

Both new fields reuse the exact aggregation rule the existing chart already uses: revenue is the sum of `amount_paid_cents` for invoices whose `paid_at` falls within the bucket, aggregated in Python over the same `invoices` list `dashboard_summary` already fetches (no new query).

**`chart_days`** — daily revenue for the most recently completed calendar month (e.g., if today is any day in July, this is all of June, days 1 through June's last day — not July's partial data, confirmed as the desired semantics).

```json
{
  "range_label": "Jun 1 – Jun 30, 2026",
  "total_cents": 1245000,
  "days": [{ "day": 1, "revenue_cents": 39000 }, ...]
}
```

**`chart_year`** — 12 fixed calendar months (January through December of the current year, not a rolling window — distinct from the old `chart_months`, which was a 6-month rolling window). Months later than the current one will show `revenue_cents: 0` since no invoice could have been paid yet — expected, not a bug.

```json
{
  "range_label": "Jan 1 – Dec 31, 2026",
  "total_cents": 14268000,
  "current_month": 7,
  "months": [{ "year": 2026, "month": 1, "revenue_cents": 825000, "label": "Jan" }, ...]
}
```

`range_label` strings are built manually (`f"{start.strftime('%b')} {start.day} – ..."`) rather than via `%-d`/`%e` strftime flags, which aren't reliably cross-platform (Windows doesn't support `%-d`).

`chart_months` and its frontend type/rendering are removed entirely (matching the "replace" decision) — nothing else in the codebase reads `chart_months` (confirmed: it's only ever produced by this route and consumed by the one chart being replaced).

## Frontend

Two new `Card`s replace the "Revenue (6 months)" card, in the same position (directly under the FREE PLAN usage bar), each following the reference screenshot's layout:

- **Revenue (Last Month)**: title, a date-range badge (calendar icon + `chart_days.range_label`) top-right, `formatMoney(chart_days.total_cents, currency)` as a large number, "Total Revenue" as a small subtitle, then a bar chart with one bar per day (uniform styling, matching the existing chart's plain-bar approach — no special highlight, since "most recent day" isn't meaningfully distinguishable once dropped mid-list). X-axis labels shown only every 5th day (1, 5, 10, 15, 20, 25, 30) to avoid crowding up to 31 bars, matching the reference screenshot's sparse labeling.
- **Revenue (Jan – Dec)**: title, a date-range badge (`chart_year.range_label`) top-right, `formatMoney(chart_year.total_cents, currency)` as a large number, "Total Revenue (Year to Date)" as a subtitle, a 12-bar chart (one per month, `Jan`...`Dec` labels), with the bar at index `chart_year.current_month - 1` rendered in the app's brand color and the rest in the existing muted bar color, plus a small legend row ("Current Month" / "Other Months" with matching color swatches) below the chart — this is the one static visual distinction the design calls for, achievable without interactivity.

Both charts reuse the existing `chartRow`/`chartCol`/`barTrack`/`bar` style objects already defined in `dashboard.tsx` (adding only what's new: the date-range badge row, the "Total Revenue" subtitle text style, and the legend row for the yearly chart).

## Error handling

None beyond what already exists — both fields are always present in `GET /dashboard/summary`'s response (never null/missing), so no new loading/error states beyond the screen's existing single loading spinner while `summary` is being fetched.

## Testing

Manual only, matching this codebase's existing convention for the dashboard (no automated tests cover `chart_months` today either). Verify:
- A business with zero invoices: `chart_days`/`chart_year` totals are 0, chart renders with all-empty bars rather than crashing (guard against divide-by-zero the same way the existing chart's `maxBar = Math.max(1, ...)` does).
- A business with invoices paid in the current month only: `chart_days` shows all zeros (since "last month" excludes the current month), `chart_year`'s current-month bar shows the revenue and is visibly highlighted.
- A business with invoices paid in a past month: `chart_days` shows the correct daily breakdown for that specific month once it becomes "last month" (test by directly checking the aggregation against known `paid_at` timestamps, not by waiting for a real month to pass).
