# Send Email Invoice Action Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the invoice detail page's "Share PDF" button with "Send Email", which opens the OS's native mail composer (with the PDF genuinely attached) on iOS/Android, and a `mailto:` link plus a separate printable tab on web.

**Architecture:** Single-file frontend change. `frontend/app/invoices/[id].tsx`'s `sharePdf` handler is replaced by `sendEmail`, which branches on `Platform.OS` exactly like the existing `downloadPdf`/`sharePdf` do today. Native uses the new `expo-mail-composer` dependency; web uses React Native's built-in `Linking.openURL` with a `mailto:` URL plus the existing `openHtmlInNewTab` helper. No backend changes.

**Tech Stack:** Expo Router, React Native (Web + native), `expo-mail-composer` (new), `expo-print`/`expo-sharing`/`expo-file-system` (existing, unchanged), TypeScript.

## Global Constraints

- No backend changes — this is 100% frontend (`docs/superpowers/specs/2026-07-24-send-email-invoice-design.md`, Scope section).
- "Download PDF" and "Record Payment" buttons/handlers are untouched.
- Sending the email marks a DRAFT invoice as SENT afterward on both platforms, via the existing `markSentIfDraft()` helper already defined in this file — unchanged, just called from the new handler.
- Subject line: exactly `` `Invoice ${invoice.number} from ${business.name}` `` on both platforms.
- Body: exactly `` `Hi ${customerName}, please find attached Invoice ${invoice.number} for ${total}. Thank you!` `` where `customerName` is `invoice.customer?.name ?? "there"` and `total` is `formatMoney(invoice.total_cents, invoice.currency)`.
- Recipient: `invoice.customer?.email` when present; blank/omitted (not a crash) when absent, on both platforms.
- No automated tests exist for `sharePdf`/`downloadPdf` today and this plan does not add any for `sendEmail` either — verification is manual, matching the codebase's existing convention for this exact area (confirmed in the design spec's Testing section).

---

### Task 1: Add `expo-mail-composer` dependency

**Files:**
- Modify: `frontend/package.json`

**Interfaces:**
- Consumes: nothing.
- Produces: the `expo-mail-composer` package, importable in Task 2 as `import * as MailComposer from "expo-mail-composer";`.

- [ ] **Step 1: Install the package**

Run, from `frontend/`:

```bash
npx expo install expo-mail-composer
```

Expected: this adds a line like `"expo-mail-composer": "<version>"` to `frontend/package.json`'s `dependencies` (Expo's installer picks the version compatible with the project's installed Expo SDK — do not hand-pick a version).

- [ ] **Step 2: Verify it installed correctly**

Run, from `frontend/`:

```bash
node -e "console.log(require('expo-mail-composer/package.json').version)"
```

Expected: prints a version string (e.g. `14.0.7`) with no error.

- [ ] **Step 3: Commit**

```bash
git add frontend/package.json frontend/package-lock.json
git commit -m "Add expo-mail-composer dependency for Send Email invoice action"
```

---

### Task 2: Replace "Share PDF" with "Send Email"

**Files:**
- Modify: `frontend/app/invoices/[id].tsx`

**Interfaces:**
- Consumes: `MailComposer` from `expo-mail-composer` (Task 1); `generateInvoicePdfFile`, `invoiceHtml` from `@/src/lib/invoicePdf` (existing, unchanged); `formatMoney` from `@/src/lib/money` (existing, unchanged); `openHtmlInNewTab`, `markSentIfDraft` (both already defined earlier in this same file, unchanged).
- Produces: nothing consumed by other tasks — this is the last task in the plan.

- [ ] **Step 1: Add the `MailComposer` import**

In `frontend/app/invoices/[id].tsx`, change the import block at the top of the file from:

```typescript
import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as Sharing from "expo-sharing";
import React, { useCallback, useEffect, useState } from "react";
```

to:

```typescript
import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as MailComposer from "expo-mail-composer";
import * as Sharing from "expo-sharing";
import React, { useCallback, useEffect, useState } from "react";
```

- [ ] **Step 2: Replace the `sharePdf` function with `sendEmail`**

Find this existing function (it currently sits right after `markSentIfDraft`, before `downloadPdf`):

```typescript
  const sharePdf = async () => {
    if (!invoice) return;
    setBusy(true);
    try {
      if (Platform.OS === "web") {
        // Browsers can't attach a locally generated PDF without a PDF library;
        // open the print-ready invoice so the user can save/share it as PDF
        // (the document title makes the suggested filename Invoice-<number>.pdf).
        openHtmlInNewTab(invoiceHtml(invoice, business as Business), true);
      } else {
        // Generate the actual PDF and hand it to the native share sheet, so the
        // recipient gets Invoice-<number>.pdf as a real attachment (Mail,
        // WhatsApp, Messages, AirDrop, Drive, ...).
        const { uri, fileName } = await generateInvoicePdfFile(invoice, business as Business);
        const canShare = await Sharing.isAvailableAsync();
        if (!canShare) {
          Alert.alert("Sharing unavailable", "Sharing isn't available on this device.");
          return;
        }
        await Sharing.shareAsync(uri, {
          mimeType: "application/pdf",
          dialogTitle: `Send ${fileName}`,
          UTI: "com.adobe.pdf",
        });
      }
      await markSentIfDraft();
    } catch (e) {
      Alert.alert("Share failed", e instanceof Error ? e.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  };
```

Replace it entirely with:

```typescript
  const sendEmail = async () => {
    if (!invoice || !business) return;
    setBusy(true);
    try {
      const subject = `Invoice ${invoice.number} from ${business.name}`;
      const customerName = invoice.customer?.name ?? "there";
      const total = formatMoney(invoice.total_cents, invoice.currency);
      const body = `Hi ${customerName}, please find attached Invoice ${invoice.number} for ${total}. Thank you!`;
      const recipientEmail = invoice.customer?.email ?? undefined;

      if (Platform.OS === "web") {
        // mailto: links cannot carry attachments (a hard browser limitation),
        // so also open the print-ready invoice in a separate tab so the user
        // can save it as a PDF and attach it themselves in the mail client
        // that's about to open.
        openHtmlInNewTab(invoiceHtml(invoice, business as Business), true);
        const params = new URLSearchParams({ subject, body });
        await Linking.openURL(`mailto:${recipientEmail ?? ""}?${params.toString()}`);
      } else {
        // Generate the actual PDF and hand it to the OS's native mail
        // composer directly (not the generic share sheet), so the recipient
        // gets Invoice-<number>.pdf as a real attachment on a pre-filled email.
        const { uri } = await generateInvoicePdfFile(invoice, business as Business);
        const canCompose = await MailComposer.isAvailableAsync();
        if (!canCompose) {
          Alert.alert("Email unavailable", "No mail app is configured on this device.");
          return;
        }
        await MailComposer.composeAsync({
          recipients: recipientEmail ? [recipientEmail] : [],
          subject,
          body,
          attachments: [uri],
        });
      }
      await markSentIfDraft();
    } catch (e) {
      Alert.alert("Send failed", e instanceof Error ? e.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  };
```

- [ ] **Step 3: Update the action bar button**

Find this existing button (in the action bar, between "Download PDF" and "Record Payment"):

```typescript
          <TouchableOpacity
            testID="invoice-share-btn"
            style={styles.actionBtn}
            onPress={sharePdf}
            disabled={busy}
            activeOpacity={0.85}
          >
            <Feather name="share-2" size={20} color={colors.onBrandPrimary} />
            <Text style={styles.actionBtnText}>Share PDF</Text>
          </TouchableOpacity>
```

Replace it with:

```typescript
          <TouchableOpacity
            testID="invoice-send-email-btn"
            style={styles.actionBtn}
            onPress={sendEmail}
            disabled={busy}
            activeOpacity={0.85}
          >
            <Feather name="mail" size={20} color={colors.onBrandPrimary} />
            <Text style={styles.actionBtnText}>Send Email</Text>
          </TouchableOpacity>
```

(`Feather` ships a `mail` icon in the same set already imported — no new icon package needed.)

- [ ] **Step 4: Typecheck**

Run, from `frontend/`:

```bash
npx tsc --noEmit
```

Expected: no errors referencing `frontend/app/invoices/[id].tsx` (pre-existing unrelated errors elsewhere in the project, if any, are not this task's concern).

- [ ] **Step 5: Manual verification — web**

Start the web app (`npx expo start --web` from `frontend/`, or reuse an already-running dev server) and sign in. Open any invoice that is not VOID.

1. Click **Send Email**. Confirm: a new tab opens showing the printable invoice (same as today's "Download PDF" behavior), AND your OS's default mail client opens (or a new browser tab/prompt for `mailto:`, depending on how your OS/browser is configured) with the subject line `Invoice <number> from <business name>` and a body starting with `Hi <customer name or "there">, please find attached Invoice <number> for <total>.`.
2. If the invoice's customer has no email on file, confirm the mail compose window's "To" field is blank rather than the app crashing or throwing an alert.
3. If the invoice was DRAFT before this, reload the invoice detail page and confirm its status is now SENT.

- [ ] **Step 6: Manual verification — native**

On a simulator/device with Expo Go or a dev build, open any invoice that is not VOID.

1. Tap **Send Email**. Confirm the native mail composer opens (not the generic OS share sheet) with the subject/body from Step 5, and a real file attachment named `Invoice-<number>.pdf`.
2. If the invoice's customer has no email on file, confirm the "To" field is blank rather than a crash.
3. To test the no-mail-app path: on a simulator with no mail account configured, tapping **Send Email** should show the alert "Email unavailable" / "No mail app is configured on this device." rather than crashing.
4. Confirm a DRAFT invoice becomes SENT after the composer is dismissed (whether sent, saved as draft, or cancelled inside the native composer — `markSentIfDraft()` runs regardless, matching today's `sharePdf` behavior).

- [ ] **Step 7: Commit**

```bash
git add frontend/app/invoices/\[id\].tsx
git commit -m "Replace Share PDF with Send Email on invoice detail page"
```

---

## Post-implementation note

This plan does not touch `frontend/app/invoices/[id].tsx`'s `downloadPdf` function or the "Record Payment" button/modal — both are out of scope per the design spec and should be unchanged after Task 2.
