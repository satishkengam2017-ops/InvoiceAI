"""Auth routes: register, login, me, clerk-exchange, forgot/reset password."""
import asyncio
import os
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, update as sql_update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import (
    _create_business_and_user,
    get_current_user,
    make_token,
    pwd_ctx,
    resolve_clerk_user,
)
from app.db import get_db
from app.mailer import send_email
from app.models import PasswordResetCode, User, new_id
from app.schemas import (
    ClerkExchangeIn,
    ForgotPasswordIn,
    LoginIn,
    MeOut,
    RegisterIn,
    ResetPasswordIn,
    TokenOut,
)

router = APIRouter(prefix="/auth", tags=["auth"])

RESET_CODE_TTL_MINUTES = 15
RESET_CODE_MAX_ATTEMPTS = 5
AUTH_DEV_EXPOSE_RESET_CODE = os.environ.get("AUTH_DEV_EXPOSE_RESET_CODE") == "1"


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


@router.post("/clerk-exchange", response_model=TokenOut)
async def clerk_exchange(payload: ClerkExchangeIn, db: AsyncSession = Depends(get_db)):
    user_id, business_id, _is_new = await resolve_clerk_user(db, payload.clerk_token)
    return TokenOut(access_token=make_token(user_id, business_id))


@router.post("/forgot-password")
async def forgot_password(payload: ForgotPasswordIn, db: AsyncSession = Depends(get_db)):
    generic_response = {"message": "If that email is registered, a code has been sent."}
    user = (await db.execute(select(User).where(User.email == payload.email.lower()))).scalar_one_or_none()
    if not user:
        return generic_response

    # Invalidate any previous unused code for this user before issuing a new one.
    await db.execute(
        sql_update(PasswordResetCode)
        .where(PasswordResetCode.user_id == user.id, PasswordResetCode.used_at.is_(None))
        .values(used_at=datetime.now(timezone.utc))
    )

    code = str(secrets.randbelow(900000) + 100000)
    db.add(PasswordResetCode(
        id=new_id(),
        user_id=user.id,
        code_hash=pwd_ctx.hash(code),
        expires_at=datetime.now(timezone.utc) + timedelta(minutes=RESET_CODE_TTL_MINUTES),
    ))
    await db.commit()

    if AUTH_DEV_EXPOSE_RESET_CODE:
        return {**generic_response, "dev_code": code}

    await asyncio.to_thread(
        send_email,
        to=user.email,
        subject="Your InvoiceAI password reset code",
        body=f"Your password reset code is {code}. It expires in {RESET_CODE_TTL_MINUTES} minutes.",
    )
    return generic_response


@router.post("/reset-password")
async def reset_password(payload: ResetPasswordIn, db: AsyncSession = Depends(get_db)):
    invalid = HTTPException(status_code=400, detail="Code expired or invalid. Request a new one.")

    user = (await db.execute(select(User).where(User.email == payload.email.lower()))).scalar_one_or_none()
    if not user:
        raise invalid

    reset_code = (
        await db.execute(
            select(PasswordResetCode)
            .where(PasswordResetCode.user_id == user.id, PasswordResetCode.used_at.is_(None))
            .order_by(PasswordResetCode.created_at.desc())
        )
    ).scalars().first()

    now = datetime.now(timezone.utc)
    if reset_code:
        expires_at = reset_code.expires_at if reset_code.expires_at.tzinfo else reset_code.expires_at.replace(tzinfo=timezone.utc)
    if not reset_code or expires_at < now or reset_code.attempts >= RESET_CODE_MAX_ATTEMPTS:
        raise invalid

    if not pwd_ctx.verify(payload.code, reset_code.code_hash):
        reset_code.attempts += 1
        await db.commit()
        raise invalid

    reset_code.used_at = now
    user.password_hash = pwd_ctx.hash(payload.new_password)
    await db.commit()
    return {"message": "Password updated."}
