"""FastAPI application assembly: CORS, router registration, health checks."""
from fastapi import APIRouter, FastAPI
from starlette.middleware.cors import CORSMiddleware

from app.db import engine
from app.routers import ai, auth, business, catalog, customers, dashboard, estimates, expense_categories, expenses, invoices, vendors, webhooks

app = FastAPI(title="InvoiceAI API")
api = APIRouter(prefix="/api")

api.include_router(auth.router)
api.include_router(business.router)
api.include_router(customers.router)
api.include_router(vendors.router)
api.include_router(expense_categories.router)
api.include_router(expenses.router)
api.include_router(catalog.router)
api.include_router(invoices.router)
api.include_router(estimates.router)
api.include_router(dashboard.router)
api.include_router(ai.router)
api.include_router(webhooks.router)


@api.get("/health")
async def health():
    from sqlalchemy import text
    async with engine.connect() as conn:
        await conn.execute(text("SELECT 1"))
    from datetime import datetime, timezone
    return {"status": "ok", "ts": datetime.now(timezone.utc).isoformat()}


@api.get("/")
async def root():
    return {"service": "InvoiceAI API", "version": "1.0.0"}


app.include_router(api)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("shutdown")
async def shutdown():
    await engine.dispose()
