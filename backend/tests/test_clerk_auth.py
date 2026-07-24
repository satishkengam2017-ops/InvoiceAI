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
from app.db import SessionLocal, engine
from app.models import Business, User


def run(coro):
    """Run coro to completion, then dispose the shared async engine's
    connection pool before this event loop closes.

    app.db.engine is a module-level singleton shared by every test in this
    file. Its connection pool caches asyncpg connections that are bound to
    whichever event loop created them (pool_pre_ping=True still requires
    pinging/closing a connection on the loop that created it). Since each
    test here gets its own asyncio.run() (its own event loop), a pooled
    connection left over from one test's loop is unusable — and unclosable
    — once that loop is gone: the next test's asyncio.run() would hand it
    back out and blow up with "Event loop is closed" the moment SQLAlchemy
    tries to ping or terminate it. Disposing here, still inside the
    just-finished loop, closes those connections while their loop is still
    alive, so the next test starts with an empty pool and opens fresh
    connections under its own loop.
    """
    async def _run_and_dispose():
        try:
            return await coro
        finally:
            await engine.dispose()

    return asyncio.run(_run_and_dispose())


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
