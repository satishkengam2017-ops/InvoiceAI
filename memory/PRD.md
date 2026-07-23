# InvoiceAI - Product Requirements Document (MVP)

## Overview
InvoiceAI is a mobile-first AI-powered invoicing SaaS for freelancers and small businesses. Core promise: create a professional invoice in under 30 seconds via typed description or a manual form, then share the PDF via any native share target (Gmail, WhatsApp, etc.).

## Stack
- **Frontend**: Expo (React Native) + Expo Router (file-based routing)
- **Backend**: FastAPI + Motor (async MongoDB)
- **Auth**: JWT (HS256) with bcrypt password hashing
- **AI**: Anthropic Claude Sonnet 4.5 (user-provided API key stored per business)
- **PDF/Share**: `expo-print` (HTML→PDF) + `expo-sharing` (native share sheet)

## Data model (MongoDB, UUID ids, integer-cents money)
- `users`: `id`, `email`, `password_hash`, `business_id`, `role`, `created_at`
- `businesses`: `id`, `name`, `email`, `currency`, `invoice_prefix`, `next_invoice_no`, `default_due_days`, `plan`, `anthropic_api_key`, `stripe_payment_url_default`, `onboarded`, address fields
- `customers`: `id`, `business_id`, name, email, phone, company, address, archived
- `catalog_items`: `id`, `business_id`, name, `unit_price_cents`, unit, `tax_percent`, archived
- `invoices`: `id`, `business_id`, `customer_id`, `number`, `status`, `currency`, `issue_date`, `due_date`, `line_items[]`, `subtotal_cents`, `tax_total_cents`, `discount_cents`, `total_cents`, `amount_paid_cents`, `stripe_payment_url`, `ai_source_text`, timestamps
- `payments`: `id`, `invoice_id`, `amount_cents`, `method`, `paid_at`

## Tenant isolation
Every tenant-scoped route resolves the business via JWT and filters queries by `business_id`. Every response strips MongoDB `_id`.

## Endpoints (all prefixed `/api`)
- `POST /auth/register`, `POST /auth/login`, `GET /auth/me`
- `GET /business/me`, `PATCH /business/me`
- `PATCH /settings` (anthropic key, stripe url, plan)
- `GET /customers`, `POST /customers`, `GET /customers/{id}`, `PATCH /customers/{id}`, `DELETE /customers/{id}`
- `GET /catalog`, `POST /catalog`, `PATCH /catalog/{id}`, `DELETE /catalog/{id}`
- `GET /invoices`, `POST /invoices`, `GET /invoices/{id}`, `PATCH /invoices/{id}`
- `POST /invoices/{id}/mark-paid`, `POST /invoices/{id}/send`, `POST /invoices/{id}/void`, `POST /invoices/{id}/duplicate`
- `GET /dashboard/summary`
- `POST /ai/extract-invoice` (Anthropic tool-use, structured JSON)
- `GET /health`

## Plans (usage-gated on invoice create)
- **FREE**: 5 invoices lifetime
- **STARTER**: $1/mo, 10 invoices/month
- **PRO**: $5/mo, 50 invoices/month
- Plan is user-selectable in Settings (no payment collection built in MVP — user pastes a Stripe subscription/payment URL on invoices instead).

## Screens (Expo Router)
- `(auth)/sign-in.tsx`, `(auth)/sign-up.tsx`
- `onboarding.tsx` — one-step business profile form
- `(app)/_layout.tsx` — bottom tabs: Dashboard, Invoices, Customers, Catalog, Settings
- `(app)/dashboard.tsx` — revenue metrics, plan usage, 6-month bar chart, recent invoices, FAB "New Invoice"
- `(app)/invoices.tsx` — filter chips (All/Draft/Sent/Paid/Overdue/Void), search, list
- `invoices/new.tsx` — AI mode + Manual mode toggle
- `invoices/[id].tsx` — PDF-styled preview, Share (native), Record Payment, Void, Duplicate
- `(app)/customers.tsx` — list + inline add via bottom sheet
- `customers/[id].tsx` — profile, lifetime revenue, invoice history
- `(app)/catalog.tsx` — items list + add sheet
- `(app)/settings.tsx` — business profile, Anthropic key, default Stripe URL, plan selector, sign out

## AI flow
1. User types free-text description (e.g. "Invoice John for 3 hrs electrical work at $95/hr, due in 2 weeks")
2. `POST /ai/extract-invoice` sends business context (existing customers + catalog) + text to Claude Sonnet 4.5 with a **forced tool call** using a JSON schema
3. Returned draft pre-fills the manual builder with `warnings[]` shown at top
4. Human always reviews & saves — AI never creates a SENT invoice directly

## Sharing
- `expo-print.printToFileAsync(html)` renders the branded HTML template to PDF
- `expo-sharing.shareAsync(uri)` opens the native share sheet (Gmail, WhatsApp, Messages, AirDrop, etc.)
- On share of a DRAFT invoice, backend flips status to SENT

## Design
- iOS-Native Clean aesthetic (warm charcoal + deep emerald `#0D683A`)
- System font, generous padding (16-24pt), 8pt grid, rounded corners (6/12/20)
- Feather icons from `@expo/vector-icons`
- Status pills: Draft (gray), Sent (amber), Paid (emerald), Overdue (red), Void (gray)
- Bottom-sheet modals for inline creation (customers, catalog items, payment)

## Future scope (Phase 2+)
- Quotes + conversion
- Recurring invoices
- Expenses + receipt OCR
- Multi-currency & tax engine
- Reports & CSV export
- Reminder automation
- Stripe subscription billing for plan upgrades
