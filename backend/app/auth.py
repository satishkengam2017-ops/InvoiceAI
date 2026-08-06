"""Auth core: JWT issuing/verification and the shared business+user creation
helper, plus Clerk Google sign-in verification.
"""
import os
from datetime import datetime, timedelta, timezone
from typing import Optional

from clerk_backend_api import Clerk
from clerk_backend_api.security import (
    TokenVerificationError,
    VerifyTokenOptions,
    verify_token_async,
)
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db, to_dict
from app.expense_category_defaults import DEFAULT_EXPENSE_CATEGORIES
from app.models import Business, ExpenseCategory, User, new_id

JWT_SECRET = os.environ.get("JWT_SECRET", "dev-secret-change-me-in-prod-invoiceai-32chars")
JWT_ALG = "HS256"
JWT_EXPIRES_MIN = 60 * 24 * 30  # 30 days

CLERK_SECRET_KEY = os.environ.get("CLERK_SECRET_KEY", "")
clerk_client = Clerk(bearer_auth=CLERK_SECRET_KEY)

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
    for name, cra_line in DEFAULT_EXPENSE_CATEGORIES:
        db.add(ExpenseCategory(
            id=new_id(), business_id=business_id, name=name, cra_t2125_line=cra_line,
            is_default=True, archived=False,
        ))
    await db.commit()
    return user_id, business_id


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
