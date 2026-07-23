// Invoice PDF generation: A4 print-ready HTML template (expo-print) plus a
// helper that renders it to a properly named PDF file on device.
import * as FileSystem from "expo-file-system/legacy";
import * as Print from "expo-print";

import { formatMoney } from "@/src/lib/money";
import type { Business, Invoice } from "@/src/lib/types";

function esc(s: string | null | undefined): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function invoiceFileName(invoice: Invoice): string {
  return `Invoice-${invoice.number}.pdf`;
}

/** Payment status shown on the PDF: independent of workflow states like SENT/VIEWED. */
function paymentStatus(invoice: Invoice): { label: string; fg: string; bg: string } {
  if (invoice.status === "VOID") return { label: "VOID", fg: "#6B6B69", bg: "#EAEAE8" };
  if (invoice.status === "PAID") return { label: "PAID", fg: "#0D683A", bg: "#E6F3EB" };
  if ((invoice.amount_paid_cents || 0) > 0)
    return { label: "PARTIALLY PAID", fg: "#8A5A00", bg: "#FBF0DA" };
  return { label: "UNPAID", fg: "#9F3A38", bg: "#FBEAE9" };
}

export function invoiceHtml(invoice: Invoice, business: Business): string {
  const cust = invoice.customer;
  const status = paymentStatus(invoice);
  const balance = invoice.total_cents - (invoice.amount_paid_cents || 0);

  const rows = invoice.line_items
    .map((li) => {
      const qty = li.quantity;
      const price = formatMoney(li.unit_price_cents, invoice.currency);
      const lineTotal = formatMoney(
        Math.round(qty * li.unit_price_cents * (1 + (li.tax_percent || 0) / 100)),
        invoice.currency
      );
      const tax = li.tax_percent ? `${li.tax_percent}%` : "—";
      return `
        <tr>
          <td class="td td-desc">
            <div class="li-name">${esc(li.name)}</div>
            ${li.description ? `<div class="li-desc">${esc(li.description)}</div>` : ""}
          </td>
          <td class="td num">${qty}</td>
          <td class="td num">${price}</td>
          <td class="td num">${tax}</td>
          <td class="td num li-total">${lineTotal}</td>
        </tr>`;
    })
    .join("");

  const logoBlock = business.logo_url
    ? `<img src="${esc(business.logo_url)}" alt="" style="max-height:56px;max-width:180px;object-fit:contain;margin-bottom:10px;display:block;" />`
    : "";

  const bizLines = [
    business.email,
    business.phone,
    business.website,
    business.address_line1,
    [business.city, business.region, business.postal_code].filter(Boolean).join(", "),
    business.country,
  ]
    .filter(Boolean)
    .map((l) => `<div class="muted-13">${esc(l as string)}</div>`)
    .join("");

  const taxIds = (business.tax_numbers || [])
    .map((t: { label?: string; value?: string }) =>
      t?.value ? `<div class="muted-13">${esc(t.label || "Tax ID")}: ${esc(t.value)}</div>` : ""
    )
    .join("");

  const custLines = [
    cust?.company,
    cust?.email,
    cust?.phone,
    cust?.address_line1,
    [cust?.city, cust?.region, cust?.postal_code].filter(Boolean).join(", "),
    cust?.country,
  ]
    .filter(Boolean)
    .map((l) => `<div class="dark-13">${esc(l as string)}</div>`)
    .join("");

  const payBlock = invoice.stripe_payment_url
    ? `<div class="pay-block">
         <div class="pay-label">PAY ONLINE</div>
         <a href="${esc(invoice.stripe_payment_url)}" class="pay-link">${esc(invoice.stripe_payment_url)}</a>
       </div>`
    : "";

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Invoice-${esc(invoice.number)}</title>
  <style>
    @page { size: A4; margin: 14mm 14mm 16mm 14mm; }
    * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    html, body { margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: #FFFFFF; color: #111110; font-size: 14px; line-height: 1.45;
    }
    .page { max-width: 182mm; margin: 0 auto; }
    .muted-13 { font-size: 13px; color: #6B6B69; }
    .dark-13 { font-size: 13px; color: #3E3E3C; }
    .section-label {
      font-size: 11px; font-weight: 600; color: #6B6B69;
      letter-spacing: 0.6px; text-transform: uppercase; margin-bottom: 6px;
    }
    table { width: 100%; border-collapse: collapse; }
    thead { display: table-header-group; }
    tr { page-break-inside: avoid; }
    .th {
      text-align: right; padding: 10px 8px; font-size: 11px; font-weight: 600;
      color: #6B6B69; text-transform: uppercase; letter-spacing: 0.6px;
      border-bottom: 2px solid #111110;
    }
    .th-desc { text-align: left; }
    .td { padding: 11px 8px; border-bottom: 1px solid #EAEAE8; vertical-align: top; }
    .num { text-align: right; white-space: nowrap; color: #3E3E3C; }
    .td-desc { text-align: left; }
    .li-name { font-weight: 500; color: #111110; }
    .li-desc { font-size: 12px; color: #6B6B69; margin-top: 2px; }
    .li-total { font-weight: 500; color: #111110; }
    .totals-row { display: flex; justify-content: space-between; padding: 7px 0; }
    .badge {
      display: inline-block; padding: 5px 14px; border-radius: 999px;
      font-size: 12px; font-weight: 700; letter-spacing: 0.8px;
      color: ${status.fg}; background: ${status.bg};
    }
    .pay-block { margin-top: 24px; padding: 16px; background: #E6F3EB; border-radius: 12px; page-break-inside: avoid; }
    .pay-label { font-size: 12px; color: #0D683A; font-weight: 600; margin-bottom: 6px; letter-spacing: 0.6px; }
    .pay-link { color: #0D683A; font-size: 14px; font-weight: 500; text-decoration: none; word-break: break-all; }
    .notes-block { page-break-inside: avoid; }
  </style>
</head>
<body>
  <div class="page">
    <!-- Header -->
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:30px;">
      <div>
        ${logoBlock}
        <div style="font-size:22px;font-weight:600;color:#111110;">${esc(business.name)}</div>
        ${business.legal_name && business.legal_name !== business.name ? `<div class="muted-13">${esc(business.legal_name)}</div>` : ""}
        <div style="margin-top:4px;">${bizLines}</div>
        ${taxIds}
      </div>
      <div style="text-align:right;">
        <div style="font-size:30px;font-weight:600;color:#0D683A;letter-spacing:-0.5px;">INVOICE</div>
        <div style="font-size:14px;color:#3E3E3C;margin:4px 0 10px;">${esc(invoice.number)}</div>
        <span class="badge">${status.label}</span>
      </div>
    </div>

    <!-- Bill to / Dates -->
    <div style="display:flex;justify-content:space-between;margin-bottom:28px;gap:24px;">
      <div style="flex:1;">
        <div class="section-label">Bill to</div>
        <div style="font-size:15px;font-weight:600;color:#111110;">${esc(cust?.name || "")}</div>
        ${custLines}
      </div>
      <div style="text-align:right;">
        <div style="margin-bottom:10px;">
          <div class="section-label" style="margin-bottom:2px;">Invoice date</div>
          <div style="font-size:14px;font-weight:500;">${esc(invoice.issue_date)}</div>
        </div>
        <div>
          <div class="section-label" style="margin-bottom:2px;">Due date</div>
          <div style="font-size:14px;font-weight:500;">${esc(invoice.due_date)}</div>
        </div>
      </div>
    </div>

    <!-- Line items -->
    <table style="margin-bottom:20px;">
      <thead>
        <tr>
          <th class="th th-desc">Description</th>
          <th class="th">Qty</th>
          <th class="th">Unit price</th>
          <th class="th">Tax</th>
          <th class="th">Amount</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    <!-- Totals -->
    <div style="display:flex;justify-content:flex-end;margin-bottom:8px;page-break-inside:avoid;">
      <div style="width:300px;">
        <div class="totals-row">
          <span class="muted-13" style="font-size:14px;">Subtotal</span>
          <span style="font-size:14px;">${formatMoney(invoice.subtotal_cents, invoice.currency)}</span>
        </div>
        ${invoice.tax_total_cents ? `<div class="totals-row">
          <span class="muted-13" style="font-size:14px;">Tax</span>
          <span style="font-size:14px;">${formatMoney(invoice.tax_total_cents, invoice.currency)}</span>
        </div>` : ""}
        ${invoice.discount_cents ? `<div class="totals-row">
          <span class="muted-13" style="font-size:14px;">Discount</span>
          <span style="font-size:14px;">- ${formatMoney(invoice.discount_cents, invoice.currency)}</span>
        </div>` : ""}
        <div class="totals-row" style="border-top:2px solid #111110;margin-top:6px;padding-top:11px;">
          <span style="font-weight:600;font-size:16px;">Total</span>
          <span style="font-weight:600;color:#0D683A;font-size:20px;">${formatMoney(invoice.total_cents, invoice.currency)}</span>
        </div>
        ${invoice.amount_paid_cents ? `<div class="totals-row" style="padding:5px 0;">
          <span class="muted-13">Amount paid</span>
          <span style="color:#0D683A;font-size:13px;font-weight:500;">${formatMoney(invoice.amount_paid_cents, invoice.currency)}</span>
        </div>
        <div class="totals-row" style="padding:5px 0;">
          <span style="font-size:14px;font-weight:600;">Balance due</span>
          <span style="font-size:14px;font-weight:600;">${formatMoney(balance, invoice.currency)}</span>
        </div>` : ""}
      </div>
    </div>

    ${payBlock}

    ${invoice.notes ? `<div class="notes-block" style="margin-top:24px;">
      <div class="section-label">Notes</div>
      <div style="font-size:13px;color:#3E3E3C;line-height:1.6;">${esc(invoice.notes)}</div>
    </div>` : ""}
    ${invoice.terms ? `<div class="notes-block" style="margin-top:16px;padding-top:16px;border-top:1px solid #EAEAE8;">
      <div class="section-label">Terms &amp; Conditions</div>
      <div style="font-size:12px;color:#6B6B69;line-height:1.6;">${esc(invoice.terms)}</div>
    </div>` : ""}

    <div style="margin-top:28px;padding-top:14px;border-top:1px solid #EAEAE8;text-align:center;">
      <div style="font-size:11px;color:#9B9B99;">Thank you for your business — ${esc(business.name)}</div>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Render the invoice to a PDF file named `Invoice-<number>.pdf` (native only).
 * expo-print writes to a random UUID path, so the file is moved into the cache
 * directory under its proper name — the share sheet and saved file then show
 * "Invoice-INV-000123.pdf" instead of a UUID.
 */
export async function generateInvoicePdfFile(
  invoice: Invoice,
  business: Business
): Promise<{ uri: string; fileName: string }> {
  const html = invoiceHtml(invoice, business);
  const { uri } = await Print.printToFileAsync({ html, base64: false });
  const fileName = invoiceFileName(invoice);
  const dest = `${FileSystem.cacheDirectory}${fileName}`;
  try {
    await FileSystem.deleteAsync(dest, { idempotent: true });
    await FileSystem.moveAsync({ from: uri, to: dest });
    return { uri: dest, fileName };
  } catch {
    // Fall back to the original UUID path if the move fails for any reason.
    return { uri, fileName };
  }
}
