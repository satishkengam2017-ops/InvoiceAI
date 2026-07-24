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

sys.path.insert(0, str(Path(__file__).parent.parent))
import server  # noqa: E402


def run(coro):
    return asyncio.run(coro)


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
