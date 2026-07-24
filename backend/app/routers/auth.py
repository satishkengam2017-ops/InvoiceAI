"""Auth routes: register, login, me, clerk-exchange."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
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
from app.models import User
from app.schemas import ClerkExchangeIn, LoginIn, MeOut, RegisterIn, TokenOut

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


@router.post("/clerk-exchange", response_model=TokenOut)
async def clerk_exchange(payload: ClerkExchangeIn, db: AsyncSession = Depends(get_db)):
    user_id, business_id, _is_new = await resolve_clerk_user(db, payload.clerk_token)
    return TokenOut(access_token=make_token(user_id, business_id))
