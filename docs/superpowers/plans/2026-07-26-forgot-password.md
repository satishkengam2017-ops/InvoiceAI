# Forgot Password Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user who forgot their password request a 6-digit email code and use it to set a new password, entirely through our own backend (Clerk is not involved — it never manages email/password accounts).

**Architecture:** A new `PasswordResetCode` table stores a bcrypt hash of a random 6-digit code plus its expiry/attempt count. `POST /api/auth/forgot-password` generates and emails one (via SMTP through the user's Hostinger mailbox); `POST /api/auth/reset-password` validates the submitted code and updates `User.password_hash`. Two new Expo Router screens drive the flow; a "Forgot password?" link is added to the existing sign-in screen.

**Tech Stack:** FastAPI, SQLAlchemy 2.0 (async), Alembic, Python stdlib `smtplib`, Pydantic, React Native (Expo Router).

## Global Constraints

- Codes are 6 digits, generated with `secrets.randbelow` (not `random`), stored only as a bcrypt hash via the existing `pwd_ctx` (`app/auth.py`) — never in plaintext.
- Code expiry: 15 minutes. Max wrong-code attempts per code: 5. Both are fixed constants, not configurable.
- `POST /forgot-password` always returns the same generic `200` message regardless of whether the email is registered (no user enumeration).
- Requesting a new code invalidates (marks used) any previous unused code for that user.
- `new_password` on `POST /reset-password` uses the same `min_length=6` rule as `RegisterIn.password`.
- An account with no `password_hash` yet (Google-only) can complete this flow to set one for the first time; it does not disable their existing Google sign-in.
- New env vars: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM_EMAIL`. Document them in `backend/.env.example`.
- Test-only env var `AUTH_DEV_EXPOSE_RESET_CODE=1`: when set, `/forgot-password` skips sending real email and instead returns the plaintext code as `dev_code` in the JSON response, so automated tests (and local dev without SMTP creds configured) can complete the flow without a live mailbox. Must never be read as `"1"` unless explicitly set — default behavior (unset) always attempts real email delivery.
- No native deep-linking, no resend-cooldown/rate-limiting — both explicitly out of scope per the spec.

---

### Task 1: `PasswordResetCode` model and migration

**Files:**
- Modify: `backend/app/models.py`
- Create: `backend/alembic/versions/<new>_add_password_reset_codes.py`

**Interfaces:**
- Consumes: `Base` (from `app.db`), `new_id()` (both already in `models.py`), existing `users` table.
- Produces: `PasswordResetCode` model with columns `id: str`, `user_id: str`, `code_hash: str`, `expires_at: datetime`, `attempts: int`, `used_at: Optional[datetime]`, `created_at: datetime` — consumed by Task 3's endpoints.

- [ ] **Step 1: Add the model**

In `backend/app/models.py`, find the `WebhookEvent` class (it's the last class in the file):

```python
class WebhookEvent(Base):
    __tablename__ = "webhook_events"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    type: Mapped[str] = mapped_column(String)
    processed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
```

Add a new class immediately after it:

```python
class PasswordResetCode(Base):
    __tablename__ = "password_reset_codes"

    id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    code_hash: Mapped[str] = mapped_column(String)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    used_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
```

`Integer`, `Optional`, `PG_UUID`, `ForeignKey`, `DateTime`, `func`, `Mapped`, `mapped_column` are all already imported at the top of `models.py` — no new imports needed.

- [ ] **Step 2: Generate and fill in the Alembic migration**

From `backend/`, run:

```bash
.venv\Scripts\python.exe -m alembic revision -m "add_password_reset_codes"
```

This creates a new file in `backend/alembic/versions/` with an auto-generated revision ID and `down_revision = '4cd3abf46add'` (the current head — confirmed by `backend/alembic/versions/4cd3abf46add_add_gst_hst_number.py` having no migration after it). Open the new file and replace its `upgrade()`/`downgrade()` functions with:

```python
def upgrade() -> None:
    op.create_table(
        'password_reset_codes',
        sa.Column('id', postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column('user_id', postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column('code_hash', sa.String(), nullable=False),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('attempts', sa.Integer(), nullable=False),
        sa.Column('used_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_password_reset_codes_user_id'), 'password_reset_codes', ['user_id'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_password_reset_codes_user_id'), table_name='password_reset_codes')
    op.drop_table('password_reset_codes')
```

Add this import near the top of the same file, alongside the existing `import sqlalchemy as sa`:

```python
from sqlalchemy.dialects import postgresql
```

- [ ] **Step 3: Apply the migration and verify**

From `backend/`, with a real `DATABASE_URL`/`DATABASE_URL_DIRECT` configured in `.env` (copy from an existing worktree if you don't have your own — never print its contents):

```bash
.venv\Scripts\python.exe -m alembic upgrade head
```

Expected: command exits with no error, and its output includes a line ending in `-> <new_revision_id>, add_password_reset_codes`.

- [ ] **Step 4: Commit**

```bash
git add backend/app/models.py backend/alembic/versions/
git commit -m "Add PasswordResetCode model and migration"
```

---

### Task 2: SMTP mailer module

**Files:**
- Create: `backend/app/mailer.py`
- Create: `backend/tests/test_mailer.py`
- Modify: `backend/.env.example`

**Interfaces:**
- Produces: `send_email(to: str, subject: str, body: str) -> None` in `app.mailer` — consumed by Task 3's `/forgot-password` endpoint. Raises if `SMTP_HOST`/`SMTP_USERNAME`/`SMTP_PASSWORD` env vars are unset (`KeyError`, matching the existing `os.environ["..."]` fail-fast style used for `DATABASE_URL` in `app/db.py`).

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_mailer.py`:

```python
"""Tests for app.mailer.send_email — mocks smtplib since we don't want real
emails sent in automated tests, and no live Hostinger credentials are
guaranteed to be present in a test environment. This is a pure unit test of
our own adapter code around a stdlib protocol, not an integration test of
our own systems, so mocking here is appropriate.
"""
from unittest.mock import MagicMock, patch

import pytest

from app.mailer import send_email


@pytest.fixture(autouse=True)
def smtp_env(monkeypatch):
    monkeypatch.setenv("SMTP_HOST", "smtp.hostinger.com")
    monkeypatch.setenv("SMTP_PORT", "465")
    monkeypatch.setenv("SMTP_USERNAME", "test@example.com")
    monkeypatch.setenv("SMTP_PASSWORD", "test-password")
    monkeypatch.setenv("SMTP_FROM_EMAIL", "test@example.com")


def test_send_email_calls_smtp_with_correct_args():
    mock_server = MagicMock()
    mock_smtp_ssl = MagicMock()
    mock_smtp_ssl.return_value.__enter__.return_value = mock_server

    with patch("smtplib.SMTP_SSL", mock_smtp_ssl):
        send_email(to="user@example.com", subject="Test Subject", body="Test body")

    mock_smtp_ssl.assert_called_once_with("smtp.hostinger.com", 465)
    mock_server.login.assert_called_once_with("test@example.com", "test-password")
    assert mock_server.sendmail.call_count == 1
    from_email, to_list, message = mock_server.sendmail.call_args.args
    assert from_email == "test@example.com"
    assert to_list == ["user@example.com"]
    assert "Test Subject" in message
    assert "Test body" in message
```

- [ ] **Step 2: Run the test and verify it fails**

From `backend/`:

```bash
.venv\Scripts\python.exe -m pytest tests/test_mailer.py -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'app.mailer'`.

- [ ] **Step 3: Implement the mailer**

Create `backend/app/mailer.py`:

```python
"""Minimal SMTP mailer for transactional emails (e.g. password reset codes).

Uses the account's own Hostinger mailbox over SMTP rather than a dedicated
transactional-email API - see
docs/superpowers/specs/2026-07-26-forgot-password-design.md for why.
"""
import os
import smtplib
from email.mime.text import MIMEText


def send_email(to: str, subject: str, body: str) -> None:
    host = os.environ["SMTP_HOST"]
    port = int(os.environ.get("SMTP_PORT", "465"))
    username = os.environ["SMTP_USERNAME"]
    password = os.environ["SMTP_PASSWORD"]
    from_email = os.environ.get("SMTP_FROM_EMAIL", username)

    msg = MIMEText(body)
    msg["Subject"] = subject
    msg["From"] = from_email
    msg["To"] = to

    with smtplib.SMTP_SSL(host, port) as server:
        server.login(username, password)
        server.sendmail(from_email, [to], msg.as_string())
```

- [ ] **Step 4: Run the test and verify it passes**

```bash
.venv\Scripts\python.exe -m pytest tests/test_mailer.py -v
```

Expected: `1 passed`.

- [ ] **Step 5: Document the new env vars**

In `backend/.env.example`, add at the end of the file:

```
# SMTP credentials for sending the forgot-password reset code. Uses a
# regular mailbox (e.g. Hostinger) over SMTP, not a transactional-email API.
SMTP_HOST=smtp.hostinger.com
SMTP_PORT=465
SMTP_USERNAME=
SMTP_PASSWORD=
SMTP_FROM_EMAIL=
```

- [ ] **Step 6: Commit**

```bash
git add backend/app/mailer.py backend/tests/test_mailer.py backend/.env.example
git commit -m "Add SMTP mailer module for password reset emails"
```

---

### Task 3: `/forgot-password` and `/reset-password` endpoints

**Files:**
- Modify: `backend/app/schemas.py`
- Modify: `backend/app/routers/auth.py`
- Create: `backend/tests/test_forgot_password.py`

**Interfaces:**
- Consumes: `PasswordResetCode`, `User`, `new_id` (from `app.models`); `pwd_ctx`, `get_db` (already imported in `auth.py`); `send_email` (from `app.mailer`, Task 2).
- Produces: `POST /api/auth/forgot-password` and `POST /api/auth/reset-password` — no other task depends on these directly; Task 4/5 (frontend) call them by URL string, not by importing anything.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_forgot_password.py`:

```python
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

        import asyncio

        async def _expire_it():
            async with SessionLocal() as db:
                rc = (await db.execute(
                    sa_select(PasswordResetCode).order_by(PasswordResetCode.created_at.desc())
                )).scalars().first()
                rc.expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
                await db.commit()

        asyncio.run(_expire_it())

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

        import asyncio

        async def _blank_password():
            async with SessionLocal() as db:
                user = (await db.execute(sa_select(User).where(User.email == email.lower()))).scalar_one()
                user.password_hash = None
                await db.commit()

        asyncio.run(_blank_password())

        code = _request_code(email)
        r = requests.post(f"{API}/auth/reset-password", json={
            "email": email, "code": code, "new_password": "BrandNewPassword789!",
        })
        assert r.status_code == 200, r.text

        r = requests.post(f"{API}/auth/login", json={"email": email, "password": "BrandNewPassword789!"})
        assert r.status_code == 200
```

- [ ] **Step 2: Run the tests and verify they fail**

From `backend/`:

```bash
.venv\Scripts\python.exe -m pytest tests/test_forgot_password.py -v
```

Expected: all tests SKIPPED (not yet booted with `AUTH_DEV_EXPOSE_RESET_CODE=1` / `TEST_AUTH_DEV_EXPOSE_RESET_CODE` unset). This is expected at this point — the real verification happens in Step 4, once the server is booted correctly.

- [ ] **Step 3: Implement the schemas**

In `backend/app/schemas.py`, add after `LoginIn`:

```python
class ForgotPasswordIn(BaseModel):
    email: EmailStr


class ResetPasswordIn(BaseModel):
    email: EmailStr
    code: str
    new_password: str = Field(min_length=6)
```

- [ ] **Step 4: Implement the endpoints**

In `backend/app/routers/auth.py`, update the imports at the top:

```python
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
```

Then add these two routes at the end of the file (after `clerk_exchange`):

```python
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
```

- [ ] **Step 5: Run the tests and verify they pass**

From `backend/`, boot the server with the dev flag set (in addition to your normal `.env` — never print its contents):

```bash
set -a; source .env; set +a
export AUTH_DEV_EXPOSE_RESET_CODE=1
.venv/Scripts/python.exe -m uvicorn app.main:app --port 8000 &
```

Wait for `curl -s http://127.0.0.1:8000/api/health` to return `{"status":"ok",...}`, then in another shell (same working directory):

```bash
export EXPO_PUBLIC_BACKEND_URL="http://127.0.0.1:8000"
export TEST_AUTH_DEV_EXPOSE_RESET_CODE=1
.venv/Scripts/python.exe -m pytest tests/test_forgot_password.py -v
```

Expected: `7 passed`. Then stop the background server.

- [ ] **Step 6: Commit**

```bash
git add backend/app/schemas.py backend/app/routers/auth.py backend/tests/test_forgot_password.py
git commit -m "Add /forgot-password and /reset-password endpoints"
```

---

### Task 4: Frontend — forgot-password and reset-password screens

**Files:**
- Create: `frontend/app/(auth)/forgot-password.tsx`
- Create: `frontend/app/(auth)/reset-password.tsx`
- Modify: `frontend/app/(auth)/sign-in.tsx`

**Interfaces:**
- Consumes: `api.post` (from `@/src/lib/api`, existing), `Input`/`Button` (existing components), `colors`/`spacing`/`typography`/`webContent` (from `@/src/lib/theme`, existing).
- Produces: routes `/(auth)/forgot-password` and `/(auth)/reset-password` — no other task depends on these.

There is no automated test harness for frontend screens in this codebase (no RN Testing Library setup) — existing screens like `sign-in.tsx`/`sign-up.tsx` are verified by running the app. This task's verification step (Step 4) is manual, matching that precedent.

- [ ] **Step 1: Create the forgot-password screen**

Create `frontend/app/(auth)/forgot-password.tsx`:

```tsx
import { useRouter } from "expo-router";
import React, { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Button } from "@/src/components/Button";
import { Input } from "@/src/components/Input";
import { api } from "@/src/lib/api";
import { colors, spacing, typography, webContent } from "@/src/lib/theme";

export default function ForgotPassword() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onSubmit = async () => {
    setErr(null);
    setLoading(true);
    try {
      await api.post("/auth/forgot-password", { email: email.trim().toLowerCase() });
      router.push({ pathname: "/(auth)/reset-password", params: { email: email.trim().toLowerCase() } });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={[styles.scroll, webContent]} keyboardShouldPersistTaps="handled">
          <View style={styles.brand}>
            <Text style={styles.brandMark}>Forgot password?</Text>
            <Text style={styles.subtitle}>
              Enter your email and we'll send you a 6-digit code to reset your password.
            </Text>
          </View>

          <View style={styles.form}>
            <Input
              testID="forgot-password-email"
              label="Email"
              autoCapitalize="none"
              keyboardType="email-address"
              autoComplete="email"
              value={email}
              onChangeText={setEmail}
              placeholder="you@company.com"
            />
            {err ? <Text style={styles.err}>{err}</Text> : null}
            <Button testID="forgot-password-submit" title="Send code" loading={loading} onPress={onSubmit} />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  scroll: { flexGrow: 1, padding: spacing.xl, justifyContent: "center" },
  brand: { marginBottom: spacing.xxxl },
  brandMark: {
    fontSize: 28,
    fontWeight: "600",
    color: colors.onSurface,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: typography.lg,
    color: colors.muted,
    marginTop: spacing.md,
    lineHeight: 22,
  },
  form: {},
  err: {
    color: colors.error,
    fontSize: typography.base,
    marginBottom: spacing.md,
  },
});
```

- [ ] **Step 2: Create the reset-password screen**

Create `frontend/app/(auth)/reset-password.tsx`:

```tsx
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Button } from "@/src/components/Button";
import { Input } from "@/src/components/Input";
import { api } from "@/src/lib/api";
import { colors, spacing, typography, webContent } from "@/src/lib/theme";

export default function ResetPassword() {
  const router = useRouter();
  const { email: emailParam } = useLocalSearchParams<{ email?: string }>();
  const [email, setEmail] = useState(emailParam ?? "");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onSubmit = async () => {
    setErr(null);
    if (newPassword.length < 6) return setErr("Password must be at least 6 characters");
    if (newPassword !== confirmPassword) return setErr("Passwords do not match");
    setLoading(true);
    try {
      await api.post("/auth/reset-password", {
        email: email.trim().toLowerCase(),
        code: code.trim(),
        new_password: newPassword,
      });
      router.replace("/(auth)/sign-in");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={[styles.scroll, webContent]} keyboardShouldPersistTaps="handled">
          <View style={styles.brand}>
            <Text style={styles.brandMark}>Enter your code</Text>
            <Text style={styles.subtitle}>Check your email for the 6-digit code, then set a new password.</Text>
          </View>

          <View style={styles.form}>
            <Input
              testID="reset-password-email"
              label="Email"
              autoCapitalize="none"
              keyboardType="email-address"
              autoComplete="email"
              value={email}
              onChangeText={setEmail}
              placeholder="you@company.com"
            />
            <Input
              testID="reset-password-code"
              label="6-digit code"
              keyboardType="number-pad"
              maxLength={6}
              value={code}
              onChangeText={setCode}
              placeholder="123456"
            />
            <Input
              testID="reset-password-new"
              label="New password"
              secureTextEntry
              value={newPassword}
              onChangeText={setNewPassword}
              placeholder="••••••••"
            />
            <Input
              testID="reset-password-confirm"
              label="Confirm new password"
              secureTextEntry
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              placeholder="••••••••"
            />
            {err ? <Text style={styles.err}>{err}</Text> : null}
            <Button testID="reset-password-submit" title="Reset password" loading={loading} onPress={onSubmit} />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  scroll: { flexGrow: 1, padding: spacing.xl, justifyContent: "center" },
  brand: { marginBottom: spacing.xxxl },
  brandMark: {
    fontSize: 28,
    fontWeight: "600",
    color: colors.onSurface,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: typography.lg,
    color: colors.muted,
    marginTop: spacing.md,
    lineHeight: 22,
  },
  form: {},
  err: {
    color: colors.error,
    fontSize: typography.base,
    marginBottom: spacing.md,
  },
});
```

- [ ] **Step 3: Add the "Forgot password?" link to sign-in**

In `frontend/app/(auth)/sign-in.tsx`, the imports currently start with:

```tsx
import { Link } from "expo-router";
```

No change needed there (`Link` is already imported). Find this block:

```tsx
            {err ? <Text style={styles.err}>{err}</Text> : null}
            <Button testID="sign-in-submit" title="Sign In" loading={loading} onPress={onSubmit} />
            <GoogleSignInButton onError={setErr} />

            <Link href="/(auth)/sign-up" asChild>
              <Text testID="sign-in-link-signup" style={styles.link}>
                New here? Create an account
              </Text>
            </Link>
```

Replace it with:

```tsx
            {err ? <Text style={styles.err}>{err}</Text> : null}
            <Button testID="sign-in-submit" title="Sign In" loading={loading} onPress={onSubmit} />
            <GoogleSignInButton onError={setErr} />

            <Link href="/(auth)/forgot-password" asChild>
              <Text testID="sign-in-link-forgot-password" style={styles.link}>
                Forgot password?
              </Text>
            </Link>

            <Link href="/(auth)/sign-up" asChild>
              <Text testID="sign-in-link-signup" style={styles.link}>
                New here? Create an account
              </Text>
            </Link>
```

- [ ] **Step 4: Verify manually in the browser**

Start the frontend dev server (`npx expo start --web` from `frontend/`, or via the project's existing dev-server workflow) and the backend (with real SMTP env vars set, or `AUTH_DEV_EXPOSE_RESET_CODE=1` to see the code without a real email — check server logs/response, not the UI, since the UI never displays `dev_code`). Then:

1. Go to `/(auth)/sign-in`. Confirm "Forgot password?" appears below "Continue with Google".
2. Tap it. Confirm it navigates to a screen asking for an email.
3. Enter a real registered test account's email, submit. Confirm it navigates to the code-entry screen with the email pre-filled.
4. Retrieve the code (real inbox, or the `dev_code` field via the network tab if using the dev flag) and enter it along with a new password (twice, matching). Submit.
5. Confirm it redirects to `/(auth)/sign-in`, and that logging in with the new password succeeds.

- [ ] **Step 5: Commit**

```bash
git add "frontend/app/(auth)/forgot-password.tsx" "frontend/app/(auth)/reset-password.tsx" "frontend/app/(auth)/sign-in.tsx"
git commit -m "Add forgot-password and reset-password screens"
```

---

## Self-Review Notes

- **Spec coverage:** every section of `docs/superpowers/specs/2026-07-26-forgot-password-design.md` maps to a task above — SMTP delivery (Task 2), data model (Task 1), API (Task 3), frontend (Task 4), Google-only account handling (Task 3's `test_google_only_account_can_set_a_password`), out-of-scope items are explicitly not built. First pass was missing two items from the spec's own testing checklist ("wrong code eventually locks out the code" and "expired code is rejected") — fixed by replacing the single-wrong-attempt test with one that drives to full lockout, and adding a dedicated expired-code test that backdates `expires_at` directly in the DB (mirroring the `paid_at` backdating pattern from the dashboard-charts feature's test suite).
- **Type consistency:** `ForgotPasswordIn`/`ResetPasswordIn` (Task 3, Step 3) match the request bodies used in Task 3's tests (Step 1) and Task 4's `api.post` calls exactly (`email`, `code`, `new_password`).
- **No placeholders:** every step has complete, runnable code — no "TBD" or "add validation" left unshown.
