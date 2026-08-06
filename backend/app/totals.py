"""Line-item totals engine (single source of truth) — shared by invoices
and estimates so their money math can never drift apart.
"""
from typing import List, Optional


def compute_totals(
    line_items: List[dict],
    discount_type: Optional[str] = None,
    discount_value: int = 0,
) -> dict:
    subtotal = 0
    tax_total = 0
    tax_breakdown: dict = {}

    for li in line_items:
        qty = float(li.get("quantity", 1))
        unit_price = int(li.get("unit_price_cents", 0))
        line_subtotal = round(qty * unit_price)
        tax_pct = float(li.get("tax_percent", 0) or 0)
        line_tax = round(line_subtotal * tax_pct / 100)
        subtotal += line_subtotal
        tax_total += line_tax
        if tax_pct > 0:
            key = f"{tax_pct}"
            tax_breakdown[key] = tax_breakdown.get(key, 0) + line_tax

    discount_cents = 0
    if discount_type == "PERCENT" and discount_value:
        discount_cents = round(subtotal * (discount_value / 10000))
    elif discount_type == "FIXED" and discount_value:
        discount_cents = int(discount_value)

    total = subtotal + tax_total - discount_cents
    if total < 0:
        total = 0

    return {
        "subtotal_cents": subtotal,
        "tax_total_cents": tax_total,
        "tax_breakdown": [{"percent": float(k), "amount_cents": v} for k, v in tax_breakdown.items()],
        "discount_cents": discount_cents,
        "total_cents": total,
    }
