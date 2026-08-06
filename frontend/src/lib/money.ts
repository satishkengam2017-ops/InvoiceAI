// Currency helpers. All amounts internally are integer minor units (cents).

export function formatMoney(cents: number, currency: string = "USD"): string {
  const value = (cents || 0) / 100;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `$${value.toFixed(2)}`;
  }
}

export function parseCents(input: string): number {
  const cleaned = (input || "").replace(/[^0-9.\-]/g, "");
  const num = parseFloat(cleaned);
  if (isNaN(num)) return 0;
  return Math.round(num * 100);
}

export type LineItem = {
  name: string;
  description?: string | null;
  quantity: number;
  unit_price_cents: number;
  tax_percent?: number;
};

export function computeTotals(
  lineItems: LineItem[],
  discountType?: "PERCENT" | "FIXED" | null,
  discountValue: number = 0
) {
  let subtotal = 0;
  let taxTotal = 0;

  for (const li of lineItems) {
    const lineSubtotal = Math.round((li.quantity || 0) * (li.unit_price_cents || 0));
    const lineTax = Math.round((lineSubtotal * (li.tax_percent || 0)) / 100);
    subtotal += lineSubtotal;
    taxTotal += lineTax;
  }

  let discountCents = 0;
  if (discountType === "PERCENT" && discountValue) {
    discountCents = Math.round((subtotal * discountValue) / 10000);
  } else if (discountType === "FIXED" && discountValue) {
    discountCents = discountValue;
  }
  const total = Math.max(0, subtotal + taxTotal - discountCents);
  return { subtotal, taxTotal, discountCents, total };
}
