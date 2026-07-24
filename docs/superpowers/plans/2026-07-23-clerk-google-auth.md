# Google Sign-in via Clerk (Web) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users sign in/sign up with Google (web only) via Clerk, while keeping the existing custom JWT email/password system as the single source of truth for sessions.

**Architecture:** The frontend runs Clerk's Google OAuth popup only to obtain a verified identity, then exchanges that for the app's own JWT via one new backend endpoint (`POST /auth/clerk-exchange`). Every other route, `get_current_user`, and `AuthContext`'s session storage are untouched — Clerk never appears anywhere else in the stack.

**Tech Stack:** Backend: FastAPI, `clerk-backend-api` 6.x (official Clerk Python SDK), MongoDB via Motor. Frontend: Expo Router, `@clerk/expo` 4.x (current package name — NOT the older `@clerk/clerk-expo`), `useSSO` (current hook — NOT the deprecated `useOAuth`).

## Global Constraints

- Web only for this iteration. Native (iOS/Android) keeps email/password only — no Clerk code may be imported into the native bundle.
- Account linking: a Google sign-in whose verified email matches an existing user auto-links to that user's existing business (no new business created).
- New Google sign-in (no matching email) creates a business + user exactly like `/auth/register` does, `onboarded: False`, sent to onboarding.
- The response shape of `/auth/clerk-exchange` must be identical to `/auth/login` and `/auth/register` (`TokenOut`), so the frontend's existing `saveToken`/`loadSession` flow needs no changes.
- `CLERK_SECRET_KEY` (backend) and `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` (frontend) are already set in `.env` by the user — never print, log, or ask for these values.
- No changes to `get_current_user`, any of the existing protected routes, invoice/customer/catalog logic, or PDF generation.

---

## Task 1: Fix the test environment and add the Clerk backend dependency

Two things need fixing before any new backend code can be tested: `pytest.ini` requires the `pytest-xdist` plugin, which isn't currently installed (it was dropped from `requirements.txt` during an earlier dependency trim this session) — meaning the test suite can't run at all right now. This task restores it and adds the new Clerk dependency.

**Files:**
- Modify: `backend/requirements.txt`
- Modify: `backend/server.py:1-44` (imports + config section)

**Interfaces:**
- Produces: module-level `CLERK_SECRET_KEY: str` and `clerk_client: Clerk` in `server.py`, used by Task 4.

- [ ] **Step 1: Add the missing test plugin and the new Clerk dependency to requirements.txt**

Edit `backend/requirements.txt`, adding these two lines (keep the rest of the file as-is):

```
clerk-backend-api==6.0.1
pytest-xdist==3.8.0
```

- [ ] **Step 2: Install and verify the test suite can run**

Run:
```bash
cd backend
.venv\Scripts\pip.exe install -r requirements.txt
.venv\Scripts\python.exe -m pytest tests/test_backend.py -v
```
Expected: all existing tests PASS (this confirms `pytest-xdist` is now working — if this step fails with "required_plugins" errors, the install didn't take effect).

- [ ] **Step 3: Add Clerk imports and client config to server.py**

In `backend/server.py`, add to the imports block (after the existing `from anthropic import AsyncAnthropic` line):

```python
from clerk_backend_api import Clerk
from clerk_backend_api.security import (
    TokenVerificationError,
    VerifyTokenOptions,
    verify_token_async,
)
```

In the `# Config` section, right after the existing `STRIPE_WEBHOOK_SECRET = os.environ.get("STRIPE_WEBHOOK_SECRET", "")` line, add:

```python
CLERK_SECRET_KEY = os.environ.get("CLERK_SECRET_KEY", "")
clerk_client = Clerk(bearer_auth=CLERK_SECRET_KEY)
```

- [ ] **Step 4: Verify the server still starts cleanly**

Run:
```bash
cd backend
.venv\Scripts\python.exe -c "import server; print('server imports OK')"
```
Expected: `server imports OK` (confirms the new imports don't break anything, even with no live Clerk calls made yet).

- [ ] **Step 5: Commit**

```bash
git add backend/requirements.txt backend/server.py
git commit -m "Add clerk-backend-api dependency and restore pytest-xdist"
```

---

## Task 2: Extract a shared business+user creation helper

`register()` currently inlines the "create a business + user" logic. Task 4 needs the exact same logic for Google sign-ups, so extract it into a shared helper first — as a pure refactor with no behavior change, verified by the existing register tests still passing.

**Files:**
- Modify: `backend/server.py` (the `register()` function, around line 322)

**Interfaces:**
- Produces: `async def _create_business_and_user(email: str, business_name: str, password_hash: Optional[str], clerk_user_id: Optional[str] = None) -> tuple[str, str]` (returns `(user_id, business_id)`) — used directly by Task 4.

- [ ] **Step 1: Extract the helper and add the new `clerk_user_id` field**

In `backend/server.py`, replace the body of `register()`:

```python
@api.post("/auth/register", response_model=TokenOut)
async def register(payload: RegisterIn):
    existing = await db.users.find_one({"email": payload.email.lower()})
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")

    business_id = new_id()
    user_id = new_id()
    now = datetime.now(timezone.utc)

    business = {
        "id": business_id,
        "owner_user_id": user_id,
        "name": payload.business_name,
        "legal_name": None,
        "email": payload.email.lower(),
        "phone": None,
        "website": None,
        "logo_url": None,
        "address_line1": None,
        "city": None,
        "region": None,
        "postal_code": None,
        "country": "US",
        "currency": "USD",
        "tax_numbers": [],
        "invoice_prefix": "INV",
        "next_invoice_no": 1,
        "default_terms": "Payment due within 14 days.",
        "default_due_days": 14,
        "plan": "FREE",
        "anthropic_api_key": None,
        "stripe_payment_url_default": None,
        "onboarded": False,
        "created_at": now.isoformat(),
    }
    user = {
        "id": user_id,
        "email": payload.email.lower(),
        "password_hash": pwd_ctx.hash(payload.password),
        "business_id": business_id,
        "name": None,
        "role": "OWNER",
        "created_at": now.isoformat(),
    }
    await db.businesses.insert_one(business)
    await db.users.insert_one(user)
    return TokenOut(access_token=make_token(user_id, business_id))
```

with:

```python
async def _create_business_and_user(
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
    now = datetime.now(timezone.utc)

    business = {
        "id": business_id,
        "owner_user_id": user_id,
        "name": business_name,
        "legal_name": None,
        "email": email,
        "phone": None,
        "website": None,
        "logo_url": None,
        "address_line1": None,
        "city": None,
        "region": None,
        "postal_code": None,
        "country": "US",
        "currency": "USD",
        "tax_numbers": [],
        "invoice_prefix": "INV",
        "next_invoice_no": 1,
        "default_terms": "Payment due within 14 days.",
        "default_due_days": 14,
        "plan": "FREE",
        "anthropic_api_key": None,
        "stripe_payment_url_default": None,
        "onboarded": False,
        "created_at": now.isoformat(),
    }
    user = {
        "id": user_id,
        "email": email,
        "password_hash": password_hash,
        "business_id": business_id,
        "name": None,
        "role": "OWNER",
        "clerk_user_id": clerk_user_id,
        "created_at": now.isoformat(),
    }
    await db.businesses.insert_one(business)
    await db.users.insert_one(user)
    return user_id, business_id


@api.post("/auth/register", response_model=TokenOut)
async def register(payload: RegisterIn):
    existing = await db.users.find_one({"email": payload.email.lower()})
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")
    user_id, business_id = await _create_business_and_user(
        email=payload.email.lower(),
        business_name=payload.business_name,
        password_hash=pwd_ctx.hash(payload.password),
    )
    return TokenOut(access_token=make_token(user_id, business_id))
```

- [ ] **Step 2: Run the existing auth tests to confirm no behavior change**

Run:
```bash
cd backend
.venv\Scripts\python.exe -m pytest tests/test_backend.py::TestAuth -v
```
Expected: all PASS, identical to before the refactor (this is a pure extraction — `test_register_duplicate_returns_400` and the login/me tests must still pass unchanged).

- [ ] **Step 3: Commit**

```bash
git add backend/server.py
git commit -m "Extract shared business+user creation helper from register()"
```

---

## Task 3: Guard login against Google-only accounts

Once Task 4 lands, some users will have `password_hash: None`. `login()` currently calls `pwd_ctx.verify(payload.password, user["password_hash"])` unconditionally, which raises a `TypeError` (not a clean 400) if `password_hash` is `None`.

There's no public API to create a password-less user (only the Clerk exchange in Task 4 does that in production) — but `_create_business_and_user` from Task 2 already accepts `password_hash=None` directly, so this can be tested properly right now, in-process, without waiting for Task 4. This creates `test_clerk_auth.py`, which Task 4 then extends.

**Files:**
- Modify: `backend/server.py` (the `login()` function, around line 372)
- Create: `backend/tests/test_clerk_auth.py`

**Interfaces:**
- Consumes: `_create_business_and_user` from Task 2 (used directly, in-process, to create a password-less user).

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_clerk_auth.py`:

```python
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
        email = f"clerk_only_{uuid.uuid4().hex[:10]}@example.com"
        run(server._create_business_and_user(
            email=email,
            business_name="Google Only Co",
            password_hash=None,
            clerk_user_id="user_fake123",
        ))

        try:
            run(server.login(server.LoginIn(email=email, password="anything")))
            assert False, "expected HTTPException"
        except server.HTTPException as e:
            assert e.status_code == 400
            assert e.detail == "This account uses Google sign-in. Continue with Google instead."
```

- [ ] **Step 2: Run it to verify it fails**

Run:
```bash
cd backend
.venv\Scripts\python.exe -m pytest tests/test_clerk_auth.py -v
```
Expected: FAIL — `login()` currently calls `pwd_ctx.verify(payload.password, None)`, raising a `TypeError` instead of the expected `HTTPException`.

- [ ] **Step 3: Add the guard in `login()`**

In `backend/server.py`, replace:

```python
@api.post("/auth/login", response_model=TokenOut)
async def login(payload: LoginIn):
    user = await db.users.find_one({"email": payload.email.lower()})
    if not user or not pwd_ctx.verify(payload.password, user["password_hash"]):
        raise HTTPException(status_code=400, detail="Invalid email or password")
    return TokenOut(access_token=make_token(user["id"], user["business_id"]))
```

with:

```python
@api.post("/auth/login", response_model=TokenOut)
async def login(payload: LoginIn):
    user = await db.users.find_one({"email": payload.email.lower()})
    if not user:
        raise HTTPException(status_code=400, detail="Invalid email or password")
    if not user.get("password_hash"):
        raise HTTPException(
            status_code=400,
            detail="This account uses Google sign-in. Continue with Google instead.",
        )
    if not pwd_ctx.verify(payload.password, user["password_hash"]):
        raise HTTPException(status_code=400, detail="Invalid email or password")
    return TokenOut(access_token=make_token(user["id"], user["business_id"]))
```

- [ ] **Step 4: Run it to verify it passes, plus the existing auth suite for regressions**

Run:
```bash
cd backend
.venv\Scripts\python.exe -m pytest tests/test_clerk_auth.py tests/test_backend.py::TestAuth -v
```
Expected: all PASS, including the new test and the pre-existing `test_login_wrong_password_400`.

- [ ] **Step 5: Commit**

```bash
git add backend/server.py backend/tests/test_clerk_auth.py
git commit -m "Guard login against crashing on Google-only accounts"
```

---

## Task 4: Clerk token verification and the exchange endpoint

This is the core of the feature: verify a Clerk session token, resolve it to a `(user_id, business_id)` pair per the account-linking rules, and expose it as `POST /auth/clerk-exchange`.

The verification logic is extracted into a standalone `resolve_clerk_user()` function so it can be unit-tested with mocked Clerk calls — `test_backend.py`'s existing tests drive a *live* running server over HTTP (see `conftest.py`), which makes mocking impossible (mocks only work in the same process). `resolve_clerk_user()` is instead tested by importing `server.py` directly and patching its Clerk calls in-process.

**Files:**
- Modify: `backend/server.py` (add `ClerkExchangeIn` model, `resolve_clerk_user()`, and the new route)
- Modify: `backend/tests/test_clerk_auth.py` (created in Task 3 — extend it, don't replace it)
- Modify: `backend/tests/test_backend.py` (one black-box invalid-token test)

**Interfaces:**
- Consumes: `_create_business_and_user` (Task 2), `CLERK_SECRET_KEY`/`clerk_client` (Task 1), `run()` helper (already defined in `test_clerk_auth.py` from Task 3).
- Produces: `async def resolve_clerk_user(clerk_token: str) -> tuple[str, str, bool]` — returns `(user_id, business_id, is_new_business)`, raises `HTTPException` on any failure. `POST /api/auth/clerk-exchange` — request `{"clerk_token": str}`, response matches `TokenOut` (`{"access_token": str, "token_type": "bearer"}`).

- [ ] **Step 1: Write the failing unit tests (mocked Clerk calls)**

In `backend/tests/test_clerk_auth.py` (from Task 3), add these imports to the top of the file, alongside the existing ones:

```python
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from clerk_backend_api.security import TokenVerificationError, TokenVerificationErrorReason
```

Then add this helper and test class to the end of the file (after `TestLoginGuard`):

```python
def fake_clerk_user(email: str, first_name: str = "Ada"):
    """Build a stand-in for clerk_backend_api.models.User with just the
    fields resolve_clerk_user() reads."""
    return SimpleNamespace(
        first_name=first_name,
        primary_email_address_id="idn_primary",
        email_addresses=[SimpleNamespace(id="idn_primary", email_address=email)],
    )


class TestResolveClerkUser:
    def test_new_email_creates_business(self):
        email = f"clerk_{uuid.uuid4().hex[:10]}@example.com"
        with patch.object(server, "verify_token_async", AsyncMock(return_value={"sub": "user_abc123"})), \
             patch.object(server.clerk_client.users, "get_async", AsyncMock(return_value=fake_clerk_user(email))):
            user_id, business_id, is_new = run(server.resolve_clerk_user("fake-token"))

        assert is_new is True
        biz = run(server.db.businesses.find_one({"id": business_id}))
        assert biz["name"] == "Ada"
        assert biz["onboarded"] is False
        user = run(server.db.users.find_one({"id": user_id}))
        assert user["email"] == email
        assert user["password_hash"] is None
        assert user["clerk_user_id"] == "user_abc123"

    def test_matching_email_logs_into_existing_business(self):
        email = f"clerk_link_{uuid.uuid4().hex[:10]}@example.com"
        existing_user_id, existing_business_id = run(
            server._create_business_and_user(
                email=email, business_name="Existing Co", password_hash="irrelevant-hash"
            )
        )

        with patch.object(server, "verify_token_async", AsyncMock(return_value={"sub": "user_xyz789"})), \
             patch.object(server.clerk_client.users, "get_async", AsyncMock(return_value=fake_clerk_user(email))):
            user_id, business_id, is_new = run(server.resolve_clerk_user("fake-token"))

        assert is_new is False
        assert user_id == existing_user_id
        assert business_id == existing_business_id
        # clerk_user_id should be backfilled onto the pre-existing user doc
        user = run(server.db.users.find_one({"id": existing_user_id}))
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
```

- [ ] **Step 2: Run it to verify it fails (resolve_clerk_user doesn't exist yet)**

Run:
```bash
cd backend
.venv\Scripts\python.exe -m pytest tests/test_clerk_auth.py -v
```
Expected: FAIL with `AttributeError: module 'server' has no attribute 'resolve_clerk_user'`.

- [ ] **Step 3: Implement `resolve_clerk_user()` and the route**

In `backend/server.py`, add this near the other auth routes (after `_create_business_and_user`, before `register()`):

```python
class ClerkExchangeIn(BaseModel):
    clerk_token: str


async def resolve_clerk_user(clerk_token: str) -> tuple[str, str, bool]:
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

    email = next(
        (
            e.email_address
            for e in clerk_user.email_addresses
            if e.id == clerk_user.primary_email_address_id
        ),
        None,
    )
    if not email:
        raise HTTPException(
            status_code=400, detail="No verified email found on this Google account."
        )
    email = email.lower()

    existing = await db.users.find_one({"email": email})
    if existing:
        if not existing.get("clerk_user_id"):
            await db.users.update_one(
                {"id": existing["id"]}, {"$set": {"clerk_user_id": clerk_user_id}}
            )
        return existing["id"], existing["business_id"], False

    display_name = clerk_user.first_name or "My Business"
    user_id, business_id = await _create_business_and_user(
        email=email,
        business_name=display_name,
        password_hash=None,
        clerk_user_id=clerk_user_id,
    )
    return user_id, business_id, True


@api.post("/auth/clerk-exchange", response_model=TokenOut)
async def clerk_exchange(payload: ClerkExchangeIn):
    user_id, business_id, _is_new = await resolve_clerk_user(payload.clerk_token)
    return TokenOut(access_token=make_token(user_id, business_id))
```

- [ ] **Step 4: Run the unit tests to verify they pass**

Run:
```bash
cd backend
.venv\Scripts\python.exe -m pytest tests/test_clerk_auth.py -v
```
Expected: all 4 tests PASS.

- [ ] **Step 5: Add one black-box test through the live HTTP route**

In `backend/tests/test_backend.py`, inside `class TestAuth`, add:

```python
    def test_clerk_exchange_with_invalid_token_returns_401(self, api_client):
        r = api_client.post(f"{API}/auth/clerk-exchange", json={"clerk_token": "not-a-real-token"})
        assert r.status_code == 401
```

- [ ] **Step 6: Restart the backend and run the full suite**

Run:
```bash
cd backend
.venv\Scripts\python.exe -m uvicorn server:app --port 8000 &
sleep 3
.venv\Scripts\python.exe -m pytest tests/ -v
```
Expected: all tests PASS, including `test_clerk_exchange_with_invalid_token_returns_401` and everything in `test_clerk_auth.py`.

- [ ] **Step 7: Commit**

```bash
git add backend/server.py backend/tests/test_clerk_auth.py backend/tests/test_backend.py
git commit -m "Add Clerk token verification and /auth/clerk-exchange endpoint"
```

---

## Task 5: Frontend dependency and web-only ClerkProvider

Wrap the web build in `<ClerkProvider>` without touching the native build at all. This uses the same `.web.tsx`/`.tsx` platform-split convention already established in this codebase (`DateField.tsx` / `DateField.web.tsx`), so Metro never bundles any Clerk code into the native build.

**Files:**
- Modify: `frontend/package.json` (new dependency)
- Create: `frontend/src/providers/RootProviders.tsx`
- Modify: `frontend/app/_layout.tsx` (extract shared wrapper, no behavior change)
- Create: `frontend/app/_layout.web.tsx`

**Interfaces:**
- Produces: `RootProviders` component (`{ children: ReactNode }` → wraps in `GestureHandlerRootView` + `SafeAreaProvider` + `AuthProvider`) — used by both layout files.

- [ ] **Step 1: Install the Clerk Expo SDK**

Run:
```bash
cd frontend
npx expo install @clerk/expo
```
(`expo-secure-store` is already a dependency — no need to install it again.)

- [ ] **Step 2: Extract the shared provider wrapper**

Create `frontend/src/providers/RootProviders.tsx`:

```tsx
import { PropsWithChildren } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { AuthProvider } from "@/src/context/AuthContext";

export function RootProviders({ children }: PropsWithChildren) {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AuthProvider>{children}</AuthProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
```

- [ ] **Step 3: Update the native layout to use it (no behavior change)**

Replace the full contents of `frontend/app/_layout.tsx`:

```tsx
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { LogBox } from "react-native";

import { useIconFonts } from "@/src/hooks/use-icon-fonts";
import { RootProviders } from "@/src/providers/RootProviders";

LogBox.ignoreAllLogs(true);

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [loaded, error] = useIconFonts();

  useEffect(() => {
    if (loaded || error) {
      SplashScreen.hideAsync();
    }
  }, [loaded, error]);

  if (!loaded && !error) return null;

  return (
    <RootProviders>
      <Stack screenOptions={{ headerShown: false, animation: "fade" }} />
    </RootProviders>
  );
}
```

(Note: `injectWebShell()` and its import move to the new web-only layout in the next step — it already no-ops on native via its own `Platform.OS !== "web"` guard, so removing it here is a no-op change, not a behavior change.)

- [ ] **Step 4: Create the web-only layout with ClerkProvider**

Create `frontend/app/_layout.web.tsx`:

```tsx
import { ClerkProvider } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { LogBox } from "react-native";

import { useIconFonts } from "@/src/hooks/use-icon-fonts";
import { injectWebShell } from "@/src/lib/webShell";
import { RootProviders } from "@/src/providers/RootProviders";

const CLERK_PUBLISHABLE_KEY = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;

if (!CLERK_PUBLISHABLE_KEY) {
  throw new Error("Add EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY to frontend/.env");
}

LogBox.ignoreAllLogs(true);

injectWebShell();

SplashScreen.preventAutoHideAsync();

export default function RootLayoutWeb() {
  const [loaded, error] = useIconFonts();

  useEffect(() => {
    if (loaded || error) {
      SplashScreen.hideAsync();
    }
  }, [loaded, error]);

  if (!loaded && !error) return null;

  return (
    <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY} tokenCache={tokenCache}>
      <RootProviders>
        <Stack screenOptions={{ headerShown: false, animation: "fade" }} />
      </RootProviders>
    </ClerkProvider>
  );
}
```

- [ ] **Step 5: Typecheck**

Run:
```bash
cd frontend
npx tsc --noEmit
```
Expected: no new errors (the one pre-existing error in `app/invoices/new.tsx` about `LineItemDto`/`LineItem` is unrelated and already tracked separately).

- [ ] **Step 6: Manually verify the web app still boots**

Start the dev server (`npx expo start`), open the web preview, and confirm the dashboard/sign-in flow still loads with no console errors. **If `tokenCache` throws an error on web** (its `expo-secure-store` backing has inconsistent web support — this project's own `src/utils/storage/index.web.ts` avoids it for exactly that reason), remove the `tokenCache` prop from `_layout.web.tsx`'s `<ClerkProvider>` — Clerk's session will then live in memory for that browser tab only (acceptable for a web-only launch; re-login is needed after a hard refresh).

- [ ] **Step 7: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/src/providers/RootProviders.tsx frontend/app/_layout.tsx frontend/app/_layout.web.tsx
git commit -m "Add web-only ClerkProvider via platform-split root layout"
```

---

## Task 6: AuthContext exchange method

Add one method to `AuthContext` that mirrors `signIn`/`signUp` exactly, so the rest of the app (route guard, session storage) needs zero changes.

**Files:**
- Modify: `frontend/src/context/AuthContext.tsx`

**Interfaces:**
- Consumes: `api.post` (existing, from `@/src/lib/api`), `saveToken` (existing).
- Produces: `signInWithClerk(clerkToken: string): Promise<void>` — added to `AuthCtx` type and provider value, called by Task 7's `GoogleSignInButton`.

- [ ] **Step 1: Add the method**

In `frontend/src/context/AuthContext.tsx`, add `signInWithClerk` to the `AuthCtx` type:

```typescript
type AuthCtx = {
  user: Me | null;
  business: Business | null;
  loading: boolean;
  bootstrapping: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, businessName: string) => Promise<void>;
  signInWithClerk: (clerkToken: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshBusiness: () => Promise<void>;
};
```

Add the implementation right after the existing `signUp` function:

```typescript
  const signInWithClerk = async (clerkToken: string) => {
    setLoading(true);
    try {
      const res = await api.post<{ access_token: string }>("/auth/clerk-exchange", {
        clerk_token: clerkToken,
      });
      await saveToken(res.access_token);
      await loadSession();
    } finally {
      setLoading(false);
    }
  };
```

Add it to the provider's value:

```tsx
  return (
    <AuthContext.Provider
      value={{ user, business, loading, bootstrapping, signIn, signUp, signInWithClerk, signOut, refreshBusiness }}
    >
      {children}
    </AuthContext.Provider>
  );
```

- [ ] **Step 2: Typecheck**

Run:
```bash
cd frontend
npx tsc --noEmit
```
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/context/AuthContext.tsx
git commit -m "Add signInWithClerk to AuthContext"
```

---

## Task 7: Google sign-in button (web) and screen wiring

Add the button as its own platform-split component (`.web.tsx` real implementation, `.tsx` no-op for native), then drop it into the existing Sign In and Sign Up screens with a two-line change each — no forking of the screen files themselves, no risk to native.

**Files:**
- Create: `frontend/src/components/GoogleSignInButton.web.tsx`
- Create: `frontend/src/components/GoogleSignInButton.tsx`
- Modify: `frontend/app/(auth)/sign-in.tsx`
- Modify: `frontend/app/(auth)/sign-up.tsx`

**Interfaces:**
- Consumes: `useSSO`, `useAuth` from `@clerk/expo` (web only); `useAuth` (aliased) from `@/src/context/AuthContext`.
- Produces: `GoogleSignInButton` component, props `{ onError: (message: string) => void }` — identical signature on both platform variants.

- [ ] **Step 1: Create the native no-op**

Create `frontend/src/components/GoogleSignInButton.tsx`:

```tsx
// Native (iOS/Android): Google sign-in ships web-only for now — Clerk's
// React Native SDK needs a compiled dev build, which isn't set up yet.
// Metro resolves GoogleSignInButton.web.tsx instead of this file on web.
export function GoogleSignInButton(_props: { onError: (message: string) => void }) {
  return null;
}
```

- [ ] **Step 2: Create the web implementation**

Create `frontend/src/components/GoogleSignInButton.web.tsx`:

```tsx
import { useAuth as useClerkAuth, useSSO } from "@clerk/expo";
import React, { useState } from "react";
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity } from "react-native";

import { useAuth as useAppAuth } from "@/src/context/AuthContext";
import { colors, radius, spacing, typography } from "@/src/lib/theme";

type Props = {
  onError: (message: string) => void;
};

export function GoogleSignInButton({ onError }: Props) {
  const { startSSOFlow } = useSSO();
  const { getToken } = useClerkAuth();
  const { signInWithClerk } = useAppAuth();
  const [busy, setBusy] = useState(false);

  const onPress = async () => {
    setBusy(true);
    try {
      const { createdSessionId, setActive } = await startSSOFlow({ strategy: "oauth_google" });
      if (!createdSessionId || !setActive) {
        // User closed the popup, or Clerk needs another step (e.g. MFA) —
        // not an error, just stop here.
        return;
      }
      await setActive({ session: createdSessionId });
      const token = await getToken();
      if (!token) throw new Error("Could not retrieve Google sign-in session.");
      await signInWithClerk(token);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Google sign-in failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <TouchableOpacity
      testID="continue-with-google"
      style={styles.btn}
      onPress={onPress}
      disabled={busy}
      activeOpacity={0.85}
    >
      {busy ? (
        <ActivityIndicator color={colors.onSurface} />
      ) : (
        <Text style={styles.text}>Continue with Google</Text>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  btn: {
    minHeight: 48,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceSecondary,
    alignItems: "center",
    justifyContent: "center",
    marginTop: spacing.md,
  },
  text: { fontSize: typography.lg, fontWeight: "500", color: colors.onSurface },
});
```

- [ ] **Step 3: Wire it into the Sign In screen**

In `frontend/app/(auth)/sign-in.tsx`, add the import (after the existing `Button` import):

```typescript
import { GoogleSignInButton } from "@/src/components/GoogleSignInButton";
```

Add the button right after the existing `Button` in the JSX:

```tsx
            {err ? <Text style={styles.err}>{err}</Text> : null}
            <Button testID="sign-in-submit" title="Sign In" loading={loading} onPress={onSubmit} />
            <GoogleSignInButton onError={setErr} />

            <Link href="/(auth)/sign-up" asChild>
```

- [ ] **Step 4: Wire it into the Sign Up screen**

In `frontend/app/(auth)/sign-up.tsx`, add the same import, and add the button after its `Button`:

```tsx
            {err ? <Text style={styles.err}>{err}</Text> : null}
            <Button testID="sign-up-submit" title="Create Account" loading={loading} onPress={onSubmit} />
            <GoogleSignInButton onError={setErr} />

            <Link href="/(auth)/sign-in" asChild>
```

- [ ] **Step 5: Typecheck**

Run:
```bash
cd frontend
npx tsc --noEmit
```
Expected: no new errors.

- [ ] **Step 6: Manually verify in the browser**

Start the dev server (`npx expo start`), open the web preview at `/sign-in`:
- Confirm the "Continue with Google" button renders below "Sign In".
- Click it — a Google OAuth popup should open.
- Complete Google sign-in with an email that has **no** existing InvoiceAI account — confirm you land on the onboarding screen ("Tell us about your business"), with the business name prefilled from your Google display name.
- Sign out, then sign in again with Google using the **same** email — confirm you land directly on the dashboard (not onboarding again).
- Repeat the check on `/sign-up` — the button should behave identically there.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/GoogleSignInButton.tsx frontend/src/components/GoogleSignInButton.web.tsx "frontend/app/(auth)/sign-in.tsx" "frontend/app/(auth)/sign-up.tsx"
git commit -m "Add Google sign-in button (web) to Sign In and Sign Up screens"
```

---

## Deployment note (out of scope for this plan)

When the Netlify deploy happens, `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` must be added to Netlify's build environment variables (Expo bakes `EXPO_PUBLIC_*` values in at build time — a value only in the local `.env` won't reach the deployed build). This plan does not cover the deployment itself.
