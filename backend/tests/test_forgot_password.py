"""Tests for POST /api/auth/forgot-password and /api/auth/reset-password.

Requires AUTH_DEV_EXPOSE_RESET_CODE=1 on the backend so these tests can
retrieve the real code without a live Hostinger mailbox - see this file's
usage of `dev_code` in the /forgot-password response.
"""
import os
import uuid

import pytest
import requests

from conftest import API


@pytest.fixture(scope="module")
def dev_mode():
    if os.environ.get("TEST_AUTH_DEV_EXPOSE_RESET_CODE") != "1":
        pytest.skip("Backend must be booted with AUTH_DEV_EXPOSE_RESET_CODE=1 for these tests")


def _run(coro):
    """Run coro to completion, then dispose the shared async engine's
    connection pool before this event loop closes.

    See tests/test_clerk_auth.py's `run()` helper for the full explanation:
    SQLAlchemy's async engine binds its connection pool to whichever event
    loop first uses it, so a second independent asyncio.run() call in this
    same worker process (this file has two: in test_expired_code_rejected
    and test_google_only_account_can_set_a_password) would otherwise try to
    reuse a pooled connection bound to the now-closed prior loop and blow up
    with "Event loop is closed". Disposing here, still inside the
    just-finished loop, avoids that.
    """
    import asyncio

    from app.db import engine

    async def _run_and_dispose():
        try:
            return await coro
        finally:
            await engine.dispose()

    return asyncio.run(_run_and_dispose())


def _fresh_user():
    email = f"TEST_fp_{uuid.uuid4().hex[:10]}@example.com"
    password = "OldPassword123!"
    r = requests.post(f"{API}/auth/register", json={
        "email": email, "password": password, "business_name": "TEST_FP_BIZ"
    })
    assert r.status_code == 200, r.text
    return email, password


def _request_code(email: str) -> str:
    r = requests.post(f"{API}/auth/forgot-password", json={"email": email})
    assert r.status_code == 200, r.text
    body = r.json()
    assert "dev_code" in body, "backend must be booted with AUTH_DEV_EXPOSE_RESET_CODE=1"
    return body["dev_code"]


class TestForgotPassword:
    def test_unknown_email_returns_generic_200(self, dev_mode):
        r = requests.post(f"{API}/auth/forgot-password", json={"email": "nobody_TEST@example.com"})
        assert r.status_code == 200
        assert "message" in r.json()
        assert "dev_code" not in r.json()

    def test_full_reset_flow_succeeds(self, dev_mode):
        email, _old_password = _fresh_user()
        code = _request_code(email)

        r = requests.post(f"{API}/auth/reset-password", json={
            "email": email, "code": code, "new_password": "NewPassword456!",
        })
        assert r.status_code == 200, r.text

        # Old password no longer works, new one does.
        r = requests.post(f"{API}/auth/login", json={"email": email, "password": "OldPassword123!"})
        assert r.status_code == 400
        r = requests.post(f"{API}/auth/login", json={"email": email, "password": "NewPassword456!"})
        assert r.status_code == 200

    def test_wrong_code_eventually_locks_out_the_code(self, dev_mode):
        email, _ = _fresh_user()
        code = _request_code(email)

        # 5 wrong attempts (RESET_CODE_MAX_ATTEMPTS) exhaust the code...
        for _ in range(5):
            r = requests.post(f"{API}/auth/reset-password", json={
                "email": email, "code": "000000", "new_password": "NewPassword456!",
            })
            assert r.status_code == 400

        # ...so even the real code is now rejected without requesting a new one.
        r = requests.post(f"{API}/auth/reset-password", json={
            "email": email, "code": code, "new_password": "NewPassword456!",
        })
        assert r.status_code == 400

    def test_expired_code_rejected(self, dev_mode):
        from datetime import datetime, timedelta, timezone

        from app.db import SessionLocal
        from app.models import PasswordResetCode
        from sqlalchemy import select as sa_select

        email, _ = _fresh_user()
        code = _request_code(email)

        async def _expire_it():
            async with SessionLocal() as db:
                rc = (await db.execute(
                    sa_select(PasswordResetCode).order_by(PasswordResetCode.created_at.desc())
                )).scalars().first()
                rc.expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
                await db.commit()

        _run(_expire_it())

        r = requests.post(f"{API}/auth/reset-password", json={
            "email": email, "code": code, "new_password": "NewPassword456!",
        })
        assert r.status_code == 400

    def test_code_is_single_use(self, dev_mode):
        email, _ = _fresh_user()
        code = _request_code(email)

        r1 = requests.post(f"{API}/auth/reset-password", json={
            "email": email, "code": code, "new_password": "First123!",
        })
        assert r1.status_code == 200

        r2 = requests.post(f"{API}/auth/reset-password", json={
            "email": email, "code": code, "new_password": "Second456!",
        })
        assert r2.status_code == 400

    def test_requesting_new_code_invalidates_previous_one(self, dev_mode):
        email, _ = _fresh_user()
        old_code = _request_code(email)
        _request_code(email)  # invalidates old_code

        r = requests.post(f"{API}/auth/reset-password", json={
            "email": email, "code": old_code, "new_password": "NewPassword456!",
        })
        assert r.status_code == 400

    def test_google_only_account_can_set_a_password(self, dev_mode):
        # Simulate a Google-only account the same way test_clerk_auth.py's
        # fixtures do: register normally, then blank password_hash directly,
        # since there's no HTTP path to create a clerk_user_id-only account
        # without a live Clerk token.
        from app.db import SessionLocal
        from app.models import User
        from sqlalchemy import select as sa_select

        email, _ = _fresh_user()

        async def _blank_password():
            async with SessionLocal() as db:
                user = (await db.execute(sa_select(User).where(User.email == email.lower()))).scalar_one()
                user.password_hash = None
                await db.commit()

        _run(_blank_password())

        code = _request_code(email)
        r = requests.post(f"{API}/auth/reset-password", json={
            "email": email, "code": code, "new_password": "BrandNewPassword789!",
        })
        assert r.status_code == 200, r.text

        r = requests.post(f"{API}/auth/login", json={"email": email, "password": "BrandNewPassword789!"})
        assert r.status_code == 200


class TestForgotPasswordEmailFailureIsNonFatal:
    """The generic-response guarantee must hold even when email delivery
    fails - otherwise a rejected send turns into a 500-vs-200 enumeration
    oracle distinct from the timing side-channel the design doc already
    accepts. This needs its own server process booted with a deliberately
    invalid Resend API key and the dev-code flag OFF (unlike every other
    test in this file), so it's isolated here rather than sharing the
    module-level server the other tests rely on. This hits Resend's real
    API (which will reject the bad key with 401) rather than mocking it,
    since the whole point is verifying our own error handling around a
    real failed response, not the mailer's HTTP call itself.
    """

    def test_email_send_failure_still_returns_generic_200(self):
        import subprocess
        import sys
        import time

        env = os.environ.copy()
        env["RESEND_API_KEY"] = "re_invalid_test_key_expected_to_be_rejected"
        env["RESEND_FROM_EMAIL"] = "test@example.com"
        env.pop("AUTH_DEV_EXPOSE_RESET_CODE", None)

        port = 8031
        backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        proc = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "app.main:app", "--port", str(port), "--host", "127.0.0.1"],
            cwd=backend_dir,
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            base = f"http://127.0.0.1:{port}/api"
            for _ in range(30):
                try:
                    if requests.get(f"{base}/health", timeout=1).status_code == 200:
                        break
                except requests.exceptions.ConnectionError:
                    pass
                time.sleep(1)
            else:
                pytest.fail("test server did not start")

            email = f"TEST_fp_emailfail_{uuid.uuid4().hex[:10]}@example.com"
            r = requests.post(f"{base}/auth/register", json={
                "email": email, "password": "Password123!", "business_name": "TEST_FP_EMAIL_FAIL"
            })
            assert r.status_code == 200, r.text

            r = requests.post(f"{base}/auth/forgot-password", json={"email": email})
            assert r.status_code == 200, r.text
            assert "dev_code" not in r.json()
        finally:
            proc.terminate()
            proc.wait(timeout=10)
