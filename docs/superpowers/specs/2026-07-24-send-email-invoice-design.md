# Design: Replace "Share PDF" with "Send Email" on the invoice detail page

## Problem

The invoice detail page's action bar currently reads **Download PDF | Share PDF | Record Payment**. "Share PDF" opens the OS's generic share sheet (native) or a print-ready tab (web), leaving the user to manually pick an email app and attach the file themselves. The user wants a one-tap **Send Email** action instead, pre-filled with the customer's email, subject, and body.

## Scope

Frontend-only change to `frontend/app/invoices/[id].tsx` and its PDF helper. No backend changes. Only the "Share PDF" button/handler is replaced; "Download PDF" and "Record Payment" are untouched.

## Behavior by platform

### Native (iOS/Android)

Add `expo-mail-composer` as a new dependency. On press:

1. Generate the invoice PDF the same way `sharePdf`/`downloadPdf` already do (`generateInvoicePdfFile(invoice, business)` — unchanged).
2. Check `MailComposer.isAvailableAsync()`. If `false`, show an alert ("Email unavailable", "No mail app is configured on this device.") and stop — mirrors the existing `Sharing.isAvailableAsync()` guard pattern already used by `sharePdf`/`downloadPdf`.
3. Otherwise call `MailComposer.composeAsync({ recipients, subject, body, attachments: [uri] })`:
   - `recipients`: `[invoice.customer.email]` if present, else `[]` (user fills in the To field themselves in the composer).
   - `subject`: `` `Invoice ${invoice.number} from ${business.name}` ``.
   - `body`: a short plain-text line, e.g. `` `Hi ${invoice.customer?.name ?? "there"}, please find attached Invoice ${invoice.number} for ${formatMoney(invoice.total_cents, invoice.currency)}. Thank you!` ``.
   - `attachments`: `[uri]` (the generated PDF's local file URI).
4. This opens the OS's native mail composer UI (not a generic share sheet) with the PDF genuinely attached. The user reviews and taps Send themselves (`MailComposer.composeAsync` returns a status — `sent`/`saved`/`cancelled`/`undetermined` — but the OS mail composer doesn't guarantee the app is told when the email actually leaves the device, same limitation as the current share flow doesn't guarantee delivery).

### Web

`mailto:` links cannot carry attachments (a hard browser limitation). On press:

1. Build a `mailto:` URL: `mailto:{customer.email}?subject={encoded subject}&body={encoded body}` using the same subject/body content as above (customer email may be empty — `mailto:` with no address still opens the compose window with To blank).
2. Open it via `Linking.openURL(mailtoUrl)` (already a project dependency, cross-platform).
3. Also open the printable invoice in a new tab, reusing the existing `openHtmlInNewTab(invoiceHtml(invoice, business), true)` call already used by `downloadPdf` today, so the user can "Save as PDF" and manually attach it in the mail client that just opened.
4. This is a two-step manual handoff on web, not a true one-click send-with-attachment — an explicit, accepted trade-off given `mailto:`'s limitation.

### Both platforms

On success (native: any composer result other than nothing thrown; web: after opening both windows), call the existing `markSentIfDraft()` — identical to what `sharePdf` already does today. Sending the invoice is a "sent" action regardless of platform.

## Error handling

Same pattern as the existing `sharePdf`/`downloadPdf`: wrap in try/catch, show `Alert.alert("Send failed", message)` on any thrown error, and always reset the `busy` state in a `finally` block.

## Testing

Manual only, matching how `sharePdf`/`downloadPdf` are verified today (no existing automated tests cover those either). Verify:
- Native: composer opens pre-filled with correct recipient/subject/body and the PDF actually attached; the "no mail app" alert path (can be forced by testing on a simulator with no mail account configured).
- Web: `mailto:` opens the default mail client with correct subject/body; the printable tab opens alongside it; invoice moves DRAFT → SENT afterward on both platforms.
- Customer with no email on file: recipient field is blank rather than crashing, on both platforms.

## Out of scope

- Actually sending the email from the backend (a real email-sending integration) — explicitly rejected in favor of the native/mailto approach.
- Any change to "Download PDF" or "Record Payment".
- Tracking whether the recipient actually received/opened the email.
