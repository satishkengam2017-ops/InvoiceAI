# MongoDB → Supabase Postgres Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace InvoiceAI's MongoDB data layer with Supabase Postgres (SQLAlchemy async + asyncpg), splitting `backend/server.py` into focused modules, with zero behavior change to auth, business logic, or the frontend.

**Architecture:** One SQLAlchemy model per current MongoDB collection (8 tables total, with `line_items` and `tax_numbers` as proper child tables instead of embedded arrays). Routes move from one 1183-line file into `backend/app/routers/*.py`, grouped exactly along the current file's existing section boundaries. Alembic manages schema versioning. Multi-tenant isolation (`business_id` filtering) stays enforced in Python, in every query, exactly as today.

**Tech Stack:** FastAPI (unchanged), SQLAlchemy 2.0 (async ORM), asyncpg (driver), Alembic (migrations), Supabase (hosted Postgres). Removes: `motor`, `pymongo`.

## Global Constraints

- Fresh start: no data-migration script. The new schema is created empty (per the approved design spec).
- `business_id` tenant filtering stays enforced in application code, in every query — never Postgres Row Level Security.
- `line_items` and `tax_numbers` are relational child tables, never JSONB. `tax_breakdown` stays a Python-computed value in the API response, never a stored column.
- All IDs are app-generated UUIDv4 strings (`str(uuid.uuid4())`), matching today's convention exactly — JWTs already embed these as strings and must not change shape.
- **Corrected during Task 3** (verified live against Supabase, commits `c18467f` and a follow-up wording fix): `DATABASE_URL` and `DATABASE_URL_DIRECT` both use Supabase's **session-mode pooler** (port 5432, `*.pooler.supabase.com`) — not the transaction-mode pooler (port 6543, same host) originally specified for `DATABASE_URL`. Note this is still Supavisor (Supabase's pooler), not a true unpooled direct connection (`db.<project-ref>.supabase.co`) — that genuine direct endpoint needs IPv6 reachability, unconfirmed for this app's eventual deployment target, so it's deliberately not used. Transaction-mode pooling is incompatible with SQLAlchemy's asyncpg dialect: its automatic JSON codec setup runs on every new connection using asyncpg's own internal, deterministic prepared-statement naming, and transaction mode can reassign the physical backend connection between statements, causing that name to collide with another session's prepared statement (`DuplicatePreparedStatementError`). This isn't fixable via SQLAlchemy's documented PgBouncer workaround (`NullPool` + `prepared_statement_name_func`), since the codec setup bypasses that override path entirely. Session mode holds one dedicated backend connection for the client session's lifetime, avoiding the reassignment that causes the collision.
- Auth (custom JWT + Clerk exchange) and all business logic (`compute_totals`, plan limits, Stripe webhook handling, Clerk account-linking) must produce byte-identical API responses to today — only the storage layer changes.
- Every task's tests must pass against a real running Postgres (Supabase project, or local Postgres for dev/CI) before moving to the next task.

---

## Task 1: Database engine, session, and Alembic scaffolding

**Files:**
- Create: `backend/app/__init__.py` (empty)
- Create: `backend/app/db.py`
- Create: `backend/alembic.ini`
- Create: `backend/alembic/env.py`
- Create: `backend/alembic/script.py.mako`
- Modify: `backend/requirements.txt`
- Modify: `backend/.env` (add `DATABASE_URL`, `DATABASE_URL_DIRECT`)

**Interfaces:**
- Produces: `Base` (SQLAlchemy declarative base, `app.db.Base`), `engine` (async engine, `app.db.engine`), `get_db()` (FastAPI dependency yielding `AsyncSession`, `app.db.get_db`), `to_dict(obj) -> dict` (converts an ORM instance to a plain dict of its columns, `app.db.to_dict`) — used by every later task.

- [ ] **Step 1: Add dependencies**

Add to `backend/requirements.txt` (remove the `motor` and `pymongo` lines; keep everything else):

```
sqlalchemy[asyncio]==2.0.36
asyncpg==0.30.0
alembic==1.14.0
```

- [ ] **Step 2: Add the two new env vars**

Get your Supabase project's connection strings from Supabase Dashboard → Project Settings → Database → Connection string. Add to `backend/.env` (replacing `MONGO_URL`/`DB_NAME` — do not delete them yet, Task 12 removes the old ones once the cutover is verified):

```
DATABASE_URL=postgresql+asyncpg://postgres.xxxxx:PASSWORD@aws-0-region.pooler.supabase.com:6543/postgres
DATABASE_URL_DIRECT=postgresql+asyncpg://postgres.xxxxx:PASSWORD@aws-0-region.pooler.supabase.com:5432/postgres
```

(Replace `xxxxx`, `PASSWORD`, and `region` with your actual project's values — never paste the real password into chat; edit the file directly.)

- [ ] **Step 3: Write db.py**

Create `backend/app/db.py`:

```python
"""Async SQLAlchemy engine, session factory, and shared helpers."""
import os
from typing import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

DATABASE_URL = os.environ["DATABASE_URL"]

engine = create_async_engine(DATABASE_URL, pool_pre_ping=True)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with SessionLocal() as session:
        yield session


def to_dict(obj) -> dict:
    """Convert a SQLAlchemy ORM instance to a plain dict of its own columns
    (no relationships) — the Postgres equivalent of the old clean() helper
    that stripped MongoDB's _id. Used throughout the routers to build JSON
    responses exactly like the dict-based Mongo documents did.
    """
    return {c.name: getattr(obj, c.name) for c in obj.__table__.columns}
```

- [ ] **Step 4: Create Alembic scaffolding**

Run from `backend/`:
```bash
cd backend
.venv\Scripts\pip.exe install -r requirements.txt
.venv\Scripts\python.exe -m alembic init alembic
```

This creates `backend/alembic/`, `backend/alembic.ini`, `backend/alembic/env.py`, `backend/alembic/script.py.mako`. Now edit the generated `backend/alembic/env.py`, replacing its contents with:

```python
import asyncio
import os
import sys
from pathlib import Path
from logging.config import fileConfig

from sqlalchemy.ext.asyncio import create_async_engine

from alembic import context

sys.path.insert(0, str(Path(__file__).parent.parent))
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent.parent / ".env")

from app.db import Base
import app.models  # noqa: F401 — registers all models on Base.metadata

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata

DATABASE_URL_DIRECT = os.environ["DATABASE_URL_DIRECT"]


def run_migrations_offline() -> None:
    context.configure(
        url=DATABASE_URL_DIRECT,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection) -> None:
    context.configure(connection=connection, target_metadata=target_metadata)
    with context.begin_transaction():
        context.run_migrations()


async def run_migrations_online() -> None:
    connectable = create_async_engine(DATABASE_URL_DIRECT)
    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)
    await connectable.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    asyncio.run(run_migrations_online())
```

(`app.models` doesn't exist yet — Task 2 creates it. This file is written now so Task 2 can immediately generate a migration against it.)

- [ ] **Step 5: Verify Alembic can connect**

Run:
```bash
cd backend
.venv\Scripts\python.exe -m alembic current
```
Expected: no error (prints nothing or a blank current revision) — confirms `DATABASE_URL_DIRECT` is valid and reachable. If this fails with a connection error, double-check the connection string in `.env` before proceeding (nothing to commit yet if it fails — fix and retry).

- [ ] **Step 6: Commit**

```bash
git add backend/requirements.txt backend/app/__init__.py backend/app/db.py backend/alembic.ini backend/alembic/env.py backend/alembic/script.py.mako backend/alembic/versions/.gitkeep
git commit -m "Add SQLAlchemy engine, session, and Alembic scaffolding"
```
(If `backend/alembic/versions/` is empty, create an empty `.gitkeep` file in it first so git tracks the directory: `mkdir backend/alembic/versions 2>/dev/null; touch backend/alembic/versions/.gitkeep`.)

---

## Task 2: SQLAlchemy models and initial migration

**Files:**
- Create: `backend/app/models.py`

**Interfaces:**
- Consumes: `Base` from Task 1 (`app.db.Base`).
- Produces: `new_id() -> str`, and 8 model classes — `Business`, `TaxNumber`, `User`, `Customer`, `CatalogItem`, `Invoice`, `LineItem`, `Payment`, `WebhookEvent` — all in `app.models`, used by every later task.

- [ ] **Step 1: Write models.py**

Create `backend/app/models.py`:

```python
"""SQLAlchemy ORM models — one per table in the approved schema
(docs/superpowers/specs/2026-07-24-supabase-postgres-migration-design.md).
"""
import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Integer, Numeric, String, Text
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.sql import func

from app.db import Base


def new_id() -> str:
    return str(uuid.uuid4())


class Business(Base):
    __tablename__ = "businesses"

    id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), primary_key=True, default=new_id)
    owner_user_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False))
    name: Mapped[str] = mapped_column(String)
    legal_name: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    email: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    phone: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    website: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    logo_url: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    address_line1: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    city: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    region: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    postal_code: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    country: Mapped[Optional[str]] = mapped_column(String, nullable=True, default="US")
    currency: Mapped[str] = mapped_column(String, default="USD")
    invoice_prefix: Mapped[str] = mapped_column(String, default="INV")
    next_invoice_no: Mapped[int] = mapped_column(Integer, default=1)
    default_terms: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    default_due_days: Mapped[int] = mapped_column(Integer, default=14)
    plan: Mapped[str] = mapped_column(String, default="FREE")
    anthropic_api_key: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    stripe_payment_url_default: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    stripe_customer_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    stripe_subscription_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    onboarded: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True, onupdate=func.now())

    tax_numbers: Mapped[list["TaxNumber"]] = relationship(back_populates="business", cascade="all, delete-orphan")


class TaxNumber(Base):
    __tablename__ = "tax_numbers"

    id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), primary_key=True, default=new_id)
    business_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), ForeignKey("businesses.id", ondelete="CASCADE"))
    label: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    value: Mapped[Optional[str]] = mapped_column(String, nullable=True)

    business: Mapped["Business"] = relationship(back_populates="tax_numbers")


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), primary_key=True, default=new_id)
    email: Mapped[str] = mapped_column(String, unique=True, index=True)
    password_hash: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    business_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), ForeignKey("businesses.id", ondelete="CASCADE"))
    name: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    role: Mapped[str] = mapped_column(String, default="OWNER")
    clerk_user_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Customer(Base):
    __tablename__ = "customers"

    id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), primary_key=True, default=new_id)
    business_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), ForeignKey("businesses.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String)
    email: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    phone: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    company: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    address_line1: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    city: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    region: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    postal_code: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    country: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    archived: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True, onupdate=func.now())


class CatalogItem(Base):
    __tablename__ = "catalog_items"

    id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), primary_key=True, default=new_id)
    business_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), ForeignKey("businesses.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    unit_price_cents: Mapped[int] = mapped_column(Integer)
    currency: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    unit: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    tax_percent: Mapped[float] = mapped_column(Numeric(5, 2), default=0)
    archived: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True, onupdate=func.now())


class Invoice(Base):
    __tablename__ = "invoices"

    id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), primary_key=True, default=new_id)
    business_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), ForeignKey("businesses.id", ondelete="CASCADE"), index=True)
    customer_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), ForeignKey("customers.id"), index=True)
    number: Mapped[str] = mapped_column(String)
    status: Mapped[str] = mapped_column(String, default="DRAFT")
    currency: Mapped[str] = mapped_column(String, default="USD")
    issue_date: Mapped[str] = mapped_column(Date)
    due_date: Mapped[str] = mapped_column(Date)
    discount_type: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    discount_value: Mapped[int] = mapped_column(Integer, default=0)
    subtotal_cents: Mapped[int] = mapped_column(Integer, default=0)
    tax_total_cents: Mapped[int] = mapped_column(Integer, default=0)
    discount_cents: Mapped[int] = mapped_column(Integer, default=0)
    total_cents: Mapped[int] = mapped_column(Integer, default=0)
    amount_paid_cents: Mapped[int] = mapped_column(Integer, default=0)
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    terms: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    stripe_payment_url: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    ai_source_text: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    sent_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    paid_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    voided_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True, onupdate=func.now())

    line_items: Mapped[list["LineItem"]] = relationship(
        back_populates="invoice", cascade="all, delete-orphan", order_by="LineItem.sort_order"
    )


class LineItem(Base):
    __tablename__ = "line_items"

    id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), primary_key=True, default=new_id)
    invoice_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), ForeignKey("invoices.id", ondelete="CASCADE"), index=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    name: Mapped[str] = mapped_column(String)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    quantity: Mapped[float] = mapped_column(Numeric(12, 4))
    unit_price_cents: Mapped[int] = mapped_column(Integer)
    tax_percent: Mapped[float] = mapped_column(Numeric(5, 2), default=0)

    invoice: Mapped["Invoice"] = relationship(back_populates="line_items")


class Payment(Base):
    __tablename__ = "payments"

    id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), primary_key=True, default=new_id)
    invoice_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), ForeignKey("invoices.id", ondelete="CASCADE"), index=True)
    business_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), ForeignKey("businesses.id", ondelete="CASCADE"))
    amount_cents: Mapped[int] = mapped_column(Integer)
    method: Mapped[str] = mapped_column(String, default="manual")
    paid_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class WebhookEvent(Base):
    __tablename__ = "webhook_events"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    type: Mapped[str] = mapped_column(String)
    processed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
```

- [ ] **Step 2: Generate the initial migration**

Run:
```bash
cd backend
.venv\Scripts\python.exe -m alembic revision --autogenerate -m "initial schema"
```
Expected: creates `backend/alembic/versions/<hash>_initial_schema.py`. Open it and confirm it contains `op.create_table(...)` calls for all 8 tables (`businesses`, `tax_numbers`, `users`, `customers`, `catalog_items`, `invoices`, `line_items`, `payments`, `webhook_events` — 9 tables total, since `tax_numbers` and `line_items` are separate from their parents). If any table is missing, `app/models.py` has a typo preventing it from registering on `Base.metadata` — fix before proceeding.

- [ ] **Step 3: Apply the migration**

Run:
```bash
cd backend
.venv\Scripts\python.exe -m alembic upgrade head
```
Expected: no errors; prints the applied revision. Verify by connecting to Supabase (Dashboard → Table Editor, or `psql`) and confirming all 9 tables exist with the expected columns.

- [ ] **Step 4: Commit**

```bash
git add backend/app/models.py backend/alembic/versions/
git commit -m "Add SQLAlchemy models and initial Postgres schema migration"
```

---

## Task 3: Pydantic schemas, auth core, and register/login/me routes

**Files:**
- Create: `backend/app/schemas.py`
- Create: `backend/app/auth.py`
- Create: `backend/app/routers/__init__.py` (empty)
- Create: `backend/app/routers/auth.py`
- Test: `backend/tests/test_backend.py::TestAuth` (existing tests, run against the new implementation — no new test code needed for this task, since the contract is identical)

**Interfaces:**
- Consumes: `Business`, `User`, `new_id` from `app.models` (Task 2); `get_db`, `to_dict` from `app.db` (Task 1).
- Produces: `RegisterIn`, `LoginIn`, `TokenOut`, `MeOut` (Pydantic models, `app.schemas`) — used by every later task's routers. `make_token(user_id: str, business_id: str) -> str`, `get_current_user(creds, db) -> dict` (returns `{"user": dict, "business_id": str}`), `get_business(ctx, db) -> dict` (returns `{"user": dict, "business": dict}`), `_create_business_and_user(db, email, business_name, password_hash, clerk_user_id=None) -> tuple[str, str]` — all in `app.auth`, used by every protected router in later tasks. `router` (FastAPI `APIRouter`, `app.routers.auth.router`) — mounted by Task 12's `main.py`.

- [ ] **Step 1: Write schemas.py**

Create `backend/app/schemas.py` — this is the existing Pydantic models from `server.py`, unchanged (moved, not rewritten):

```python
"""Pydantic request/response models. Unchanged from the pre-migration
server.py — only the database layer changed, not these contracts."""
from typing import List, Optional

from pydantic import BaseModel, EmailStr, Field


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


class LineItemIn(BaseModel):
    name: str
    description: Optional[str] = None
    quantity: float = Field(gt=0)
    unit_price_cents: int = Field(ge=0)
    tax_percent: float = Field(default=0, ge=0, le=100)


class InvoiceIn(BaseModel):
    customer_id: str
    issue_date: Optional[str] = None
    due_date: Optional[str] = None
    line_items: List[LineItemIn]
    discount_type: Optional[str] = None  # PERCENT | FIXED
    discount_value: Optional[int] = 0
    notes: Optional[str] = None
    terms: Optional[str] = None
    stripe_payment_url: Optional[str] = None
    ai_source_text: Optional[str] = None
    status: Optional[str] = "DRAFT"


class AIExtractIn(BaseModel):
    text: str


class MarkPaidIn(BaseModel):
    amount_cents: Optional[int] = None
    method: str = "manual"


class ClerkExchangeIn(BaseModel):
    clerk_token: str
```

(Note: `LineItem` is renamed `LineItemIn` here to avoid colliding with the `LineItem` ORM model imported elsewhere — the API contract/field names are unchanged, only this internal Python class name changed.)

- [ ] **Step 2: Write auth.py core (without Clerk yet — Task 4 adds it)**

Create `backend/app/auth.py`:

```python
"""Auth core: JWT issuing/verification and the shared business+user creation
helper. Clerk-specific verification is added in Task 4.
"""
import os
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db, to_dict
from app.models import Business, User, new_id

JWT_SECRET = os.environ.get("JWT_SECRET", "dev-secret-change-me-in-prod-invoiceai-32chars")
JWT_ALG = "HS256"
JWT_EXPIRES_MIN = 60 * 24 * 30  # 30 days

pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")
bearer_scheme = HTTPBearer(auto_error=False)


def make_token(user_id: str, business_id: str) -> str:
    payload = {
        "sub": user_id,
        "biz": business_id,
        "exp": datetime.now(timezone.utc) + timedelta(minutes=JWT_EXPIRES_MIN),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALG)


async def get_current_user(
    creds: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
    db: AsyncSession = Depends(get_db),
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

    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return {"user": to_dict(user), "business_id": biz_id}


async def get_business(
    ctx: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    biz = (await db.execute(select(Business).where(Business.id == ctx["business_id"]))).scalar_one_or_none()
    if not biz:
        raise HTTPException(status_code=404, detail="Business not found")
    return {"user": ctx["user"], "business": to_dict(biz)}


async def _create_business_and_user(
    db: AsyncSession,
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

    business = Business(
        id=business_id,
        owner_user_id=user_id,
        name=business_name,
        email=email,
        country="US",
        currency="USD",
        invoice_prefix="INV",
        next_invoice_no=1,
        default_terms="Payment due within 14 days.",
        default_due_days=14,
        plan="FREE",
        onboarded=False,
    )
    user = User(
        id=user_id,
        email=email,
        password_hash=password_hash,
        business_id=business_id,
        role="OWNER",
        clerk_user_id=clerk_user_id,
    )
    db.add(business)
    db.add(user)
    await db.commit()
    return user_id, business_id
```

- [ ] **Step 3: Write routers/auth.py (register, login, me — no Clerk route yet)**

Create `backend/app/routers/auth.py`:

```python
"""Auth routes: register, login, me. Clerk exchange is added in Task 4."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import _create_business_and_user, get_current_user, make_token, pwd_ctx
from app.db import get_db
from app.models import User
from app.schemas import LoginIn, MeOut, RegisterIn, TokenOut

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/register", response_model=TokenOut)
async def register(payload: RegisterIn, db: AsyncSession = Depends(get_db)):
    existing = (await db.execute(select(User).where(User.email == payload.email.lower()))).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")
    try:
        user_id, business_id = await _create_business_and_user(
            db,
            email=payload.email.lower(),
            business_name=payload.business_name,
            password_hash=pwd_ctx.hash(payload.password),
        )
    except IntegrityError:
        # Two concurrent signups with the same email can both pass the
        # find-first check above before either insert commits — the
        # users.email UNIQUE constraint is the real guard; this converts its
        # violation into the same 400 the check-first path returns, instead
        # of an unhandled 500.
        await db.rollback()
        raise HTTPException(status_code=400, detail="Email already registered")
    return TokenOut(access_token=make_token(user_id, business_id))


@router.post("/login", response_model=TokenOut)
async def login(payload: LoginIn, db: AsyncSession = Depends(get_db)):
    user = (await db.execute(select(User).where(User.email == payload.email.lower()))).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=400, detail="Invalid email or password")
    if not user.password_hash:
        raise HTTPException(
            status_code=400,
            detail="This account uses Google sign-in. Continue with Google instead.",
        )
    if not pwd_ctx.verify(payload.password, user.password_hash):
        raise HTTPException(status_code=400, detail="Invalid email or password")
    return TokenOut(access_token=make_token(user.id, user.business_id))


@router.get("/me", response_model=MeOut)
async def me(ctx: dict = Depends(get_current_user)):
    u = ctx["user"]
    return MeOut(id=u["id"], email=u["email"], business_id=u["business_id"], name=u.get("name"))
```

- [ ] **Step 4: Run the existing auth tests against the new implementation**

This requires Task 12's `main.py` to actually serve these routes — but to verify Task 3 in isolation, create a minimal throwaway ASGI app for testing purposes is unnecessary complexity. Instead, since later tasks depend on this one, run the full verification once `main.py` exists (Task 12). For now, verify statically:

```bash
cd backend
.venv\Scripts\python.exe -c "from app.routers.auth import router; print('auth router OK, routes:', [r.path for r in router.routes])"
```
Expected: `auth router OK, routes: ['/auth/register', '/auth/login', '/auth/me']` (no import errors).

- [ ] **Step 5: Commit**

```bash
git add backend/app/schemas.py backend/app/auth.py backend/app/routers/__init__.py backend/app/routers/auth.py
git commit -m "Add Pydantic schemas, auth core, and register/login/me routes for Postgres"
```

---

## Task 4: Clerk exchange on Postgres

**Files:**
- Modify: `backend/app/auth.py` (add Clerk client + `resolve_clerk_user`)
- Modify: `backend/app/routers/auth.py` (add `/auth/clerk-exchange`)
- Modify: `backend/requirements.txt` (re-add `clerk-backend-api` if not already present from the earlier Clerk work — it should already be there; verify)

**Interfaces:**
- Consumes: `_create_business_and_user`, `make_token` (Task 3); `User`, `new_id` from `app.models`.
- Produces: `resolve_clerk_user(db, clerk_token) -> tuple[str, str, bool]` in `app.auth`, and `POST /auth/clerk-exchange` in the auth router.

- [ ] **Step 1: Verify clerk-backend-api is in requirements.txt**

Run:
```bash
cd backend
grep clerk-backend-api requirements.txt
```
Expected: `clerk-backend-api==6.0.1` (added during the earlier Clerk auth work — if missing, add that exact line and `pip install -r requirements.txt`).

- [ ] **Step 2: Add Clerk verification to auth.py**

In `backend/app/auth.py`, add these imports at the top (alongside the existing ones):

```python
from clerk_backend_api import Clerk
from clerk_backend_api.security import (
    TokenVerificationError,
    VerifyTokenOptions,
    verify_token_async,
)
```

Add near the other module-level config (after `JWT_EXPIRES_MIN`):

```python
CLERK_SECRET_KEY = os.environ.get("CLERK_SECRET_KEY", "")
clerk_client = Clerk(bearer_auth=CLERK_SECRET_KEY)
```

Add this function after `_create_business_and_user`:

```python
async def resolve_clerk_user(db: AsyncSession, clerk_token: str) -> tuple[str, str, bool]:
    """Verify a Clerk session token and resolve it to (user_id, business_id,
    is_new_business), applying the account-linking rule: a verified email
    that matches an existing user logs into their existing business; no
    match creates a new business+user exactly like /auth/register does.
    """
    if not CLERK_SECRET_KEY:
        raise HTTPException(status_code=503, detail="Google sign-in is not configured.")

    try:
        payload = await verify_token_async(
            clerk_token, VerifyTokenOptions(secret_key=CLERK_SECRET_KEY)
        )
    except TokenVerificationError:
        raise HTTPException(
            status_code=401, detail="Invalid Google sign-in session. Please try again."
        )

    clerk_user_id = payload.get("sub")
    try:
        clerk_user = await clerk_client.users.get_async(user_id=clerk_user_id)
    except Exception:
        raise HTTPException(
            status_code=401, detail="Invalid Google sign-in session. Please try again."
        )

    primary = next(
        (e for e in clerk_user.email_addresses if e.id == clerk_user.primary_email_address_id),
        None,
    )
    if not primary or not primary.verification or primary.verification.status != "verified":
        raise HTTPException(
            status_code=400, detail="No verified email found on this Google account."
        )
    email = primary.email_address.lower()

    existing = (await db.execute(select(User).where(User.email == email))).scalar_one_or_none()
    if existing:
        if not existing.clerk_user_id:
            existing.clerk_user_id = clerk_user_id
            await db.commit()
        return existing.id, existing.business_id, False

    display_name = clerk_user.first_name or "My Business"
    user_id, business_id = await _create_business_and_user(
        db,
        email=email,
        business_name=display_name,
        password_hash=None,
        clerk_user_id=clerk_user_id,
    )
    return user_id, business_id, True
```

This also needs `select` imported in `auth.py` — it already is, from Task 3's `get_current_user`.

- [ ] **Step 3: Add the route**

In `backend/app/routers/auth.py`, add the import and route:

```python
from app.auth import resolve_clerk_user  # add to the existing app.auth import line
from app.schemas import ClerkExchangeIn  # add to the existing app.schemas import line
```

```python
@router.post("/clerk-exchange", response_model=TokenOut)
async def clerk_exchange(payload: ClerkExchangeIn, db: AsyncSession = Depends(get_db)):
    user_id, business_id, _is_new = await resolve_clerk_user(db, payload.clerk_token)
    return TokenOut(access_token=make_token(user_id, business_id))
```

- [ ] **Step 4: Static verification**

Run:
```bash
cd backend
.venv\Scripts\python.exe -c "from app.routers.auth import router; print([r.path for r in router.routes])"
```
Expected: includes `/auth/clerk-exchange` alongside the three routes from Task 3.

- [ ] **Step 5: Commit**

```bash
git add backend/app/auth.py backend/app/routers/auth.py
git commit -m "Add Clerk token exchange on Postgres"
```

---

## Task 5: Business, settings, and plans routes

**Files:**
- Create: `backend/app/routers/business.py`

**Interfaces:**
- Consumes: `get_business`, `to_dict` (Tasks 1, 3); `Business` from `app.models`; `BusinessUpdate`, `SettingsUpdate` from `app.schemas`.
- Produces: `check_plan_limit(db, business_id, plan) -> dict`, `PLAN_LIMITS`, `PLAN_META` in `app.routers.business` — used by Task 8 (invoices) for plan-limit checks.

- [ ] **Step 1: Write routers/business.py**

`business.tax_numbers` is a child table (`TaxNumber`), not a plain column, so `to_dict()` (which only reads `__table__.columns`) won't include it — but the pre-migration Mongo document had `tax_numbers` as a plain embedded array, and the frontend's `Business` type (`frontend/src/lib/types.ts`) expects it as an array on the business object. This file attaches it back onto every response from the start, so the frontend contract doesn't regress.

Create `backend/app/routers/business.py`:

```python
"""Business profile, settings, and subscription plan routes."""
import os
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_business
from app.db import get_db, to_dict
from app.models import Business, Invoice, TaxNumber
from app.schemas import BusinessUpdate, SettingsUpdate

router = APIRouter(tags=["business"])

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


async def check_plan_limit(db: AsyncSession, business_id: str, plan: str) -> dict:
    cfg = PLAN_LIMITS.get(plan, PLAN_LIMITS["FREE"])
    if cfg["scope"] == "lifetime":
        used = (await db.execute(
            select(func.count()).select_from(Invoice).where(Invoice.business_id == business_id)
        )).scalar_one()
    else:
        month_start = datetime.now(timezone.utc).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        used = (await db.execute(
            select(func.count()).select_from(Invoice).where(
                Invoice.business_id == business_id, Invoice.created_at >= month_start
            )
        )).scalar_one()
    return {"used": used, "limit": cfg["limit"], "scope": cfg["scope"], "over": used >= cfg["limit"]}


def _hide_anthropic_key(biz: dict) -> dict:
    biz["has_anthropic_key"] = bool(biz.get("anthropic_api_key"))
    biz.pop("anthropic_api_key", None)
    return biz


async def _with_tax_numbers(db: AsyncSession, biz_dict: dict, business_id: str) -> dict:
    rows = (await db.execute(select(TaxNumber).where(TaxNumber.business_id == business_id))).scalars().all()
    biz_dict["tax_numbers"] = [{"label": t.label, "value": t.value} for t in rows]
    return biz_dict


@router.get("/business/me")
async def get_my_business(ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)):
    biz = _hide_anthropic_key(dict(ctx["business"]))
    return await _with_tax_numbers(db, biz, biz["id"])


@router.patch("/business/me")
async def update_my_business(
    payload: BusinessUpdate, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)
):
    biz_id = ctx["business"]["id"]
    update = payload.model_dump(exclude_unset=True)
    # tax_numbers is a child table, not a plain column — handled separately below.
    tax_numbers_update = update.pop("tax_numbers", None)

    if update:
        biz = (await db.execute(select(Business).where(Business.id == biz_id))).scalar_one()
        for key, value in update.items():
            setattr(biz, key, value)
        biz.updated_at = datetime.now(timezone.utc)
        await db.commit()
    else:
        biz = (await db.execute(select(Business).where(Business.id == biz_id))).scalar_one()

    if tax_numbers_update is not None:
        await db.execute(delete(TaxNumber).where(TaxNumber.business_id == biz_id))
        for tn in tax_numbers_update:
            db.add(TaxNumber(business_id=biz_id, label=tn.get("label"), value=tn.get("value")))
        await db.commit()

    await db.refresh(biz)
    result = _hide_anthropic_key(to_dict(biz))
    return await _with_tax_numbers(db, result, biz_id)


@router.patch("/settings")
async def update_settings(
    payload: SettingsUpdate, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)
):
    biz_id = ctx["business"]["id"]
    update = {k: v for k, v in payload.model_dump(exclude_unset=True).items() if v is not None}
    if "plan" in update and update["plan"] not in PLAN_LIMITS:
        raise HTTPException(status_code=400, detail="Invalid plan")
    biz = (await db.execute(select(Business).where(Business.id == biz_id))).scalar_one()
    if update:
        for key, value in update.items():
            setattr(biz, key, value)
        biz.updated_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(biz)
    result = _hide_anthropic_key(to_dict(biz))
    return await _with_tax_numbers(db, result, biz_id)


@router.get("/plans")
async def list_plans(ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)):
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
        "usage": await check_plan_limit(db, biz["id"], current),
    }
```

- [ ] **Step 2: Static verification**

```bash
cd backend
.venv\Scripts\python.exe -c "from app.routers.business import router; print([r.path for r in router.routes])"
```
Expected: `['/business/me', '/business/me', '/settings', '/plans']` (GET and PATCH both register at `/business/me`).

- [ ] **Step 3: Commit**

```bash
git add backend/app/routers/business.py
git commit -m "Add business/settings/plans routes for Postgres"
```

---

## Task 6: Customers routes

**Files:**
- Create: `backend/app/routers/customers.py`

**Interfaces:**
- Consumes: `get_business`, `to_dict` (Tasks 1, 3); `Customer`, `Invoice` from `app.models`; `CustomerIn` from `app.schemas`.
- Produces: `router` (`app.routers.customers.router`).

- [ ] **Step 1: Write routers/customers.py**

Create `backend/app/routers/customers.py`:

```python
"""Customer CRUD routes."""
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_business
from app.db import get_db, to_dict
from app.models import Customer, Invoice
from app.models import new_id
from app.schemas import CustomerIn

router = APIRouter(prefix="/customers", tags=["customers"])


@router.get("")
async def list_customers(
    ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db), q: Optional[str] = None
):
    biz_id = ctx["business"]["id"]
    stmt = select(Customer).where(Customer.business_id == biz_id, Customer.archived.is_not(True))
    if q:
        like = f"%{q}%"
        stmt = stmt.where(or_(Customer.name.ilike(like), Customer.email.ilike(like), Customer.company.ilike(like)))
    stmt = stmt.order_by(Customer.name)
    rows = (await db.execute(stmt)).scalars().all()
    return [to_dict(r) for r in rows]


@router.post("")
async def create_customer(payload: CustomerIn, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)):
    biz_id = ctx["business"]["id"]
    customer = Customer(id=new_id(), business_id=biz_id, archived=False, **payload.model_dump())
    db.add(customer)
    await db.commit()
    await db.refresh(customer)
    return to_dict(customer)


@router.get("/{customer_id}")
async def get_customer(customer_id: str, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)):
    biz_id = ctx["business"]["id"]
    customer = (await db.execute(
        select(Customer).where(Customer.id == customer_id, Customer.business_id == biz_id)
    )).scalar_one_or_none()
    if not customer:
        raise HTTPException(status_code=404, detail="Customer not found")
    result = to_dict(customer)
    invs = (await db.execute(
        select(Invoice).where(Invoice.business_id == biz_id, Invoice.customer_id == customer_id)
    )).scalars().all()
    result["invoices"] = [to_dict(i) for i in invs]
    result["lifetime_revenue_cents"] = sum(int(i.amount_paid_cents or 0) for i in invs)
    return result


@router.patch("/{customer_id}")
async def update_customer(
    customer_id: str, payload: CustomerIn, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)
):
    biz_id = ctx["business"]["id"]
    customer = (await db.execute(
        select(Customer).where(Customer.id == customer_id, Customer.business_id == biz_id)
    )).scalar_one_or_none()
    if not customer:
        raise HTTPException(status_code=404, detail="Customer not found")
    for key, value in payload.model_dump().items():
        setattr(customer, key, value)
    customer.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(customer)
    return to_dict(customer)


@router.delete("/{customer_id}")
async def archive_customer(customer_id: str, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)):
    biz_id = ctx["business"]["id"]
    customer = (await db.execute(
        select(Customer).where(Customer.id == customer_id, Customer.business_id == biz_id)
    )).scalar_one_or_none()
    if customer:
        customer.archived = True
        await db.commit()
    return {"ok": True}
```

- [ ] **Step 2: Static verification**

```bash
cd backend
.venv\Scripts\python.exe -c "from app.routers.customers import router; print([r.path for r in router.routes])"
```
Expected: `['/customers', '/customers', '/customers/{customer_id}', '/customers/{customer_id}', '/customers/{customer_id}']`.

- [ ] **Step 3: Commit**

```bash
git add backend/app/routers/customers.py
git commit -m "Add customer CRUD routes for Postgres"
```

---

## Task 7: Catalog routes

**Files:**
- Create: `backend/app/routers/catalog.py`

**Interfaces:**
- Consumes: `get_business`, `to_dict`, `new_id` (Tasks 1, 2, 3); `CatalogItem` from `app.models`; `CatalogItemIn` from `app.schemas`.
- Produces: `router` (`app.routers.catalog.router`).

- [ ] **Step 1: Write routers/catalog.py**

Create `backend/app/routers/catalog.py`:

```python
"""Catalog item CRUD routes."""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_business
from app.db import get_db, to_dict
from app.models import CatalogItem, new_id
from app.schemas import CatalogItemIn

router = APIRouter(prefix="/catalog", tags=["catalog"])


@router.get("")
async def list_catalog(ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)):
    biz_id = ctx["business"]["id"]
    rows = (await db.execute(
        select(CatalogItem)
        .where(CatalogItem.business_id == biz_id, CatalogItem.archived.is_not(True))
        .order_by(CatalogItem.name)
    )).scalars().all()
    return [to_dict(r) for r in rows]


@router.post("")
async def create_catalog_item(
    payload: CatalogItemIn, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)
):
    biz = ctx["business"]
    data = payload.model_dump()
    data["currency"] = data.get("currency") or biz.get("currency", "USD")
    item = CatalogItem(id=new_id(), business_id=biz["id"], archived=False, **data)
    db.add(item)
    await db.commit()
    await db.refresh(item)
    return to_dict(item)


@router.patch("/{item_id}")
async def update_catalog_item(
    item_id: str, payload: CatalogItemIn, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)
):
    biz_id = ctx["business"]["id"]
    item = (await db.execute(
        select(CatalogItem).where(CatalogItem.id == item_id, CatalogItem.business_id == biz_id)
    )).scalar_one_or_none()
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    for key, value in payload.model_dump().items():
        setattr(item, key, value)
    item.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(item)
    return to_dict(item)


@router.delete("/{item_id}")
async def delete_catalog_item(item_id: str, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)):
    biz_id = ctx["business"]["id"]
    item = (await db.execute(
        select(CatalogItem).where(CatalogItem.id == item_id, CatalogItem.business_id == biz_id)
    )).scalar_one_or_none()
    if item:
        item.archived = True
        await db.commit()
    return {"ok": True}
```

- [ ] **Step 2: Static verification**

```bash
cd backend
.venv\Scripts\python.exe -c "from app.routers.catalog import router; print([r.path for r in router.routes])"
```
Expected: `['/catalog', '/catalog', '/catalog/{item_id}', '/catalog/{item_id}']`.

- [ ] **Step 3: Commit**

```bash
git add backend/app/routers/catalog.py
git commit -m "Add catalog item CRUD routes for Postgres"
```

---

## Task 8: Invoice routes (totals engine, line items, plan limits)

The largest single task — invoices, their line items, and the plan-limit-gated create/duplicate actions all belong together as one cohesive unit.

**Files:**
- Create: `backend/app/routers/invoices.py`

**Interfaces:**
- Consumes: `get_business`, `to_dict`, `new_id` (Tasks 1–3); `check_plan_limit` from `app.routers.business` (Task 5); `Invoice`, `LineItem`, `Customer`, `Business`, `Payment` from `app.models`; `InvoiceIn`, `MarkPaidIn` from `app.schemas`.
- Produces: `compute_totals(line_items: list[dict], discount_type, discount_value) -> dict` in `app.routers.invoices` — pure function, no DB dependency, unchanged logic from the pre-migration version. `router` (`app.routers.invoices.router`).

- [ ] **Step 1: Write routers/invoices.py**

Create `backend/app/routers/invoices.py`:

```python
"""Invoice routes: CRUD, line items, totals engine, plan-limit-gated
create/duplicate, mark-paid/send/void.
"""
from datetime import datetime, timedelta, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, update as sql_update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.auth import get_business
from app.db import get_db, to_dict
from app.models import Business, Customer, Invoice, LineItem, Payment, new_id
from app.routers.business import check_plan_limit
from app.schemas import InvoiceIn, MarkPaidIn

router = APIRouter(prefix="/invoices", tags=["invoices"])


# ---------------------------------------------------------------------------
# Totals engine (single source of truth) — unchanged logic from pre-migration
# ---------------------------------------------------------------------------
def compute_totals(
    line_items: List[dict],
    discount_type: Optional[str] = None,
    discount_value: int = 0,
) -> dict:
    subtotal = 0
    tax_total = 0
    tax_breakdown: dict = {}

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

    discount_cents = 0
    if discount_type == "PERCENT" and discount_value:
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


def _line_item_dict(li: LineItem) -> dict:
    return {
        "name": li.name,
        "description": li.description,
        "quantity": float(li.quantity),
        "unit_price_cents": li.unit_price_cents,
        "tax_percent": float(li.tax_percent),
    }


async def _serialize_invoice(db: AsyncSession, inv: Invoice, tax_breakdown: Optional[list] = None) -> dict:
    """Attach customer summary and line items to an invoice for list/detail
    views, mirroring the pre-migration dict shape exactly."""
    data = to_dict(inv)
    data["line_items"] = [_line_item_dict(li) for li in sorted(inv.line_items, key=lambda x: x.sort_order)]
    data["tax_breakdown"] = tax_breakdown if tax_breakdown is not None else compute_totals(
        data["line_items"], data["discount_type"], data["discount_value"]
    )["tax_breakdown"]
    cust = (await db.execute(select(Customer).where(Customer.id == inv.customer_id))).scalar_one_or_none()
    data["customer"] = to_dict(cust) if cust else None
    return data


async def _get_invoice_with_items(db: AsyncSession, invoice_id: str, business_id: str) -> Optional[Invoice]:
    return (await db.execute(
        select(Invoice)
        .options(selectinload(Invoice.line_items))
        .where(Invoice.id == invoice_id, Invoice.business_id == business_id)
    )).scalar_one_or_none()


@router.get("")
async def list_invoices(
    ctx: dict = Depends(get_business),
    db: AsyncSession = Depends(get_db),
    status_filter: Optional[str] = None,
    q: Optional[str] = None,
):
    biz_id = ctx["business"]["id"]
    stmt = select(Invoice).options(selectinload(Invoice.line_items)).where(Invoice.business_id == biz_id)
    if status_filter and status_filter.upper() != "ALL":
        stmt = stmt.where(Invoice.status == status_filter.upper())
    stmt = stmt.order_by(Invoice.created_at.desc())
    rows = (await db.execute(stmt)).scalars().all()
    results = []
    for inv in rows:
        item = await _serialize_invoice(db, inv)
        if q:
            hay = " ".join([item.get("number") or "", (item.get("customer") or {}).get("name") or ""]).lower()
            if q.lower() not in hay:
                continue
        results.append(item)
    return results


@router.get("/{invoice_id}")
async def get_invoice(invoice_id: str, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)):
    biz_id = ctx["business"]["id"]
    inv = await _get_invoice_with_items(db, invoice_id, biz_id)
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")
    return await _serialize_invoice(db, inv)


@router.post("")
async def create_invoice(payload: InvoiceIn, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)):
    biz = ctx["business"]
    biz_id = biz["id"]

    plan_status = await check_plan_limit(db, biz_id, biz.get("plan", "FREE"))
    if plan_status["over"]:
        raise HTTPException(
            status_code=402,
            detail={
                "error": "PLAN_LIMIT_REACHED",
                "message": f"Your {biz.get('plan', 'FREE')} plan allows {plan_status['limit']} invoices per {plan_status['scope']}. Upgrade to create more.",
                **plan_status,
            },
        )

    cust = (await db.execute(
        select(Customer).where(Customer.id == payload.customer_id, Customer.business_id == biz_id)
    )).scalar_one_or_none()
    if not cust:
        raise HTTPException(status_code=400, detail="Customer not found for this business")

    # Atomic invoice numbering (equivalent of Mongo's find_one_and_update $inc)
    seq = (await db.execute(
        sql_update(Business)
        .where(Business.id == biz_id)
        .values(next_invoice_no=Business.next_invoice_no + 1)
        .returning(Business.next_invoice_no)
    )).scalar_one() - 1
    prefix = biz.get("invoice_prefix", "INV")
    number = f"{prefix}-{str(seq).zfill(4)}"

    line_item_dicts = [li.model_dump() for li in payload.line_items]
    totals = compute_totals(line_item_dicts, payload.discount_type, payload.discount_value or 0)

    now = datetime.now(timezone.utc)
    issue = payload.issue_date or now.date().isoformat()
    due = payload.due_date or (now + timedelta(days=biz.get("default_due_days", 14))).date().isoformat()

    invoice = Invoice(
        id=new_id(),
        business_id=biz_id,
        customer_id=payload.customer_id,
        number=number,
        status=(payload.status or "DRAFT").upper(),
        currency=biz.get("currency", "USD"),
        issue_date=issue,
        due_date=due,
        discount_type=payload.discount_type,
        discount_value=payload.discount_value or 0,
        subtotal_cents=totals["subtotal_cents"],
        tax_total_cents=totals["tax_total_cents"],
        discount_cents=totals["discount_cents"],
        total_cents=totals["total_cents"],
        amount_paid_cents=0,
        notes=payload.notes,
        terms=payload.terms or biz.get("default_terms"),
        stripe_payment_url=payload.stripe_payment_url or biz.get("stripe_payment_url_default"),
        ai_source_text=payload.ai_source_text,
    )
    for idx, li in enumerate(line_item_dicts):
        invoice.line_items.append(LineItem(sort_order=idx, **li))
    db.add(invoice)
    await db.commit()
    inv = await _get_invoice_with_items(db, invoice.id, biz_id)
    return await _serialize_invoice(db, inv, totals["tax_breakdown"])


@router.patch("/{invoice_id}")
async def update_invoice(
    invoice_id: str, payload: InvoiceIn, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)
):
    biz_id = ctx["business"]["id"]
    inv = await _get_invoice_with_items(db, invoice_id, biz_id)
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")
    if inv.status != "DRAFT":
        raise HTTPException(status_code=400, detail="Only DRAFT invoices can be edited")

    line_item_dicts = [li.model_dump() for li in payload.line_items]
    totals = compute_totals(line_item_dicts, payload.discount_type, payload.discount_value or 0)

    inv.customer_id = payload.customer_id
    inv.discount_type = payload.discount_type
    inv.discount_value = payload.discount_value or 0
    inv.subtotal_cents = totals["subtotal_cents"]
    inv.tax_total_cents = totals["tax_total_cents"]
    inv.discount_cents = totals["discount_cents"]
    inv.total_cents = totals["total_cents"]
    inv.notes = payload.notes
    inv.terms = payload.terms
    inv.stripe_payment_url = payload.stripe_payment_url
    inv.issue_date = payload.issue_date or inv.issue_date
    inv.due_date = payload.due_date or inv.due_date
    inv.updated_at = datetime.now(timezone.utc)

    for li in list(inv.line_items):
        await db.delete(li)
    for idx, li in enumerate(line_item_dicts):
        inv.line_items.append(LineItem(sort_order=idx, **li))

    await db.commit()
    inv = await _get_invoice_with_items(db, invoice_id, biz_id)
    return await _serialize_invoice(db, inv, totals["tax_breakdown"])


@router.post("/{invoice_id}/mark-paid")
async def mark_paid(
    invoice_id: str, payload: MarkPaidIn, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)
):
    biz_id = ctx["business"]["id"]
    inv = await _get_invoice_with_items(db, invoice_id, biz_id)
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")

    amount = payload.amount_cents if payload.amount_cents is not None else (inv.total_cents - (inv.amount_paid_cents or 0))
    if amount <= 0:
        raise HTTPException(status_code=400, detail="Amount must be greater than zero")

    new_paid = (inv.amount_paid_cents or 0) + amount
    now = datetime.now(timezone.utc)
    if new_paid >= inv.total_cents:
        inv.status = "PAID"
        inv.paid_at = now
    else:
        inv.status = "PARTIALLY_PAID"

    db.add(Payment(invoice_id=invoice_id, business_id=biz_id, amount_cents=amount, method=payload.method, paid_at=now))
    inv.amount_paid_cents = new_paid
    inv.updated_at = now
    await db.commit()
    inv = await _get_invoice_with_items(db, invoice_id, biz_id)
    return await _serialize_invoice(db, inv)


@router.post("/{invoice_id}/send")
async def mark_sent(invoice_id: str, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)):
    biz_id = ctx["business"]["id"]
    inv = await _get_invoice_with_items(db, invoice_id, biz_id)
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")
    if inv.status == "DRAFT":
        inv.status = "SENT"
        inv.sent_at = datetime.now(timezone.utc)
        inv.updated_at = datetime.now(timezone.utc)
        await db.commit()
        inv = await _get_invoice_with_items(db, invoice_id, biz_id)
    return await _serialize_invoice(db, inv)


@router.post("/{invoice_id}/void")
async def void_invoice(invoice_id: str, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)):
    biz_id = ctx["business"]["id"]
    inv = await _get_invoice_with_items(db, invoice_id, biz_id)
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")
    if inv.status == "PAID":
        raise HTTPException(status_code=400, detail="Cannot void a paid invoice")
    inv.status = "VOID"
    inv.voided_at = datetime.now(timezone.utc)
    inv.updated_at = datetime.now(timezone.utc)
    await db.commit()
    inv = await _get_invoice_with_items(db, invoice_id, biz_id)
    return await _serialize_invoice(db, inv)


@router.post("/{invoice_id}/duplicate")
async def duplicate_invoice(invoice_id: str, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)):
    biz = ctx["business"]
    biz_id = biz["id"]
    inv = await _get_invoice_with_items(db, invoice_id, biz_id)
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")

    plan_status = await check_plan_limit(db, biz_id, biz.get("plan", "FREE"))
    if plan_status["over"]:
        raise HTTPException(status_code=402, detail={"error": "PLAN_LIMIT_REACHED", **plan_status})

    seq = (await db.execute(
        sql_update(Business)
        .where(Business.id == biz_id)
        .values(next_invoice_no=Business.next_invoice_no + 1)
        .returning(Business.next_invoice_no)
    )).scalar_one() - 1
    number = f"{biz.get('invoice_prefix', 'INV')}-{str(seq).zfill(4)}"

    now = datetime.now(timezone.utc)
    new_invoice = Invoice(
        id=new_id(),
        business_id=biz_id,
        customer_id=inv.customer_id,
        number=number,
        status="DRAFT",
        currency=inv.currency,
        issue_date=inv.issue_date,
        due_date=inv.due_date,
        discount_type=inv.discount_type,
        discount_value=inv.discount_value,
        subtotal_cents=inv.subtotal_cents,
        tax_total_cents=inv.tax_total_cents,
        discount_cents=inv.discount_cents,
        total_cents=inv.total_cents,
        amount_paid_cents=0,
        notes=inv.notes,
        terms=inv.terms,
        stripe_payment_url=inv.stripe_payment_url,
        ai_source_text=inv.ai_source_text,
    )
    for li in sorted(inv.line_items, key=lambda x: x.sort_order):
        new_invoice.line_items.append(LineItem(
            sort_order=li.sort_order, name=li.name, description=li.description,
            quantity=li.quantity, unit_price_cents=li.unit_price_cents, tax_percent=li.tax_percent,
        ))
    db.add(new_invoice)
    await db.commit()
    result_inv = await _get_invoice_with_items(db, new_invoice.id, biz_id)
    return await _serialize_invoice(db, result_inv)
```

- [ ] **Step 2: Static verification**

```bash
cd backend
.venv\Scripts\python.exe -c "from app.routers.invoices import router, compute_totals; print([r.path for r in router.routes]); print(compute_totals([{'quantity': 2, 'unit_price_cents': 15000, 'tax_percent': 10}]))"
```
Expected: route list includes all 7 invoice routes, and `compute_totals(...)` prints `{'subtotal_cents': 30000, 'tax_total_cents': 3000, 'tax_breakdown': [{'percent': 10.0, 'amount_cents': 3000}], 'discount_cents': 0, 'total_cents': 33000}` (matching the $330.00 total verified earlier in this project for the same inputs).

- [ ] **Step 3: Commit**

```bash
git add backend/app/routers/invoices.py
git commit -m "Add invoice routes with line-item child table and totals engine for Postgres"
```

---

## Task 9: Dashboard summary route

**Files:**
- Create: `backend/app/routers/dashboard.py`

**Interfaces:**
- Consumes: `get_business`, `to_dict` (Tasks 1, 3); `check_plan_limit` (Task 5); `Invoice` from `app.models`.
- Produces: `router` (`app.routers.dashboard.router`).

- [ ] **Step 1: Write routers/dashboard.py**

Create `backend/app/routers/dashboard.py` — the aggregation logic is unchanged (fetch all invoices for the business, aggregate in Python), only the fetch becomes a SQLAlchemy query:

```python
"""Dashboard summary route."""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_business
from app.db import get_db
from app.models import Invoice
from app.routers.business import check_plan_limit

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


@router.get("/summary")
async def dashboard_summary(ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)):
    biz = ctx["business"]
    biz_id = biz["id"]
    now = datetime.now(timezone.utc)
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)

    invoices = (await db.execute(select(Invoice).where(Invoice.business_id == biz_id))).scalars().all()

    revenue_this_month = 0
    outstanding = 0
    overdue = 0
    total_paid = 0
    today = now.date().isoformat()

    for inv in invoices:
        paid = int(inv.amount_paid_cents or 0)
        total = int(inv.total_cents or 0)
        due_amt = total - paid
        if inv.paid_at:
            paid_dt = inv.paid_at if inv.paid_at.tzinfo else inv.paid_at.replace(tzinfo=timezone.utc)
            if paid_dt >= month_start:
                revenue_this_month += paid
        if inv.status in ("SENT", "VIEWED", "PARTIALLY_PAID"):
            outstanding += due_amt
            if inv.due_date and inv.due_date.isoformat() < today:
                overdue += due_amt
        total_paid += paid

    months = []
    for i in range(5, -1, -1):
        m = (month_start.month - i - 1) % 12 + 1
        y = month_start.year + ((month_start.month - i - 1) // 12)
        months.append({"year": y, "month": m, "revenue_cents": 0, "label": datetime(y, m, 1).strftime("%b")})
    for inv in invoices:
        if inv.paid_at:
            d = inv.paid_at
            for mrec in months:
                if d.year == mrec["year"] and d.month == mrec["month"]:
                    mrec["revenue_cents"] += int(inv.amount_paid_cents or 0)
                    break

    plan_status = await check_plan_limit(db, biz_id, biz.get("plan", "FREE"))

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
```

Note: `inv.due_date` is now a real `date` object (SQLAlchemy `Date` column), not a string — `.isoformat()` produces the same `YYYY-MM-DD` string the old code compared directly, so the `overdue` comparison logic is unchanged in effect.

- [ ] **Step 2: Static verification**

```bash
cd backend
.venv\Scripts\python.exe -c "from app.routers.dashboard import router; print([r.path for r in router.routes])"
```
Expected: `['/dashboard/summary']`.

- [ ] **Step 3: Commit**

```bash
git add backend/app/routers/dashboard.py
git commit -m "Add dashboard summary route for Postgres"
```

---

## Task 10: AI extraction route

**Files:**
- Create: `backend/app/routers/ai.py`

**Interfaces:**
- Consumes: `get_business` (Task 3); `Customer`, `CatalogItem` from `app.models`; `AIExtractIn` from `app.schemas`.
- Produces: `router` (`app.routers.ai.router`).

- [ ] **Step 1: Write routers/ai.py**

Create `backend/app/routers/ai.py` — the Anthropic call and prompt logic are entirely unchanged; only the customer/catalog context-fetch becomes a SQLAlchemy query:

```python
"""AI invoice-extraction route. Anthropic call/prompt unchanged from pre-migration."""
from datetime import datetime, timezone
from typing import Any

from anthropic import AsyncAnthropic
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_business
from app.db import get_db
from app.models import CatalogItem, Customer
from app.schemas import AIExtractIn

router = APIRouter(prefix="/ai", tags=["ai"])

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


@router.post("/extract-invoice")
async def ai_extract_invoice(
    payload: AIExtractIn, ctx: dict = Depends(get_business), db: AsyncSession = Depends(get_db)
):
    biz = ctx["business"]
    api_key = biz.get("anthropic_api_key")
    if not api_key:
        raise HTTPException(status_code=400, detail="Anthropic API key not configured. Add it in Settings.")

    customers = (await db.execute(
        select(Customer).where(Customer.business_id == biz["id"], Customer.archived.is_not(True)).limit(100)
    )).scalars().all()
    catalog = (await db.execute(
        select(CatalogItem).where(CatalogItem.business_id == biz["id"], CatalogItem.archived.is_not(True)).limit(100)
    )).scalars().all()
    known_customers = [{"name": c.name, "email": c.email} for c in customers]
    known_catalog = [{"name": c.name, "unit_price_cents": c.unit_price_cents, "unit": c.unit} for c in catalog]

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
        raise HTTPException(status_code=502, detail=f"AI extraction failed: {e}")

    extracted: Any = None
    for block in resp.content:
        if getattr(block, "type", None) == "tool_use":
            extracted = block.input
            break
    if not extracted:
        raise HTTPException(status_code=500, detail="AI returned no structured data")
    return {"draft": extracted}
```

- [ ] **Step 2: Static verification**

```bash
cd backend
.venv\Scripts\python.exe -c "from app.routers.ai import router; print([r.path for r in router.routes])"
```
Expected: `['/ai/extract-invoice']`.

- [ ] **Step 3: Commit**

```bash
git add backend/app/routers/ai.py
git commit -m "Add AI extraction route for Postgres"
```

---

## Task 11: Stripe webhook route

**Files:**
- Create: `backend/app/routers/webhooks.py`

**Interfaces:**
- Consumes: `Business`, `WebhookEvent` from `app.models`; `get_db` from `app.db`.
- Produces: `router` (`app.routers.webhooks.router`).

- [ ] **Step 1: Write routers/webhooks.py**

Create `backend/app/routers/webhooks.py` — signature verification and event-type handling are entirely unchanged; only the idempotency-dedup lookup and the business-plan update become SQLAlchemy:

```python
"""Stripe webhook route (public, signature-verified, idempotent)."""
import os

import stripe
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select, update as sql_update
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.models import Business, WebhookEvent

router = APIRouter(prefix="/webhooks", tags=["webhooks"])

STRIPE_WEBHOOK_SECRET = os.environ.get("STRIPE_WEBHOOK_SECRET", "")
VALID_PLANS = {"FREE", "STARTER", "PRO"}


@router.post("/stripe")
async def stripe_webhook(request: Request, db: AsyncSession = Depends(get_db)):
    """Handle Stripe events for automatic plan activation/deactivation.

    Payment Links redirect back with client_reference_id = "PLAN.BUSINESS_ID".
    We flip business.plan on checkout.session.completed and downgrade to FREE
    on customer.subscription.deleted. All events are deduped via WebhookEvent.
    """
    if not STRIPE_WEBHOOK_SECRET:
        raise HTTPException(status_code=503, detail="Stripe webhook secret not configured. Set STRIPE_WEBHOOK_SECRET.")

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

    existing = (await db.execute(select(WebhookEvent).where(WebhookEvent.id == event_id))).scalar_one_or_none()
    if existing:
        return {"status": "ok", "message": "duplicate"}

    if event_type == "checkout.session.completed":
        client_ref = obj.get("client_reference_id") or ""
        customer_id = obj.get("customer")
        subscription_id = obj.get("subscription")
        if "." in client_ref:
            plan, biz_id = client_ref.split(".", 1)
            plan = plan.upper()
            if plan in VALID_PLANS and biz_id:
                values: dict = {"plan": plan}
                if customer_id:
                    values["stripe_customer_id"] = customer_id
                if subscription_id:
                    values["stripe_subscription_id"] = subscription_id
                await db.execute(sql_update(Business).where(Business.id == biz_id).values(**values))

    elif event_type == "customer.subscription.deleted":
        customer_id = obj.get("customer")
        if customer_id:
            await db.execute(
                sql_update(Business).where(Business.stripe_customer_id == customer_id).values(plan="FREE")
            )

    # invoice.payment_failed: non-fatal, no action needed (matches pre-migration behavior)

    db.add(WebhookEvent(id=event_id, type=event_type))
    await db.commit()

    return {"status": "ok"}
```

- [ ] **Step 2: Static verification**

```bash
cd backend
.venv\Scripts\python.exe -c "from app.routers.webhooks import router; print([r.path for r in router.routes])"
```
Expected: `['/webhooks/stripe']`.

- [ ] **Step 3: Commit**

```bash
git add backend/app/routers/webhooks.py
git commit -m "Add Stripe webhook route for Postgres"
```

---

## Task 12: Assemble main.py, cut over, and remove the old MongoDB server

This is where everything from Tasks 1–11 gets wired together into a running app, verified against the full existing test suite, and the old `server.py` is retired.

**Files:**
- Create: `backend/app/main.py`
- Modify: `backend/tests/conftest.py` (no code change expected — verify it still works, since it only makes HTTP calls)
- Modify: `backend/tests/test_clerk_auth.py` (its in-process pattern imports `server` directly — needs to import from the new `app.*` modules instead)
- Delete: `backend/server.py`
- Modify: `backend/requirements.txt` (remove `motor`, `pymongo` for real this time — Task 1 already dropped the requirements.txt lines; this step removes them from the installed venv too, and confirms nothing still imports them)
- Modify: `backend/.env` (remove `MONGO_URL`, `DB_NAME` now that nothing reads them)

**Interfaces:**
- Consumes: every router from Tasks 3–11.
- Produces: `app` (the FastAPI application instance, `app.main.app`) — the actual thing Uvicorn serves (`uvicorn app.main:app`, replacing today's `uvicorn server:app`).

- [ ] **Step 1: Write main.py**

Create `backend/app/main.py`:

```python
"""FastAPI application assembly: CORS, router registration, health checks."""
from fastapi import APIRouter, FastAPI
from starlette.middleware.cors import CORSMiddleware

from app.db import engine
from app.routers import ai, auth, business, catalog, customers, dashboard, invoices, webhooks

app = FastAPI(title="InvoiceAI API")
api = APIRouter(prefix="/api")

api.include_router(auth.router)
api.include_router(business.router)
api.include_router(customers.router)
api.include_router(catalog.router)
api.include_router(invoices.router)
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
```

- [ ] **Step 2: Rewrite test_clerk_auth.py for the new module structure**

`backend/tests/test_clerk_auth.py` currently does `sys.path.insert(...); import server` and calls `server.resolve_clerk_user`, `server._create_business_and_user`, `server.db`, etc. directly, using a `run()`/`run_db()` pair where `run_db()` exists solely to work around Motor's async client caching its event loop across separate `asyncio.run()` calls.

That workaround doesn't carry forward as-is: SQLAlchemy's async engine has the same underlying constraint (its connection pool binds to whichever event loop first uses it), but there is no `_io_loop`-style private attribute to reset on an async SQLAlchemy engine. The clean fix — and the one worth adopting now rather than porting the old hack — is to give every test exactly one `asyncio.run()` call wrapping a single inner async function that does all of that test's work, the same pattern `TestLoginGuard`'s one test already used. One event loop per test sidesteps the pooled-connection issue entirely; `run_db()` is no longer needed anywhere.

Replace the entire contents of `backend/tests/test_clerk_auth.py` with:

```python
"""Unit tests for Clerk-related auth behavior.

Unlike test_backend.py (which drives a live running server over HTTP via
conftest.py), these tests import the app modules directly and call their
functions in-process. This is needed here because there's no public API to
create a password-less (Google-only) user to test the login guard against,
and because Clerk's verification calls must be mocked (there's no live Clerk
session token available in CI).

Each test wraps all of its operations in exactly one asyncio.run() call
around a single inner async function. SQLAlchemy's async engine binds its
connection pool to whichever event loop first uses it, so a second
independent asyncio.run() call later in the same test would create a new
event loop and break trying to reuse pooled connections bound to the old
one — one asyncio.run() per test avoids that entirely.
"""
import asyncio
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from clerk_backend_api.security import TokenVerificationError, TokenVerificationErrorReason
from fastapi import HTTPException
from sqlalchemy import select

from app import auth as auth_module
from app.db import SessionLocal
from app.models import Business, User


def run(coro):
    return asyncio.run(coro)


class TestLoginGuard:
    def test_login_on_google_only_account_returns_clear_error(self):
        async def run_test():
            from app.routers.auth import login
            from app.schemas import LoginIn

            async with SessionLocal() as db:
                email = f"clerk_only_{uuid.uuid4().hex[:10]}@example.com"
                await auth_module._create_business_and_user(
                    db,
                    email=email,
                    business_name="Google Only Co",
                    password_hash=None,
                    clerk_user_id="user_fake123",
                )

                try:
                    await login(LoginIn(email=email, password="anything"), db)
                    assert False, "expected HTTPException"
                except HTTPException as e:
                    assert e.status_code == 400
                    assert e.detail == "This account uses Google sign-in. Continue with Google instead."

        run(run_test())


def fake_clerk_user(email: str, first_name: str = "Ada", verified: bool = True):
    """Build a stand-in for clerk_backend_api.models.User with just the
    fields resolve_clerk_user() reads."""
    status = "verified" if verified else "unverified"
    return SimpleNamespace(
        first_name=first_name,
        primary_email_address_id="idn_primary",
        email_addresses=[SimpleNamespace(
            id="idn_primary",
            email_address=email,
            verification=SimpleNamespace(status=status),
        )],
    )


class TestResolveClerkUser:
    def test_new_email_creates_business(self):
        async def run_test():
            email = f"clerk_{uuid.uuid4().hex[:10]}@example.com"
            async with SessionLocal() as db:
                with patch.object(auth_module, "verify_token_async", AsyncMock(return_value={"sub": "user_abc123"})), \
                     patch.object(auth_module.clerk_client.users, "get_async", AsyncMock(return_value=fake_clerk_user(email))):
                    user_id, business_id, is_new = await auth_module.resolve_clerk_user(db, "fake-token")

                assert is_new is True
                biz = (await db.execute(select(Business).where(Business.id == business_id))).scalar_one()
                assert biz.name == "Ada"
                assert biz.onboarded is False
                user = (await db.execute(select(User).where(User.id == user_id))).scalar_one()
                assert user.email == email
                assert user.password_hash is None
                assert user.clerk_user_id == "user_abc123"

        run(run_test())

    def test_matching_email_logs_into_existing_business(self):
        async def run_test():
            email = f"clerk_link_{uuid.uuid4().hex[:10]}@example.com"
            async with SessionLocal() as db:
                existing_user_id, existing_business_id = await auth_module._create_business_and_user(
                    db, email=email, business_name="Existing Co", password_hash="irrelevant-hash"
                )

                with patch.object(auth_module, "verify_token_async", AsyncMock(return_value={"sub": "user_xyz789"})), \
                     patch.object(auth_module.clerk_client.users, "get_async", AsyncMock(return_value=fake_clerk_user(email))):
                    user_id, business_id, is_new = await auth_module.resolve_clerk_user(db, "fake-token")

                assert is_new is False
                assert user_id == existing_user_id
                assert business_id == existing_business_id
                # clerk_user_id should be backfilled onto the pre-existing user row
                user = (await db.execute(select(User).where(User.id == existing_user_id))).scalar_one()
                assert user.clerk_user_id == "user_xyz789"

        run(run_test())

    def test_invalid_token_raises_401(self):
        async def run_test():
            async with SessionLocal() as db:
                with patch.object(
                    auth_module, "verify_token_async",
                    AsyncMock(side_effect=TokenVerificationError(TokenVerificationErrorReason.TOKEN_INVALID)),
                ):
                    try:
                        await auth_module.resolve_clerk_user(db, "garbage")
                        assert False, "expected HTTPException"
                    except HTTPException as e:
                        assert e.status_code == 401

        run(run_test())

    def test_no_verified_email_raises_400(self):
        async def run_test():
            async with SessionLocal() as db:
                with patch.object(auth_module, "verify_token_async", AsyncMock(return_value={"sub": "user_no_email"})), \
                     patch.object(
                         auth_module.clerk_client.users, "get_async",
                         AsyncMock(return_value=SimpleNamespace(
                             first_name=None, primary_email_address_id=None, email_addresses=[]
                         )),
                     ):
                    try:
                        await auth_module.resolve_clerk_user(db, "fake-token")
                        assert False, "expected HTTPException"
                    except HTTPException as e:
                        assert e.status_code == 400

        run(run_test())

    def test_unverified_email_raises_400(self):
        async def run_test():
            email = f"clerk_unverified_{uuid.uuid4().hex[:10]}@example.com"
            async with SessionLocal() as db:
                with patch.object(auth_module, "verify_token_async", AsyncMock(return_value={"sub": "user_unverified"})), \
                     patch.object(auth_module.clerk_client.users, "get_async", AsyncMock(return_value=fake_clerk_user(email, verified=False))):
                    try:
                        await auth_module.resolve_clerk_user(db, "fake-token")
                        assert False, "expected HTTPException"
                    except HTTPException as e:
                        assert e.status_code == 400

        run(run_test())
```

Run this file's tests after the rewrite (Step 4 below covers this as part of the full suite run).

- [ ] **Step 3: Update backend/.env**

Remove the `MONGO_URL` and `DB_NAME` lines from `backend/.env` — nothing reads them once `server.py` is deleted.

- [ ] **Step 4: Delete server.py, uninstall old dependencies, run the FULL test suite**

```bash
cd backend
rm server.py
.venv\Scripts\pip.exe uninstall -y motor pymongo
.venv\Scripts\python.exe -m uvicorn app.main:app --port 8000
```
(background this, then in a separate terminal:)
```bash
cd backend
.venv\Scripts\python.exe -m pytest tests/ -v
```
Expected: every test in `test_backend.py` and `test_clerk_auth.py` passes — this is the full regression check for the entire migration. Known pre-existing, unrelated failure `test_plans_returns_both_stripe_urls_from_env` (stale hardcoded Stripe URL, flagged separately before this migration started) is still expected to fail; nothing else should.

If anything fails, fix it in this task before committing — this is the final gate for the whole migration, not something to defer.

- [ ] **Step 5: Update the start command references**

Anywhere the project's docs/scripts reference `uvicorn server:app`, update to `uvicorn app.main:app`. Check `backend/README.md` if one exists, and any `.claude/launch.json`-style dev-server configs pointing at the backend start command, and update them to the new module path.

- [ ] **Step 6: Commit**

```bash
git add -A backend/
git commit -m "Cut over to Postgres: assemble app.main, remove MongoDB server.py and drivers"
```

---

## Post-migration manual verification (not automatable)

After Task 12, manually smoke-test against the real Supabase project (not just automated tests) by running the frontend against this backend and walking through: sign up, sign in, Google sign-in, create a customer, create a catalog item, create an invoice with 2+ line items, verify totals match, mark it paid, view the dashboard, duplicate an invoice, void an invoice. This confirms the migration end-to-end in a way the existing test suite's coverage gaps (e.g., no test for `/invoices/{id}/duplicate` today) can't.
