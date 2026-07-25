# Design: Replace "Share PDF" with "Send Email" on the invoice detail page

## Problem

The invoice detail page's action bar currently reads **Download PDF | Share PDF | Record Payment**. "Share PDF" opens the OS's generic share sheet (native) or a print-ready tab (web), leaving the user to manually pick an email app and attach the file themselves. The user wants a one-tap **Send Email** action instead, pre-filled with the customer's email, subject, and body.

## Revision note (2026-07-25)

The original version of this spec had web fall back to `mailto:` + a separate printable tab, since `mailto:` links can't carry attachments. Live testing showed this to be poor UX (a forced print dialog every time, easy to misread as "broken"). The user proposed a better approach — already provisioned a public Supabase Storage bucket named `InvoiceAI` — and this revision replaces the web fallback with a real hosted-PDF-link flow. Native is unchanged from the original version (it already attaches a real file via the OS mail composer).

## Scope

- Backend: one new endpoint that renders the invoice HTML (already built by the frontend) to a PDF and uploads it to Supabase Storage.
- Frontend: `sendEmail` in `frontend/app/invoices/[id].tsx`, updated to call the new endpoint on web instead of opening a printable tab.
- No changes to "Download PDF" or "Record Payment".

## Behavior by platform

### Native (iOS/Android) — unchanged from the original design

Uses `expo-mail-composer` (already added as a dependency). On press:

1. Generate the invoice PDF via the existing `generateInvoicePdfFile(invoice, business)`.
2. Check `MailComposer.isAvailableAsync()`. If `false`, alert "Email unavailable" / "No mail app is configured on this device." and stop.
3. Otherwise `MailComposer.composeAsync({ recipients, subject, body, attachments: [uri] })` — recipients from `invoice.customer?.email` (empty array if none), subject `` `Invoice ${invoice.number} from ${business.name}` ``, body a short line naming the invoice and total, and the real PDF as an attachment.

### Web — new hosted-link flow

`mailto:` still cannot carry attachments, but instead of asking the user to manually save/attach a PDF, the backend now generates and hosts it, and the email links to it.

1. Frontend builds the invoice HTML the same way it already does for printing: `invoiceHtml(invoice, business)` (existing helper, unchanged).
2. Frontend `POST`s that HTML to a new backend endpoint: `POST /api/invoices/{id}/email-pdf`, body `{ "html": "<the HTML string>" }`. Auth: same JWT bearer token as every other API call (`get_business` dependency, scoped to the invoice's own business — same tenant-isolation rule as the rest of the invoices router).
3. Backend renders that HTML to a PDF using `weasyprint` (new Python dependency), uploads the PDF bytes to the `InvoiceAI` Supabase Storage bucket at path `{business_id}/{invoice.number}.pdf` (namespaced per business so paths never collide across tenants, matching the multi-tenant discipline used everywhere else in this codebase — invoice numbers are already unique per business, so no extra UUID segment is needed), and returns `{ "url": "<public URL>" }`. The bucket is public, so the returned URL is a plain, permanent, unauthenticated download link — no signing, no expiry. Re-sending an invoice's email overwrites the same path with the latest PDF, which is the desired behavior (the link should always reflect the invoice's current state).
4. Frontend opens a `mailto:` link (`Linking.openURL`) with the same subject as before, and a body that now includes the hosted URL, e.g.: `` `Hi ${customerName}, please find your invoice here: ${url}. Total due: ${total}. Thank you!` ``. No separate tab is opened, and nothing is auto-printed.
5. If the backend call fails (network error, weasyprint error, Storage upload error), show the existing `Alert.alert("Send failed", ...)` and do not attempt to open `mailto:` at all — a broken link is worse than no email.

### Both platforms

Sending the email marks a DRAFT invoice as SENT afterward, via the existing `markSentIfDraft()` — unchanged.

## New backend interfaces

- `backend/app/routers/invoices.py` (existing router, extended): new route `POST /invoices/{invoice_id}/email-pdf`.
  - Request body: `{ "html": str }` (new Pydantic schema `EmailPdfIn` in `backend/app/schemas.py`).
  - Response: `{ "url": str }`.
  - Auth/scoping: identical pattern to every other route in this file — `ctx: dict = Depends(get_business)`, `db: AsyncSession = Depends(get_db)`, looks up the invoice via `_get_invoice_with_items(db, invoice_id, biz_id)` and 404s if not found/not owned by the caller's business. The `html` in the request body is trusted only insofar as it's rendered to a PDF and uploaded — it is never persisted to the database or reflected back to any other user, so it carries no injection/XSS risk beyond what the requesting user already had authority over (their own browser tab).
- New environment variables (`backend/.env`, already added by the user): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`. Used only by this one endpoint, via Supabase's Storage REST API (`POST {SUPABASE_URL}/storage/v1/object/{bucket}/{path}` with `Authorization: Bearer {SUPABASE_SERVICE_ROLE_KEY}`), called with `httpx.AsyncClient` (new dependency — keeps this async-first codebase's pattern rather than blocking on `requests`).
- New Python dependencies: `weasyprint`, `httpx`.

## Error handling

- Backend: if weasyprint rendering fails, or the Supabase Storage upload returns a non-2xx status, raise `HTTPException(502, ...)` — matches the existing pattern used by the AI extraction route (`ai.py`) for a downstream-service failure.
- Frontend: unchanged try/catch/`Alert.alert("Send failed", ...)`/`finally { setBusy(false) }` pattern already used by `sendEmail`.

## Known platform caveat

`weasyprint` depends on system libraries (Pango, Cairo, GDK-Pixbuf via GTK) that are straightforward to install on Linux (the deployment target) but can require an extra runtime install on Windows for local development. This is called out explicitly in the implementation plan's verification steps — if it blocks local testing on a given Windows machine, the fallback is to verify via the deployed/Linux environment instead, not to swap the library.

## Testing

Manual only, matching the rest of this codebase's convention for this feature area (no automated tests exist for `sharePdf`/`downloadPdf`/`sendEmail` today). Verify:
- Backend: `POST /invoices/{id}/email-pdf` with a real invoice's HTML returns a `url` that, when opened directly, downloads a real, correctly-formatted PDF. Cross-tenant test: a different business's token gets 404, not another business's invoice.
- Web: clicking Send Email opens the mail client with the hosted URL in the body (no separate tab, no print dialog), and that URL is a working download link. Backend failure path (e.g., temporarily broken Storage credentials) shows the "Send failed" alert and does not open `mailto:`.
- Native: unchanged from the original design — verify only if this session has simulator/device access; otherwise document as not verified, same caveat as before.

## Out of scope

- Signed/expiring URLs (explicitly rejected in favor of a public bucket, per the user's choice).
- Deleting/cleaning up old uploaded PDFs (out of scope; a future concern if storage usage becomes a problem).
- Any change to "Download PDF" or "Record Payment".
- Tracking whether the recipient actually opened the link.
