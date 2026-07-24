# Database migration: MongoDB → Supabase Postgres — Design

Date: 2026-07-24
Status: Approved by user, ready for implementation planning

## Purpose

Replace the backend's MongoDB data layer (currently a local Docker container)
with Supabase's hosted Postgres, so the app can run fully hosted with nothing
required on the user's local machine. This is the first of two planned
migrations — a second, separate spec will later replace the custom
JWT + Clerk auth system with Supabase Auth, once this database migration is
live and stable. That second migration is explicitly out of scope here.

## Scope decisions

- **Data**: fresh start. Everything currently in MongoDB is test/smoke data
  created during development — no data-migration script is written; the new
  Postgres schema is created empty.
- **Query layer**: SQLAlchemy (async) + asyncpg. Queries stay in Python, in
  the FastAPI app, same style as today — just SQL instead of Mongo filters.
  Multi-tenant isolation (`business_id` filtering) stays enforced in
  application code exactly as it is now, not via Postgres Row Level Security.
  This keeps the app portable to any Postgres, not locked to Supabase
  specifically.
- **Nested arrays become child tables, not JSONB**: `invoice.line_items` and
  `business.tax_numbers` — currently embedded arrays of objects — become
  proper relational child tables (`line_items`, `tax_numbers`) with foreign
  keys, not JSONB columns. This is the actual point of moving to a relational
  database — real referential integrity and the ability to query across line
  items later, which a JSONB blob would not provide.
- **One deliberate exception**: `tax_breakdown` (an invoice's per-rate tax
  rollup) stays as a Python-computed value in the API response, not a stored
  column of any kind. It's derived from `line_items` on every read and is
  never independently queried — there is nothing to model relationally.
- **Auth is untouched** in this migration: custom JWT (`make_token`,
  `get_current_user`) and the Clerk Google sign-in exchange
  (`resolve_clerk_user`, `/auth/clerk-exchange`) work exactly as they do
  today, just reading/writing Postgres instead of MongoDB underneath.

## Schema

```sql
businesses
  id UUID PK, owner_user_id UUID, name, legal_name, email, phone, website,
  logo_url, address_line1, city, region, postal_code, country, currency,
  invoice_prefix, next_invoice_no INT, default_terms, default_due_days INT,
  plan, anthropic_api_key, stripe_payment_url_default,
  stripe_customer_id, stripe_subscription_id, onboarded BOOL,
  created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ

tax_numbers                 -- child of businesses (was business.tax_numbers[])
  id UUID PK, business_id FK -> businesses.id, label, value

users
  id UUID PK, email TEXT UNIQUE, password_hash NULLABLE, business_id FK,
  name, role, clerk_user_id NULLABLE, created_at TIMESTAMPTZ

customers
  id UUID PK, business_id FK, name, email, phone, company, address_line1,
  city, region, postal_code, country, notes, archived BOOL,
  created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ

catalog_items
  id UUID PK, business_id FK, name, description, unit_price_cents INT,
  currency, unit, tax_percent NUMERIC, archived BOOL,
  created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ

invoices
  id UUID PK, business_id FK, customer_id FK, number, status, currency,
  issue_date DATE, due_date DATE, discount_type, discount_value INT,
  subtotal_cents INT, tax_total_cents INT, discount_cents INT,
  total_cents INT, amount_paid_cents INT, notes, terms, stripe_payment_url,
  ai_source_text, sent_at TIMESTAMPTZ, paid_at TIMESTAMPTZ,
  voided_at TIMESTAMPTZ, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ

line_items                  -- child of invoices (was invoice.line_items[])
  id UUID PK, invoice_id FK -> invoices.id, sort_order INT, name,
  description, quantity NUMERIC, unit_price_cents INT, tax_percent NUMERIC

payments
  id UUID PK, invoice_id FK, business_id FK, amount_cents INT, method,
  paid_at TIMESTAMPTZ

webhook_events
  id TEXT PK (Stripe event id), type, processed_at TIMESTAMPTZ
```

Notes on specific columns:

- `next_invoice_no` is incremented atomically via a single
  `UPDATE ... SET next_invoice_no = next_invoice_no + 1 WHERE id = :id
  RETURNING next_invoice_no` statement — the direct Postgres equivalent of
  today's Mongo `find_one_and_update` with `$inc`.
- `sort_order` on `line_items` is required because Postgres does not
  guarantee row retrieval order without one — line items must render in the
  order the user entered them, which MongoDB's array preserved implicitly.
- A single `TIMESTAMPTZ` column replaces the current pattern of storing both
  an ISO string (`created_at`) and a real `datetime` (`created_at_dt`) side
  by side — the datetime duplication existed only because MongoDB can't do
  proper range queries on a string column. Postgres does both jobs with one
  column.
- `users.email` gets a `UNIQUE` constraint. Today's duplicate-email check in
  `/auth/register` is a `find_one` followed by `insert_one` — two operations,
  not atomic, so two concurrent signups with the same email could both pass
  the check before either insert completes. The constraint closes this at
  the database level; the existing "Email already registered" 400 response
  becomes "catch the constraint violation," not "hope nothing raced."

## File structure

`backend/server.py` is currently one 1183-line file covering every route and
concern. Since this migration touches every data-access line in it anyway,
it is split into focused modules along the same boundaries the file's
existing `# --- Section ---` comments already describe:

```
backend/
  app/
    __init__.py
    main.py           # FastAPI app, CORS, router includes, startup/shutdown
    db.py             # async engine, session factory, get_db() dependency
    models.py         # SQLAlchemy ORM models (all 8 tables)
    schemas.py        # Pydantic request/response models (unchanged from today)
    auth.py           # get_current_user, get_business, make_token, Clerk exchange
    routers/
      auth.py         # /auth/register, /auth/login, /auth/me, /auth/clerk-exchange
      business.py     # /business/me, /settings, /plans
      customers.py
      catalog.py
      invoices.py     # includes compute_totals, check_plan_limit
      dashboard.py
      ai.py           # /ai/extract-invoice
      webhooks.py     # /webhooks/stripe
  alembic/
    versions/
  alembic.ini
```

## Migration mechanics & environment

- **Alembic** manages schema versions. One initial migration creates all 8
  tables above. No data-migration script (per the fresh-start decision).
- **Two connection strings**: Supabase provides a **pooled** connection
  (PgBouncer, port 6543, "transaction mode") for the running application,
  and a **direct** connection (port 5432) for Alembic. Pooled/transaction-mode
  connections don't reliably support the session-level features migrations
  sometimes need, so the app and Alembic use separate env vars:
  `DATABASE_URL` (pooled, app runtime) and `DATABASE_URL_DIRECT` (direct,
  migrations only).
- **`backend/.env` changes**: `MONGO_URL` and `DB_NAME` are replaced by
  `DATABASE_URL` and `DATABASE_URL_DIRECT`. `JWT_SECRET`, `CLERK_SECRET_KEY`,
  and the Stripe env vars are untouched.
- **Dependencies**: add `sqlalchemy[asyncio]`, `asyncpg`, `alembic`; remove
  `motor` and `pymongo` (unused once this migration lands).

## Testing

No change to the testing approach. `test_backend.py` drives a live running
server over HTTP; `test_clerk_auth.py` imports the app in-process. Neither
cares what's behind the API today, and that remains true after this
migration — they just need a running Postgres (Supabase, or a local Postgres
container for CI/dev) instead of MongoDB. `conftest.py` itself does not need
to change.

## What does NOT change

- Business logic: `compute_totals`, plan limits (`check_plan_limit`,
  `PLAN_LIMITS`, `PLAN_META`), the Stripe webhook's signature verification
  and event handling, the Clerk exchange flow's account-linking rule.
- PDF generation (frontend-only; never touched the database directly).
- The frontend is untouched entirely — it talks to the same `/api/*` routes
  with the same request/response shapes.
- Auth: custom JWT (`make_token`/`get_current_user`) and Clerk Google
  sign-in (`resolve_clerk_user`/`/auth/clerk-exchange`) behave identically;
  only their underlying database reads/writes change from Mongo to Postgres.

## Out of scope (for this iteration)

- Replacing custom JWT + Clerk with Supabase Auth — a separate, later spec,
  explicitly sequenced after this migration is live (Supabase Auth's
  `auth.users` table lives inside the same Postgres project, so it only
  makes sense to adopt once already on Supabase Postgres).
- Postgres Row Level Security — tenant isolation stays in application code.
- Any change to the actual deployment target (Render/Netlify) — this spec
  only replaces the database; the still-pending "run online" deployment
  work is separate.
