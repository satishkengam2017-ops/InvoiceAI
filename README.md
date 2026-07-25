# InvoiceAI

Invoicing app with AI-powered invoice drafting (Anthropic Claude), built with FastAPI + Postgres (Supabase) (backend) and Expo / React Native (frontend).

## Prerequisites

- Python 3.11+
- Node.js 20+ (npm or yarn)
- A Supabase Postgres project (session-mode pooler connection string)

## Backend

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate        # Windows (use `source .venv/bin/activate` on macOS/Linux)
pip install -r requirements.txt
playwright install chromium   # one-time: downloads the browser used to render invoice PDFs for email
uvicorn app.main:app --reload --port 8000
```

Configuration lives in `backend/.env` (see `.env.example`):

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | yes | Supabase Postgres connection string (session-mode pooler, port 5432) |
| `JWT_SECRET` | recommended | Secret for signing auth tokens |
| `SUPABASE_URL` | yes | Supabase project URL, used to upload emailed invoice PDFs to Storage |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Supabase Storage service-role key (uploads to the public `InvoiceAI` bucket) |
| `STRIPE_WEBHOOK_SECRET` | no | Only needed for Stripe plan-upgrade webhooks |
| `STRIPE_STARTER_URL` / `STRIPE_PRO_URL` | no | Stripe Payment Link URLs for paid plans |

The AI invoice-extraction feature uses a per-business Anthropic API key entered in the app's Settings screen — no server-side key needed.

`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` power `POST /invoices/{id}/email-pdf`: it renders an invoice to a PDF (via the Chromium binary installed above) and uploads it to a public Supabase Storage bucket named `InvoiceAI`, which must already exist in your Supabase project.

API docs available at http://localhost:8000/docs once running.

## Frontend (Expo)

```bash
cd frontend
npm install
npm run web        # or: npm start (then open in Expo Go / emulator)
```

`frontend/.env` sets the backend URL:

```
EXPO_PUBLIC_BACKEND_URL=http://localhost:8000
```

When testing on a physical device with Expo Go, change `localhost` to your machine's LAN IP.

## Tests

Backend tests run against a live server (start it first):

```bash
cd backend
pytest tests/test_backend.py
```
