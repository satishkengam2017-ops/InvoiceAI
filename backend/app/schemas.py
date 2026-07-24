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
