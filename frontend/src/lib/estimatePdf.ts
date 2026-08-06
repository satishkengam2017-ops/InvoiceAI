// Estimate PDF generation: A4 print-ready HTML template (expo-print) plus a
// helper that renders it to a properly named PDF file on device. Mirrors
// invoicePdf.ts's structure; kept as a separate file per this codebase's
// convention of parallel screens/modules over shared abstraction.
import * as FileSystem from "expo-file-system/legacy";
import * as Print from "expo-print";

import { formatMoney } from "@/src/lib/money";
import type { Business, Estimate } from "@/src/lib/types";

function esc(s: string | null | undefined): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function estimateFileName(estimate: Estimate): string {
  return `Estimate-${estimate.number}.pdf`;
}

/** Lifecycle status shown on the PDF — estimates have no payment state. */
function estimateStatusBadge(estimate: Estimate): { label: string; fg: string; bg: string } {
  if (estimate.status === "ACCEPTED") return { label: "ACCEPTED", fg: "#0D683A", bg: "#E6F3EB" };
  if (estimate.status === "DECLINED") return { label: "DECLINED", fg: "#9F3A38", bg: "#FBEAE9" };
  if (estimate.status === "CONVERTED") return { label: "CONVERTED", fg: "#6B6B69", bg: "#EAEAE8" };
  if (estimate.status === "SENT") return { label: "SENT", fg: "#8A5A00", bg: "#FBF0DA" };
  return { label: "DRAFT", fg: "#6B6B69", bg: "#EAEAE8" };
}

export function estimateHtml(estimate: Estimate, business: Business): string {
  const cust = estimate.customer;
  const status = estimateStatusBadge(estimate);

  const rows = estimate.line_items
    .map((li) => {
      const qty = li.quantity;
      const price = formatMoney(li.unit_price_cents, estimate.currency);
      const lineTotal = formatMoney(
        Math.round(qty * li.unit_price_cents * (1 + (li.tax_percent || 0) / 100)),
        estimate.currency
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

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Estimate-${esc(estimate.number)}</title>
  <style>
    @page { size: A4; margin: 14mm 14mm 16mm 14mm; }
    * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    html, body { margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: #FFFFFF; color: #111110; font-size: 14px; line-height: 1.45;
    }
    .page { max-width: 182mm; margin: 0 auto; }
    @media screen {
      body { background: #E9E9E7; padding: 24px 16px; }
      .page {
        background: #FFFFFF; padding: 14mm;
        box-shadow: 0 1px 3px rgba(17,17,16,0.12), 0 8px 24px rgba(17,17,16,0.08);
        border-radius: 4px;
      }
    }
    @media screen and (max-width: 480px) {
      body { padding: 12px 8px; font-size: 13px; }
      .page { padding: 16px; }
      .table-wrap { overflow-x: auto; }
      .th, .td { padding: 8px 6px; }
    }
    .table-wrap { width: 100%; }
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
        <div style="font-size:30px;font-weight:600;color:#0D683A;letter-spacing:-0.5px;">ESTIMATE</div>
        <div style="font-size:14px;color:#3E3E3C;margin:4px 0 10px;">${esc(estimate.number)}</div>
        <span class="badge">${status.label}</span>
      </div>
    </div>

    <!-- Prepared for / Dates -->
    <div style="display:flex;justify-content:space-between;margin-bottom:28px;gap:24px;">
      <div style="flex:1;">
        <div class="section-label">Prepared for</div>
        <div style="font-size:15px;font-weight:600;color:#111110;">${esc(cust?.name || "")}</div>
        ${custLines}
      </div>
      <div style="text-align:right;">
        <div style="margin-bottom:10px;">
          <div class="section-label" style="margin-bottom:2px;">Estimate date</div>
          <div style="font-size:14px;font-weight:500;">${esc(estimate.issue_date)}</div>
        </div>
        <div>
          <div class="section-label" style="margin-bottom:2px;">Expires</div>
          <div style="font-size:14px;font-weight:500;">${esc(estimate.expiry_date || "—")}</div>
        </div>
      </div>
    </div>

    <!-- Line items -->
    <div class="table-wrap" style="margin-bottom:20px;">
      <table>
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
    </div>

    <!-- Totals -->
    <div style="display:flex;justify-content:flex-end;margin-bottom:8px;page-break-inside:avoid;">
      <div style="width:300px;">
        <div class="totals-row">
          <span class="muted-13" style="font-size:14px;">Subtotal</span>
          <span style="font-size:14px;">${formatMoney(estimate.subtotal_cents, estimate.currency)}</span>
        </div>
        ${estimate.tax_total_cents ? `<div class="totals-row">
          <span class="muted-13" style="font-size:14px;">Tax</span>
          <span style="font-size:14px;">${formatMoney(estimate.tax_total_cents, estimate.currency)}</span>
        </div>` : ""}
        ${estimate.discount_cents ? `<div class="totals-row">
          <span class="muted-13" style="font-size:14px;">Discount</span>
          <span style="font-size:14px;">- ${formatMoney(estimate.discount_cents, estimate.currency)}</span>
        </div>` : ""}
        <div class="totals-row" style="border-top:2px solid #111110;margin-top:6px;padding-top:11px;">
          <span style="font-weight:600;font-size:16px;">Total</span>
          <span style="font-weight:600;color:#0D683A;font-size:20px;">${formatMoney(estimate.total_cents, estimate.currency)}</span>
        </div>
      </div>
    </div>

    ${estimate.notes ? `<div class="notes-block" style="margin-top:24px;">
      <div class="section-label">Notes</div>
      <div style="font-size:13px;color:#3E3E3C;line-height:1.6;">${esc(estimate.notes)}</div>
    </div>` : ""}
    ${estimate.terms ? `<div class="notes-block" style="margin-top:16px;padding-top:16px;border-top:1px solid #EAEAE8;">
      <div class="section-label">Terms &amp; Conditions</div>
      <div style="font-size:12px;color:#6B6B69;line-height:1.6;">${esc(estimate.terms)}</div>
    </div>` : ""}

    <div style="margin-top:28px;padding-top:14px;border-top:1px solid #EAEAE8;text-align:center;">
      <div style="font-size:11px;color:#9B9B99;">Thank you for considering us — ${esc(business.name)}</div>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Render the estimate to a PDF file named `Estimate-<number>.pdf` (native
 * only). Mirrors invoicePdf.ts's generateInvoicePdfFile exactly.
 */
export async function generateEstimatePdfFile(
  estimate: Estimate,
  business: Business
): Promise<{ uri: string; fileName: string }> {
  const html = estimateHtml(estimate, business);
  const { uri } = await Print.printToFileAsync({ html, base64: false });
  const fileName = estimateFileName(estimate);
  const dest = `${FileSystem.cacheDirectory}${fileName}`;
  try {
    await FileSystem.deleteAsync(dest, { idempotent: true });
    await FileSystem.moveAsync({ from: uri, to: dest });
    return { uri: dest, fileName };
  } catch {
    return { uri, fileName };
  }
}
