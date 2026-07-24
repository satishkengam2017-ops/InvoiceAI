"""Unit tests for Clerk-related auth behavior.

Unlike test_backend.py (which drives a live running server over HTTP via
conftest.py), these tests import server.py directly and call its functions
in-process. This is needed here because there's no public API to create a
password-less (Google-only) user to test the login guard against, and it's
needed later in this file because Task 4's Clerk verification calls must be
mocked (there's no live Clerk session token available in CI).
"""
import asyncio
import sys
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).parent.parent))
import server  # noqa: E402

from clerk_backend_api.security import TokenVerificationError, TokenVerificationErrorReason


def run(coro):
    return asyncio.run(coro)


def run_db(coro_factory):
    """Like run(), but for tests that make more than one separate top-level
    asyncio.run() call that touches the shared Motor `db`/`client` from
    server.py. Takes a zero-arg callable that *builds* the coroutine (e.g.
    `lambda: server.db.users.find_one(...)`), not an already-built coroutine
    -- Motor's wrapper methods (e.g. find_one) capture the event loop
    synchronously at call time, not when the coroutine/future is later
    awaited, so `coro_factory` must only be invoked once we're actually
    inside the running loop (see the inner `_runner` below), never as a
    plain argument expression (which evaluates before asyncio.run() starts).

    Motor 3.x's AsyncIOMotorClient lazily binds to whatever event loop is
    running the first time it's used, then caches that loop forever
    (motor.core.AgnosticBaseProperties.io_loop). asyncio.run() creates a new
    event loop per call and closes it on exit, so a second independent
    asyncio.run() call in the same process raises "RuntimeError: Event loop
    is closed" the moment it touches the db. Resetting the cached loop before
    each such call makes the client re-bind to the loop that's actually
    running. Only needed for tests with multiple separate run()/run_db()
    calls that hit the db (see TestResolveClerkUser); TestLoginGuard's single
    asyncio.run() call above doesn't need this.
    """
    server.client._io_loop = None

    async def _runner():
        return await coro_factory()

    return run(_runner())


class TestLoginGuard:
    def test_login_on_google_only_account_returns_clear_error(self):
        async def run_test():
            email = f"clerk_only_{uuid.uuid4().hex[:10]}@example.com"
            await server._create_business_and_user(
                email=email,
                business_name="Google Only Co",
                password_hash=None,
                clerk_user_id="user_fake123",
            )

            try:
                await server.login(server.LoginIn(email=email, password="anything"))
                assert False, "expected HTTPException"
            except server.HTTPException as e:
                assert e.status_code == 400
                assert e.detail == "This account uses Google sign-in. Continue with Google instead."

        asyncio.run(run_test())


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
        email = f"clerk_{uuid.uuid4().hex[:10]}@example.com"
        with patch.object(server, "verify_token_async", AsyncMock(return_value={"sub": "user_abc123"})), \
             patch.object(server.clerk_client.users, "get_async", AsyncMock(return_value=fake_clerk_user(email))):
            user_id, business_id, is_new = run_db(lambda: server.resolve_clerk_user("fake-token"))

        assert is_new is True
        biz = run_db(lambda: server.db.businesses.find_one({"id": business_id}))
        assert biz["name"] == "Ada"
        assert biz["onboarded"] is False
        user = run_db(lambda: server.db.users.find_one({"id": user_id}))
        assert user["email"] == email
        assert user["password_hash"] is None
        assert user["clerk_user_id"] == "user_abc123"

    def test_matching_email_logs_into_existing_business(self):
        email = f"clerk_link_{uuid.uuid4().hex[:10]}@example.com"
        existing_user_id, existing_business_id = run_db(
            lambda: server._create_business_and_user(
                email=email, business_name="Existing Co", password_hash="irrelevant-hash"
            )
        )

        with patch.object(server, "verify_token_async", AsyncMock(return_value={"sub": "user_xyz789"})), \
             patch.object(server.clerk_client.users, "get_async", AsyncMock(return_value=fake_clerk_user(email))):
            user_id, business_id, is_new = run_db(lambda: server.resolve_clerk_user("fake-token"))

        assert is_new is False
        assert user_id == existing_user_id
        assert business_id == existing_business_id
        # clerk_user_id should be backfilled onto the pre-existing user doc
        user = run_db(lambda: server.db.users.find_one({"id": existing_user_id}))
        assert user["clerk_user_id"] == "user_xyz789"

    def test_invalid_token_raises_401(self):
        with patch.object(
            server, "verify_token_async",
            AsyncMock(side_effect=TokenVerificationError(TokenVerificationErrorReason.TOKEN_INVALID)),
        ):
            try:
                run(server.resolve_clerk_user("garbage"))
                assert False, "expected HTTPException"
            except server.HTTPException as e:
                assert e.status_code == 401

    def test_no_verified_email_raises_400(self):
        with patch.object(server, "verify_token_async", AsyncMock(return_value={"sub": "user_no_email"})), \
             patch.object(
                 server.clerk_client.users, "get_async",
                 AsyncMock(return_value=SimpleNamespace(
                     first_name=None, primary_email_address_id=None, email_addresses=[]
                 )),
             ):
            try:
                run(server.resolve_clerk_user("fake-token"))
                assert False, "expected HTTPException"
            except server.HTTPException as e:
                assert e.status_code == 400

    def test_unverified_email_raises_400(self):
        email = f"clerk_unverified_{uuid.uuid4().hex[:10]}@example.com"
        with patch.object(server, "verify_token_async", AsyncMock(return_value={"sub": "user_unverified"})), \
             patch.object(server.clerk_client.users, "get_async", AsyncMock(return_value=fake_clerk_user(email, verified=False))):
            try:
                run(server.resolve_clerk_user("fake-token"))
                assert False, "expected HTTPException"
            except server.HTTPException as e:
                assert e.status_code == 400
