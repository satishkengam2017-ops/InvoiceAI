// HTML template for invoice PDF (used with expo-print).
import type { Business, Invoice } from "@/src/lib/types";
import { formatMoney } from "@/src/lib/money";

function esc(s: string | null | undefined): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function invoiceHtml(invoice: Invoice, business: Business): string {
  const cust = invoice.customer;
  const rows = invoice.line_items
    .map((li) => {
      const qty = li.quantity;
      const price = formatMoney(li.unit_price_cents, invoice.currency);
      const lineTotal = formatMoney(
        Math.round(qty * li.unit_price_cents * (1 + (li.tax_percent || 0) / 100)),
        invoice.currency
      );
      const tax = li.tax_percent ? `${li.tax_percent}% tax` : "";
      return `
        <tr>
          <td style="padding:12px 8px;border-bottom:1px solid #EAEAE8;">
            <div style="font-weight:500;color:#111110;">${esc(li.name)}</div>
            ${li.description ? `<div style="font-size:12px;color:#6B6B69;margin-top:2px;">${esc(li.description)}</div>` : ""}
            ${tax ? `<div style="font-size:11px;color:#6B6B69;margin-top:2px;">${tax}</div>` : ""}
          </td>
          <td style="padding:12px 8px;border-bottom:1px solid #EAEAE8;text-align:right;color:#3E3E3C;">${qty}</td>
          <td style="padding:12px 8px;border-bottom:1px solid #EAEAE8;text-align:right;color:#3E3E3C;">${price}</td>
          <td style="padding:12px 8px;border-bottom:1px solid #EAEAE8;text-align:right;font-weight:500;color:#111110;">${lineTotal}</td>
        </tr>`;
    })
    .join("");

  const payBlock = invoice.stripe_payment_url
    ? `<div style="margin-top:24px;padding:16px;background:#E6F3EB;border-radius:12px;">
         <div style="font-size:12px;color:#0D683A;font-weight:500;margin-bottom:6px;">PAY ONLINE</div>
         <a href="${esc(invoice.stripe_payment_url)}" style="color:#0D683A;font-size:14px;font-weight:500;text-decoration:none;">${esc(invoice.stripe_payment_url)}</a>
       </div>`
    : "";

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(invoice.number)}</title>
</head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#FFFFFF;color:#111110;">
  <div style="max-width:760px;margin:0 auto;padding:40px 32px;">
    <!-- Header -->
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:32px;">
      <div>
        <div style="font-size:24px;font-weight:600;color:#111110;">${esc(business.name)}</div>
        ${business.email ? `<div style="font-size:13px;color:#6B6B69;margin-top:4px;">${esc(business.email)}</div>` : ""}
        ${business.phone ? `<div style="font-size:13px;color:#6B6B69;">${esc(business.phone)}</div>` : ""}
        ${business.address_line1 ? `<div style="font-size:13px;color:#6B6B69;margin-top:4px;">${esc(business.address_line1)}</div>` : ""}
        ${business.city ? `<div style="font-size:13px;color:#6B6B69;">${esc([business.city, business.region, business.postal_code].filter(Boolean).join(", "))}</div>` : ""}
      </div>
      <div style="text-align:right;">
        <div style="font-size:32px;font-weight:600;color:#0D683A;letter-spacing:-0.5px;">INVOICE</div>
        <div style="font-size:14px;color:#3E3E3C;margin-top:4px;">${esc(invoice.number)}</div>
      </div>
    </div>

    <!-- Bill to / Dates -->
    <div style="display:flex;justify-content:space-between;margin-bottom:32px;gap:24px;">
      <div style="flex:1;">
        <div style="font-size:11px;font-weight:500;color:#6B6B69;letter-spacing:0.5px;text-transform:uppercase;margin-bottom:6px;">Bill to</div>
        <div style="font-size:15px;font-weight:500;color:#111110;">${esc(cust?.name || "")}</div>
        ${cust?.company ? `<div style="font-size:13px;color:#3E3E3C;">${esc(cust.company)}</div>` : ""}
        ${cust?.email ? `<div style="font-size:13px;color:#3E3E3C;">${esc(cust.email)}</div>` : ""}
        ${cust?.address_line1 ? `<div style="font-size:13px;color:#3E3E3C;margin-top:2px;">${esc(cust.address_line1)}</div>` : ""}
      </div>
      <div style="flex:1;text-align:right;">
        <div style="margin-bottom:8px;">
          <div style="font-size:11px;color:#6B6B69;letter-spacing:0.5px;text-transform:uppercase;">Issue date</div>
          <div style="font-size:14px;color:#111110;font-weight:500;">${esc(invoice.issue_date)}</div>
        </div>
        <div>
          <div style="font-size:11px;color:#6B6B69;letter-spacing:0.5px;text-transform:uppercase;">Due date</div>
          <div style="font-size:14px;color:#111110;font-weight:500;">${esc(invoice.due_date)}</div>
        </div>
      </div>
    </div>

    <!-- Line items -->
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
      <thead>
        <tr style="border-bottom:2px solid #111110;">
          <th style="text-align:left;padding:12px 8px;font-size:11px;font-weight:500;color:#6B6B69;text-transform:uppercase;letter-spacing:0.5px;">Description</th>
          <th style="text-align:right;padding:12px 8px;font-size:11px;font-weight:500;color:#6B6B69;text-transform:uppercase;letter-spacing:0.5px;">Qty</th>
          <th style="text-align:right;padding:12px 8px;font-size:11px;font-weight:500;color:#6B6B69;text-transform:uppercase;letter-spacing:0.5px;">Price</th>
          <th style="text-align:right;padding:12px 8px;font-size:11px;font-weight:500;color:#6B6B69;text-transform:uppercase;letter-spacing:0.5px;">Amount</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    <!-- Totals -->
    <div style="display:flex;justify-content:flex-end;margin-bottom:24px;">
      <div style="width:280px;">
        <div style="display:flex;justify-content:space-between;padding:8px 0;">
          <span style="color:#6B6B69;font-size:14px;">Subtotal</span>
          <span style="color:#111110;font-size:14px;">${formatMoney(invoice.subtotal_cents, invoice.currency)}</span>
        </div>
        ${invoice.tax_total_cents ? `<div style="display:flex;justify-content:space-between;padding:8px 0;">
          <span style="color:#6B6B69;font-size:14px;">Tax</span>
          <span style="color:#111110;font-size:14px;">${formatMoney(invoice.tax_total_cents, invoice.currency)}</span>
        </div>` : ""}
        ${invoice.discount_cents ? `<div style="display:flex;justify-content:space-between;padding:8px 0;">
          <span style="color:#6B6B69;font-size:14px;">Discount</span>
          <span style="color:#111110;font-size:14px;">- ${formatMoney(invoice.discount_cents, invoice.currency)}</span>
        </div>` : ""}
        <div style="display:flex;justify-content:space-between;padding:12px 0;border-top:2px solid #111110;margin-top:8px;">
          <span style="font-weight:600;color:#111110;font-size:16px;">Total</span>
          <span style="font-weight:600;color:#0D683A;font-size:20px;">${formatMoney(invoice.total_cents, invoice.currency)}</span>
        </div>
        ${invoice.amount_paid_cents ? `<div style="display:flex;justify-content:space-between;padding:6px 0;">
          <span style="color:#6B6B69;font-size:13px;">Paid</span>
          <span style="color:#0D683A;font-size:13px;font-weight:500;">${formatMoney(invoice.amount_paid_cents, invoice.currency)}</span>
        </div>
        <div style="display:flex;justify-content:space-between;padding:6px 0;">
          <span style="color:#111110;font-size:14px;font-weight:600;">Balance due</span>
          <span style="color:#111110;font-size:14px;font-weight:600;">${formatMoney(invoice.total_cents - invoice.amount_paid_cents, invoice.currency)}</span>
        </div>` : ""}
      </div>
    </div>

    ${payBlock}

    ${invoice.notes ? `<div style="margin-top:24px;">
      <div style="font-size:11px;font-weight:500;color:#6B6B69;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Notes</div>
      <div style="font-size:13px;color:#3E3E3C;line-height:1.6;">${esc(invoice.notes)}</div>
    </div>` : ""}
    ${invoice.terms ? `<div style="margin-top:16px;padding-top:16px;border-top:1px solid #EAEAE8;">
      <div style="font-size:11px;font-weight:500;color:#6B6B69;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Terms</div>
      <div style="font-size:12px;color:#6B6B69;line-height:1.6;">${esc(invoice.terms)}</div>
    </div>` : ""}
  </div>
</body>
</html>`;
}
