"""InvoiceAI backend - FastAPI + MongoDB.

All routes prefixed with /api. Uses JWT auth (HS256). All money stored as
integer minor units (cents). Every tenant-scoped query filters by business_id.
"""
from __future__ import annotations

import logging
import os
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, List, Optional

from anthropic import AsyncAnthropic
from clerk_backend_api import Clerk
from clerk_backend_api.security import (
    TokenVerificationError,
    VerifyTokenOptions,
    verify_token_async,
)
from dotenv import load_dotenv
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from motor.motor_asyncio import AsyncIOMotorClient
from passlib.context import CryptContext
from pymongo import ReturnDocument
from pydantic import BaseModel, EmailStr, Field
from starlette.middleware.cors import CORSMiddleware
import stripe

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ["DB_NAME"]
JWT_SECRET = os.environ.get("JWT_SECRET", "dev-secret-change-me-in-prod-invoiceai-32chars")
JWT_ALG = "HS256"
JWT_EXPIRES_MIN = 60 * 24 * 30  # 30 days
STRIPE_WEBHOOK_SECRET = os.environ.get("STRIPE_WEBHOOK_SECRET", "")
CLERK_SECRET_KEY = os.environ.get("CLERK_SECRET_KEY", "")
clerk_client = Clerk(bearer_auth=CLERK_SECRET_KEY)

client = AsyncIOMotorClient(MONGO_URL)
db = client[DB_NAME]

pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")
bearer_scheme = HTTPBearer(auto_error=False)

app = FastAPI(title="InvoiceAI API")
api = APIRouter(prefix="/api")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s - %(message)s")
log = logging.getLogger("invoiceai")

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_id() -> str:
    return str(uuid.uuid4())


def make_token(user_id: str, business_id: str) -> str:
    payload = {
        "sub": user_id,
        "biz": business_id,
        "exp": datetime.now(timezone.utc) + timedelta(minutes=JWT_EXPIRES_MIN),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALG)


def clean(doc: Optional[dict]) -> Optional[dict]:
    """Remove MongoDB _id from a doc so it's JSON-safe."""
    if doc is None:
        return None
    doc = {k: v for k, v in doc.items() if k != "_id"}
    return doc


async def get_current_user(
    creds: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
) -> dict:
    if not creds or not creds.credentials:
        raise HTTPException(status_code=401, detail="Missing bearer token")
    try:
        payload = jwt.decode(creds.credentials, JWT_SECRET, algorithms=[JWT_ALG])
        user_id = payload.get("sub")
        biz_id = payload.get("biz")
        if not user_id or not biz_id:
            raise HTTPException(status_code=401, detail="Invalid token payload")
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    user = await db.users.find_one({"id": user_id})
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return {"user": clean(user), "business_id": biz_id}


async def get_business(ctx: dict = Depends(get_current_user)) -> dict:
    biz = await db.businesses.find_one({"id": ctx["business_id"]})
    if not biz:
        raise HTTPException(status_code=404, detail="Business not found")
    return {"user": ctx["user"], "business": clean(biz)}


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------
class RegisterIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=6)
    business_name: str = Field(min_length=1)


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"


class MeOut(BaseModel):
    id: str
    email: str
    business_id: str
    name: Optional[str] = None


class BusinessUpdate(BaseModel):
    name: Optional[str] = None
    legal_name: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    website: Optional[str] = None
    logo_url: Optional[str] = None
    address_line1: Optional[str] = None
    city: Optional[str] = None
    region: Optional[str] = None
    postal_code: Optional[str] = None
    country: Optional[str] = None
    currency: Optional[str] = None
    tax_numbers: Optional[List[dict]] = None
    invoice_prefix: Optional[str] = None
    default_terms: Optional[str] = None
    default_due_days: Optional[int] = None
    onboarded: Optional[bool] = None


class SettingsUpdate(BaseModel):
    anthropic_api_key: Optional[str] = None
    stripe_payment_url_default: Optional[str] = None
    plan: Optional[str] = None  # FREE | STARTER | PRO


class CustomerIn(BaseModel):
    name: str
    email: Optional[EmailStr] = None
    phone: Optional[str] = None
    company: Optional[str] = None
    address_line1: Optional[str] = None
    city: Optional[str] = None
    region: Optional[str] = None
    postal_code: Optional[str] = None
    country: Optional[str] = None
    notes: Optional[str] = None


class CatalogItemIn(BaseModel):
    name: str
    description: Optional[str] = None
    unit_price_cents: int = Field(ge=0)
    currency: Optional[str] = None
    unit: Optional[str] = None
    tax_percent: float = Field(default=0, ge=0, le=100)


class LineItem(BaseModel):
    name: str
    description: Optional[str] = None
    quantity: float = Field(gt=0)
    unit_price_cents: int = Field(ge=0)
    tax_percent: float = Field(default=0, ge=0, le=100)


class InvoiceIn(BaseModel):
    customer_id: str
    issue_date: Optional[str] = None
    due_date: Optional[str] = None
    line_items: List[LineItem]
    discount_type: Optional[str] = None  # PERCENT | FIXED
    discount_value: Optional[int] = 0  # percent basis points (100 = 1%) OR cents
    notes: Optional[str] = None
    terms: Optional[str] = None
    stripe_payment_url: Optional[str] = None
    ai_source_text: Optional[str] = None
    status: Optional[str] = "DRAFT"


class AIExtractIn(BaseModel):
    text: str


class MarkPaidIn(BaseModel):
    amount_cents: Optional[int] = None  # if omitted, mark full paid
    method: str = "manual"


# ---------------------------------------------------------------------------
# Totals engine (single source of truth)
# ---------------------------------------------------------------------------
def compute_totals(
    line_items: List[dict],
    discount_type: Optional[str] = None,
    discount_value: int = 0,
) -> dict:
    subtotal = 0
    tax_total = 0
    tax_breakdown: dict = {}
    line_totals = []

    for li in line_items:
        qty = float(li.get("quantity", 1))
        unit_price = int(li.get("unit_price_cents", 0))
        line_subtotal = round(qty * unit_price)
        tax_pct = float(li.get("tax_percent", 0) or 0)
        line_tax = round(line_subtotal * tax_pct / 100)
        subtotal += line_subtotal
        tax_total += line_tax
        if tax_pct > 0:
            key = f"{tax_pct}"
            tax_breakdown[key] = tax_breakdown.get(key, 0) + line_tax
        line_totals.append(line_subtotal + line_tax)

    discount_cents = 0
    if discount_type == "PERCENT" and discount_value:
        # discount_value is basis points (1000 = 10%)
        discount_cents = round(subtotal * (discount_value / 10000))
    elif discount_type == "FIXED" and discount_value:
        discount_cents = int(discount_value)

    total = subtotal + tax_total - discount_cents
    if total < 0:
        total = 0

    return {
        "subtotal_cents": subtotal,
        "tax_total_cents": tax_total,
        "tax_breakdown": [{"percent": float(k), "amount_cents": v} for k, v in tax_breakdown.items()],
        "discount_cents": discount_cents,
        "total_cents": total,
    }


# ---------------------------------------------------------------------------
# Plan limits
# ---------------------------------------------------------------------------
PLAN_LIMITS = {
    "FREE": {"scope": "lifetime", "limit": 5},
    "STARTER": {"scope": "month", "limit": 10},
    "PRO": {"scope": "month", "limit": 50},
}

PLAN_META = {
    "FREE":    {"label": "Free",    "price_cents": 0,   "price_label": "$0",     "description": "5 invoices lifetime"},
    "STARTER": {"label": "Starter", "price_cents": 100, "price_label": "$1/mo",  "description": "10 invoices per month"},
    "PRO":     {"label": "Pro",     "price_cents": 500, "price_label": "$5/mo",  "description": "50 invoices per month"},
}


def _plan_upgrade_url(plan: str) -> Optional[str]:
    if plan == "STARTER":
        return os.environ.get("STRIPE_STARTER_URL") or None
    if plan == "PRO":
        return os.environ.get("STRIPE_PRO_URL") or None
    return None


async def check_plan_limit(business_id: str, plan: str) -> dict:
    cfg = PLAN_LIMITS.get(plan, PLAN_LIMITS["FREE"])
    if cfg["scope"] == "lifetime":
        used = await db.invoices.count_documents({"business_id": business_id})
    else:
        month_start = datetime.now(timezone.utc).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        used = await db.invoices.count_documents(
            {"business_id": business_id, "created_at_dt": {"$gte": month_start}}
        )
    return {"used": used, "limit": cfg["limit"], "scope": cfg["scope"], "over": used >= cfg["limit"]}


# ---------------------------------------------------------------------------
# Plans
# ---------------------------------------------------------------------------
@api.get("/plans")
async def list_plans(ctx: dict = Depends(get_business)):
    """Public plan catalog + current plan usage. Includes per-plan Stripe upgrade URLs."""
    biz = ctx["business"]
    current = biz.get("plan", "FREE")
    plans = []
    for key, meta in PLAN_META.items():
        plans.append({
            "key": key,
            **meta,
            "limit": PLAN_LIMITS[key]["limit"],
            "scope": PLAN_LIMITS[key]["scope"],
            "is_current": key == current,
            "upgrade_url": _plan_upgrade_url(key),
        })
    return {
        "current": current,
        "plans": plans,
        "usage": await check_plan_limit(biz["id"], current),
    }


# ---------------------------------------------------------------------------
# Auth routes
# ---------------------------------------------------------------------------
async def _create_business_and_user(
    email: str,
    business_name: str,
    password_hash: Optional[str],
    clerk_user_id: Optional[str] = None,
) -> tuple[str, str]:
    """Create a new business + owner user. Returns (user_id, business_id).

    Shared by /auth/register (password_hash set, clerk_user_id=None) and the
    Clerk exchange path (password_hash=None, clerk_user_id set) so both flows
    can't drift out of sync.
    """
    business_id = new_id()
    user_id = new_id()
    now = datetime.now(timezone.utc)

    business = {
        "id": business_id,
        "owner_user_id": user_id,
        "name": business_name,
        "legal_name": None,
        "email": email,
        "phone": None,
        "website": None,
        "logo_url": None,
        "address_line1": None,
        "city": None,
        "region": None,
        "postal_code": None,
        "country": "US",
        "currency": "USD",
        "tax_numbers": [],
        "invoice_prefix": "INV",
        "next_invoice_no": 1,
        "default_terms": "Payment due within 14 days.",
        "default_due_days": 14,
        "plan": "FREE",
        "anthropic_api_key": None,
        "stripe_payment_url_default": None,
        "onboarded": False,
        "created_at": now.isoformat(),
    }
    user = {
        "id": user_id,
        "email": email,
        "password_hash": password_hash,
        "business_id": business_id,
        "name": None,
        "role": "OWNER",
        "clerk_user_id": clerk_user_id,
        "created_at": now.isoformat(),
    }
    await db.businesses.insert_one(business)
    await db.users.insert_one(user)
    return user_id, business_id


@api.post("/auth/register", response_model=TokenOut)
async def register(payload: RegisterIn):
    existing = await db.users.find_one({"email": payload.email.lower()})
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")
    user_id, business_id = await _create_business_and_user(
        email=payload.email.lower(),
        business_name=payload.business_name,
        password_hash=pwd_ctx.hash(payload.password),
    )
    return TokenOut(access_token=make_token(user_id, business_id))


@api.post("/auth/login", response_model=TokenOut)
async def login(payload: LoginIn):
    user = await db.users.find_one({"email": payload.email.lower()})
    if not user:
        raise HTTPException(status_code=400, detail="Invalid email or password")
    if not user.get("password_hash"):
        raise HTTPException(
            status_code=400,
            detail="This account uses Google sign-in. Continue with Google instead.",
        )
    if not pwd_ctx.verify(payload.password, user["password_hash"]):
        raise HTTPException(status_code=400, detail="Invalid email or password")
    return TokenOut(access_token=make_token(user["id"], user["business_id"]))


@api.get("/auth/me", response_model=MeOut)
async def me(ctx: dict = Depends(get_current_user)):
    u = ctx["user"]
    return MeOut(id=u["id"], email=u["email"], business_id=u["business_id"], name=u.get("name"))


# ---------------------------------------------------------------------------
# Business routes
# ---------------------------------------------------------------------------
@api.get("/business/me")
async def get_my_business(ctx: dict = Depends(get_business)):
    biz = ctx["business"]
    # Never expose the anthropic key in full; return only whether it's set.
    biz["has_anthropic_key"] = bool(biz.get("anthropic_api_key"))
    biz.pop("anthropic_api_key", None)
    return biz


@api.patch("/business/me")
async def update_my_business(payload: BusinessUpdate, ctx: dict = Depends(get_business)):
    biz_id = ctx["business"]["id"]
    update = {k: v for k, v in payload.model_dump(exclude_unset=True).items()}
    if update:
        update["updated_at"] = now_iso()
        await db.businesses.update_one({"id": biz_id}, {"$set": update})
    biz = clean(await db.businesses.find_one({"id": biz_id}))
    biz["has_anthropic_key"] = bool(biz.get("anthropic_api_key"))
    biz.pop("anthropic_api_key", None)
    return biz


@api.patch("/settings")
async def update_settings(payload: SettingsUpdate, ctx: dict = Depends(get_business)):
    biz_id = ctx["business"]["id"]
    update = {k: v for k, v in payload.model_dump(exclude_unset=True).items() if v is not None}
    if "plan" in update and update["plan"] not in PLAN_LIMITS:
        raise HTTPException(status_code=400, detail="Invalid plan")
    if update:
        update["updated_at"] = now_iso()
        await db.businesses.update_one({"id": biz_id}, {"$set": update})
    biz = clean(await db.businesses.find_one({"id": biz_id}))
    biz["has_anthropic_key"] = bool(biz.get("anthropic_api_key"))
    biz.pop("anthropic_api_key", None)
    return biz


# ---------------------------------------------------------------------------
# Customers
# ---------------------------------------------------------------------------
@api.get("/customers")
async def list_customers(ctx: dict = Depends(get_business), q: Optional[str] = None):
    biz_id = ctx["business"]["id"]
    query: dict = {"business_id": biz_id, "archived": {"$ne": True}}
    if q:
        query["$or"] = [
            {"name": {"$regex": q, "$options": "i"}},
            {"email": {"$regex": q, "$options": "i"}},
            {"company": {"$regex": q, "$options": "i"}},
        ]
    docs = await db.customers.find(query).sort("name", 1).to_list(500)
    return [clean(d) for d in docs]


@api.post("/customers")
async def create_customer(payload: CustomerIn, ctx: dict = Depends(get_business)):
    biz_id = ctx["business"]["id"]
    doc = {
        "id": new_id(),
        "business_id": biz_id,
        **payload.model_dump(),
        "archived": False,
        "created_at": now_iso(),
    }
    await db.customers.insert_one(doc)
    return clean(doc)


@api.get("/customers/{customer_id}")
async def get_customer(customer_id: str, ctx: dict = Depends(get_business)):
    biz_id = ctx["business"]["id"]
    doc = await db.customers.find_one({"id": customer_id, "business_id": biz_id})
    if not doc:
        raise HTTPException(status_code=404, detail="Customer not found")
    result = clean(doc)
    # Include invoice history + lifetime revenue
    invs = await db.invoices.find({"business_id": biz_id, "customer_id": customer_id}).to_list(500)
    result["invoices"] = [clean(i) for i in invs]
    result["lifetime_revenue_cents"] = sum(int(i.get("amount_paid_cents", 0)) for i in invs)
    return result


@api.patch("/customers/{customer_id}")
async def update_customer(customer_id: str, payload: CustomerIn, ctx: dict = Depends(get_business)):
    biz_id = ctx["business"]["id"]
    update = payload.model_dump()
    update["updated_at"] = now_iso()
    res = await db.customers.update_one(
        {"id": customer_id, "business_id": biz_id}, {"$set": update}
    )
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Customer not found")
    doc = await db.customers.find_one({"id": customer_id})
    return clean(doc)


@api.delete("/customers/{customer_id}")
async def archive_customer(customer_id: str, ctx: dict = Depends(get_business)):
    biz_id = ctx["business"]["id"]
    await db.customers.update_one(
        {"id": customer_id, "business_id": biz_id}, {"$set": {"archived": True}}
    )
    return {"ok": True}


# ---------------------------------------------------------------------------
# Catalog
# ---------------------------------------------------------------------------
@api.get("/catalog")
async def list_catalog(ctx: dict = Depends(get_business)):
    biz_id = ctx["business"]["id"]
    docs = await db.catalog_items.find(
        {"business_id": biz_id, "archived": {"$ne": True}}
    ).sort("name", 1).to_list(500)
    return [clean(d) for d in docs]


@api.post("/catalog")
async def create_catalog_item(payload: CatalogItemIn, ctx: dict = Depends(get_business)):
    biz = ctx["business"]
    data = payload.model_dump()
    data["currency"] = data.get("currency") or biz.get("currency", "USD")
    doc = {
        "id": new_id(),
        "business_id": biz["id"],
        **data,
        "archived": False,
        "created_at": now_iso(),
    }
    await db.catalog_items.insert_one(doc)
    return clean(doc)


@api.patch("/catalog/{item_id}")
async def update_catalog_item(item_id: str, payload: CatalogItemIn, ctx: dict = Depends(get_business)):
    biz_id = ctx["business"]["id"]
    update = payload.model_dump()
    update["updated_at"] = now_iso()
    res = await db.catalog_items.update_one(
        {"id": item_id, "business_id": biz_id}, {"$set": update}
    )
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Item not found")
    doc = await db.catalog_items.find_one({"id": item_id})
    return clean(doc)


@api.delete("/catalog/{item_id}")
async def delete_catalog_item(item_id: str, ctx: dict = Depends(get_business)):
    biz_id = ctx["business"]["id"]
    await db.catalog_items.update_one(
        {"id": item_id, "business_id": biz_id}, {"$set": {"archived": True}}
    )
    return {"ok": True}


# ---------------------------------------------------------------------------
# Invoices
# ---------------------------------------------------------------------------
async def _serialize_invoice(inv: dict) -> dict:
    """Attach customer summary to an invoice for list/detail views."""
    inv = clean(inv)
    cust = await db.customers.find_one(
        {"id": inv["customer_id"], "business_id": inv["business_id"]}
    )
    inv["customer"] = clean(cust) if cust else None
    return inv


@api.get("/invoices")
async def list_invoices(
    ctx: dict = Depends(get_business),
    status_filter: Optional[str] = None,
    q: Optional[str] = None,
):
    biz_id = ctx["business"]["id"]
    query: dict = {"business_id": biz_id}
    if status_filter and status_filter.upper() != "ALL":
        query["status"] = status_filter.upper()
    docs = await db.invoices.find(query).sort("created_at", -1).to_list(500)
    results = []
    for d in docs:
        item = await _serialize_invoice(d)
        if q:
            hay = " ".join(
                [item.get("number") or "", (item.get("customer") or {}).get("name") or ""]
            ).lower()
            if q.lower() not in hay:
                continue
        results.append(item)
    return results


@api.get("/invoices/{invoice_id}")
async def get_invoice(invoice_id: str, ctx: dict = Depends(get_business)):
    biz_id = ctx["business"]["id"]
    doc = await db.invoices.find_one({"id": invoice_id, "business_id": biz_id})
    if not doc:
        raise HTTPException(status_code=404, detail="Invoice not found")
    return await _serialize_invoice(doc)


@api.post("/invoices")
async def create_invoice(payload: InvoiceIn, ctx: dict = Depends(get_business)):
    biz = ctx["business"]
    biz_id = biz["id"]

    # Plan limit check
    plan_status = await check_plan_limit(biz_id, biz.get("plan", "FREE"))
    if plan_status["over"]:
        raise HTTPException(
            status_code=402,
            detail={
                "error": "PLAN_LIMIT_REACHED",
                "message": f"Your {biz.get('plan', 'FREE')} plan allows {plan_status['limit']} invoices per {plan_status['scope']}. Upgrade to create more.",
                **plan_status,
            },
        )

    # Verify customer belongs to business
    cust = await db.customers.find_one({"id": payload.customer_id, "business_id": biz_id})
    if not cust:
        raise HTTPException(status_code=400, detail="Customer not found for this business")

    # Atomic invoice numbering
    updated = await db.businesses.find_one_and_update(
        {"id": biz_id},
        {"$inc": {"next_invoice_no": 1}},
        return_document=ReturnDocument.AFTER,
    )
    seq = updated["next_invoice_no"] - 1
    prefix = biz.get("invoice_prefix", "INV")
    number = f"{prefix}-{str(seq).zfill(4)}"

    line_items = [li.model_dump() for li in payload.line_items]
    totals = compute_totals(line_items, payload.discount_type, payload.discount_value or 0)

    now = datetime.now(timezone.utc)
    issue = payload.issue_date or now.date().isoformat()
    due = payload.due_date or (now + timedelta(days=biz.get("default_due_days", 14))).date().isoformat()

    doc = {
        "id": new_id(),
        "business_id": biz_id,
        "customer_id": payload.customer_id,
        "number": number,
        "status": (payload.status or "DRAFT").upper(),
        "currency": biz.get("currency", "USD"),
        "issue_date": issue,
        "due_date": due,
        "line_items": line_items,
        "discount_type": payload.discount_type,
        "discount_value": payload.discount_value or 0,
        **totals,
        "amount_paid_cents": 0,
        "notes": payload.notes,
        "terms": payload.terms or biz.get("default_terms"),
        "stripe_payment_url": payload.stripe_payment_url or biz.get("stripe_payment_url_default"),
        "ai_source_text": payload.ai_source_text,
        "sent_at": None,
        "paid_at": None,
        "created_at": now.isoformat(),
        "created_at_dt": now,
        "updated_at": now.isoformat(),
    }
    await db.invoices.insert_one(doc)
    return await _serialize_invoice(doc)


@api.patch("/invoices/{invoice_id}")
async def update_invoice(invoice_id: str, payload: InvoiceIn, ctx: dict = Depends(get_business)):
    biz = ctx["business"]
    biz_id = biz["id"]
    existing = await db.invoices.find_one({"id": invoice_id, "business_id": biz_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Invoice not found")
    if existing["status"] not in ("DRAFT",):
        raise HTTPException(status_code=400, detail="Only DRAFT invoices can be edited")

    line_items = [li.model_dump() for li in payload.line_items]
    totals = compute_totals(line_items, payload.discount_type, payload.discount_value or 0)
    update = {
        "customer_id": payload.customer_id,
        "line_items": line_items,
        "discount_type": payload.discount_type,
        "discount_value": payload.discount_value or 0,
        **totals,
        "notes": payload.notes,
        "terms": payload.terms,
        "stripe_payment_url": payload.stripe_payment_url,
        "issue_date": payload.issue_date or existing["issue_date"],
        "due_date": payload.due_date or existing["due_date"],
        "updated_at": now_iso(),
    }
    await db.invoices.update_one({"id": invoice_id}, {"$set": update})
    doc = await db.invoices.find_one({"id": invoice_id})
    return await _serialize_invoice(doc)


@api.post("/invoices/{invoice_id}/mark-paid")
async def mark_paid(invoice_id: str, payload: MarkPaidIn, ctx: dict = Depends(get_business)):
    biz_id = ctx["business"]["id"]
    inv = await db.invoices.find_one({"id": invoice_id, "business_id": biz_id})
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")

    amount = payload.amount_cents if payload.amount_cents is not None else (inv["total_cents"] - inv.get("amount_paid_cents", 0))
    if amount <= 0:
        raise HTTPException(status_code=400, detail="Amount must be greater than zero")

    new_paid = inv.get("amount_paid_cents", 0) + amount
    if new_paid >= inv["total_cents"]:
        new_status = "PAID"
        paid_at = now_iso()
    else:
        new_status = "PARTIALLY_PAID"
        paid_at = inv.get("paid_at")

    payment = {
        "id": new_id(),
        "invoice_id": invoice_id,
        "business_id": biz_id,
        "amount_cents": amount,
        "method": payload.method,
        "paid_at": now_iso(),
    }
    await db.payments.insert_one(payment)
    await db.invoices.update_one(
        {"id": invoice_id},
        {"$set": {"amount_paid_cents": new_paid, "status": new_status, "paid_at": paid_at, "updated_at": now_iso()}},
    )
    doc = await db.invoices.find_one({"id": invoice_id})
    return await _serialize_invoice(doc)


@api.post("/invoices/{invoice_id}/send")
async def mark_sent(invoice_id: str, ctx: dict = Depends(get_business)):
    """Mark an invoice as SENT (client-side share triggered this call)."""
    biz_id = ctx["business"]["id"]
    inv = await db.invoices.find_one({"id": invoice_id, "business_id": biz_id})
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")
    if inv["status"] == "DRAFT":
        await db.invoices.update_one(
            {"id": invoice_id},
            {"$set": {"status": "SENT", "sent_at": now_iso(), "updated_at": now_iso()}},
        )
    doc = await db.invoices.find_one({"id": invoice_id})
    return await _serialize_invoice(doc)


@api.post("/invoices/{invoice_id}/void")
async def void_invoice(invoice_id: str, ctx: dict = Depends(get_business)):
    biz_id = ctx["business"]["id"]
    inv = await db.invoices.find_one({"id": invoice_id, "business_id": biz_id})
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")
    if inv["status"] == "PAID":
        raise HTTPException(status_code=400, detail="Cannot void a paid invoice")
    await db.invoices.update_one(
        {"id": invoice_id},
        {"$set": {"status": "VOID", "voided_at": now_iso(), "updated_at": now_iso()}},
    )
    doc = await db.invoices.find_one({"id": invoice_id})
    return await _serialize_invoice(doc)


@api.post("/invoices/{invoice_id}/duplicate")
async def duplicate_invoice(invoice_id: str, ctx: dict = Depends(get_business)):
    biz = ctx["business"]
    biz_id = biz["id"]
    inv = await db.invoices.find_one({"id": invoice_id, "business_id": biz_id})
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")

    plan_status = await check_plan_limit(biz_id, biz.get("plan", "FREE"))
    if plan_status["over"]:
        raise HTTPException(status_code=402, detail={"error": "PLAN_LIMIT_REACHED", **plan_status})

    updated = await db.businesses.find_one_and_update(
        {"id": biz_id}, {"$inc": {"next_invoice_no": 1}}, return_document=ReturnDocument.AFTER
    )
    seq = updated["next_invoice_no"] - 1
    number = f"{biz.get('invoice_prefix', 'INV')}-{str(seq).zfill(4)}"

    now = datetime.now(timezone.utc)
    doc = {
        **{k: v for k, v in inv.items() if k not in ("_id", "id", "number", "status", "sent_at", "paid_at", "amount_paid_cents", "created_at", "created_at_dt", "updated_at")},
        "id": new_id(),
        "number": number,
        "status": "DRAFT",
        "sent_at": None,
        "paid_at": None,
        "amount_paid_cents": 0,
        "created_at": now.isoformat(),
        "created_at_dt": now,
        "updated_at": now.isoformat(),
    }
    await db.invoices.insert_one(doc)
    return await _serialize_invoice(doc)


# ---------------------------------------------------------------------------
# Dashboard
# ---------------------------------------------------------------------------
@api.get("/dashboard/summary")
async def dashboard_summary(ctx: dict = Depends(get_business)):
    biz = ctx["business"]
    biz_id = biz["id"]
    now = datetime.now(timezone.utc)
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)

    invoices = await db.invoices.find({"business_id": biz_id}).to_list(2000)

    revenue_this_month = 0
    outstanding = 0
    overdue = 0
    total_paid = 0
    today = now.date().isoformat()

    for inv in invoices:
        paid = int(inv.get("amount_paid_cents", 0))
        total = int(inv.get("total_cents", 0))
        due_amt = total - paid
        # Revenue this month: payments whose paid_at is this month
        if inv.get("paid_at"):
            try:
                paid_dt = datetime.fromisoformat(inv["paid_at"].replace("Z", "+00:00"))
                if paid_dt.tzinfo is None:
                    paid_dt = paid_dt.replace(tzinfo=timezone.utc)
                if paid_dt >= month_start:
                    revenue_this_month += paid
            except Exception:
                pass
        if inv["status"] in ("SENT", "VIEWED", "PARTIALLY_PAID"):
            outstanding += due_amt
            if inv.get("due_date") and inv["due_date"] < today:
                overdue += due_amt
        total_paid += paid

    # 6-month revenue chart
    months = []
    for i in range(5, -1, -1):
        m = (month_start.month - i - 1) % 12 + 1
        y = month_start.year + ((month_start.month - i - 1) // 12)
        months.append({"year": y, "month": m, "revenue_cents": 0, "label": datetime(y, m, 1).strftime("%b")})
    for inv in invoices:
        if inv.get("paid_at"):
            try:
                d = datetime.fromisoformat(inv["paid_at"].replace("Z", "+00:00"))
                for mrec in months:
                    if d.year == mrec["year"] and d.month == mrec["month"]:
                        mrec["revenue_cents"] += int(inv.get("amount_paid_cents", 0))
                        break
            except Exception:
                pass

    plan_status = await check_plan_limit(biz_id, biz.get("plan", "FREE"))

    return {
        "currency": biz.get("currency", "USD"),
        "revenue_this_month_cents": revenue_this_month,
        "outstanding_cents": outstanding,
        "overdue_cents": overdue,
        "total_paid_cents": total_paid,
        "invoice_count": len(invoices),
        "chart_months": months,
        "plan": biz.get("plan", "FREE"),
        "plan_usage": plan_status,
    }


# ---------------------------------------------------------------------------
# AI extraction
# ---------------------------------------------------------------------------
EXTRACTION_TOOL = {
    "name": "draft_invoice",
    "description": "Extract a structured invoice draft from free text.",
    "input_schema": {
        "type": "object",
        "properties": {
            "customer_name": {"type": "string", "description": "Best-match name from known customers, or a new customer name if none match."},
            "customer_is_new": {"type": "boolean", "description": "True if no confident match with existing customer."},
            "line_items": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string"},
                        "description": {"type": "string"},
                        "quantity": {"type": "number"},
                        "unit_price_cents": {"type": "integer", "description": "Unit price in minor units (cents). E.g. $95.00 = 9500."},
                        "tax_percent": {"type": "number"},
                    },
                    "required": ["name", "quantity", "unit_price_cents"],
                },
            },
            "issue_date": {"type": "string", "description": "ISO YYYY-MM-DD. If not stated, use today."},
            "due_date": {"type": "string", "description": "ISO YYYY-MM-DD. If not stated, use today + default_due_days."},
            "notes": {"type": "string"},
            "warnings": {"type": "array", "items": {"type": "string"}, "description": "Ambiguities the human should verify."},
        },
        "required": ["customer_name", "line_items"],
    },
}


@api.post("/ai/extract-invoice")
async def ai_extract_invoice(payload: AIExtractIn, ctx: dict = Depends(get_business)):
    biz = await db.businesses.find_one({"id": ctx["business"]["id"]})
    api_key = biz.get("anthropic_api_key") if biz else None
    if not api_key:
        raise HTTPException(
            status_code=400,
            detail="Anthropic API key not configured. Add it in Settings.",
        )

    customers = await db.customers.find(
        {"business_id": biz["id"], "archived": {"$ne": True}}
    ).to_list(200)
    catalog = await db.catalog_items.find(
        {"business_id": biz["id"], "archived": {"$ne": True}}
    ).to_list(200)
    known_customers = [{"name": c["name"], "email": c.get("email")} for c in customers[:100]]
    known_catalog = [
        {"name": c["name"], "unit_price_cents": c["unit_price_cents"], "unit": c.get("unit")}
        for c in catalog[:100]
    ]

    today = datetime.now(timezone.utc).date().isoformat()
    system_prompt = (
        f"You extract structured invoice drafts from free text. Today is {today}. "
        f"Business default currency: {biz.get('currency', 'USD')}. "
        f"Default due days: {biz.get('default_due_days', 14)}.\n"
        f"Known customers: {known_customers}\n"
        f"Known catalog items: {known_catalog}\n"
        "Rules:\n"
        "- Match customer to known customers by fuzzy name; if no match, set customer_is_new=true.\n"
        "- Match line items to catalog names when similar; otherwise create free-form items.\n"
        "- Amounts in MINOR UNITS (cents). Never invent prices not stated or in the catalog.\n"
        "- If due date not stated, set issue_date=today and due_date = today + default_due_days.\n"
        "- List ambiguities in warnings[]."
    )

    client_ai = AsyncAnthropic(api_key=api_key)
    try:
        resp = await client_ai.messages.create(
            model="claude-sonnet-4-5",
            max_tokens=2048,
            system=system_prompt,
            tools=[EXTRACTION_TOOL],
            tool_choice={"type": "tool", "name": "draft_invoice"},
            messages=[{"role": "user", "content": payload.text[:4000]}],
        )
    except Exception as e:
        log.exception("Anthropic call failed")
        raise HTTPException(status_code=502, detail=f"AI extraction failed: {e}")

    extracted: Any = None
    for block in resp.content:
        if getattr(block, "type", None) == "tool_use":
            extracted = block.input
            break
    if not extracted:
        raise HTTPException(status_code=500, detail="AI returned no structured data")
    return {"draft": extracted}


# ---------------------------------------------------------------------------
# Stripe webhook (public, signature-verified, idempotent)
# ---------------------------------------------------------------------------
VALID_PLANS = {"FREE", "STARTER", "PRO"}


@api.post("/webhooks/stripe")
async def stripe_webhook(request: Request):
    """Handle Stripe events for automatic plan activation/deactivation.

    Payment Links redirect back with client_reference_id = "PLAN.BUSINESS_ID".
    We flip business.plan on checkout.session.completed and downgrade to FREE
    on customer.subscription.deleted. All events are deduped via WebhookEvent.
    """
    if not STRIPE_WEBHOOK_SECRET:
        raise HTTPException(
            status_code=503,
            detail="Stripe webhook secret not configured. Set STRIPE_WEBHOOK_SECRET.",
        )

    # MUST read raw body BEFORE any JSON parsing for signature verification.
    payload = await request.body()
    sig_header = request.headers.get("stripe-signature")
    if not sig_header:
        raise HTTPException(status_code=400, detail="Missing stripe-signature header")

    try:
        event = stripe.Webhook.construct_event(payload, sig_header, STRIPE_WEBHOOK_SECRET)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid payload")
    except stripe.SignatureVerificationError:
        raise HTTPException(status_code=400, detail="Invalid signature")

    event_id = event["id"]
    event_type = event["type"]
    obj = event["data"]["object"]

    # Idempotency dedupe — process each Stripe event exactly once.
    if await db.webhook_events.find_one({"id": event_id}):
        return {"status": "ok", "message": "duplicate"}

    log.info("Stripe webhook received: %s (%s)", event_type, event_id)

    if event_type == "checkout.session.completed":
        client_ref = obj.get("client_reference_id") or ""
        customer_id = obj.get("customer")
        subscription_id = obj.get("subscription")
        if "." in client_ref:
            plan, biz_id = client_ref.split(".", 1)
            plan = plan.upper()
            if plan in VALID_PLANS and biz_id:
                update: dict = {
                    "plan": plan,
                    "updated_at": now_iso(),
                }
                if customer_id:
                    update["stripe_customer_id"] = customer_id
                if subscription_id:
                    update["stripe_subscription_id"] = subscription_id
                res = await db.businesses.update_one({"id": biz_id}, {"$set": update})
                log.info(
                    "checkout.session.completed → business=%s plan=%s matched=%s",
                    biz_id, plan, res.matched_count,
                )
            else:
                log.warning("Ignoring session with malformed client_reference_id=%r", client_ref)
        else:
            log.warning("checkout.session.completed missing client_reference_id")

    elif event_type == "customer.subscription.deleted":
        # Subscription cancellation events don't include client_reference_id;
        # look the business up by the stripe_customer_id we stored on checkout.
        customer_id = obj.get("customer")
        if customer_id:
            res = await db.businesses.update_one(
                {"stripe_customer_id": customer_id},
                {"$set": {"plan": "FREE", "updated_at": now_iso()}},
            )
            log.info(
                "customer.subscription.deleted → customer=%s matched=%s",
                customer_id, res.matched_count,
            )

    elif event_type == "invoice.payment_failed":
        # Non-fatal: log for observability, keep plan as-is.
        log.warning("Stripe invoice.payment_failed for customer=%s", obj.get("customer"))

    # Persist the processed event id LAST so a mid-processing crash retries safely.
    await db.webhook_events.insert_one({
        "id": event_id,
        "type": event_type,
        "processed_at": now_iso(),
    })

    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------
@api.get("/health")
async def health():
    try:
        await db.command("ping")
        return {"status": "ok", "ts": now_iso()}
    except Exception as e:
        raise HTTPException(status_code=503, detail=str(e))


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
    client.close()
