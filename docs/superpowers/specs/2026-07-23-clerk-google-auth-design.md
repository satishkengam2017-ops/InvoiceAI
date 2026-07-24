# Google sign-in via Clerk (web) — Design

Date: 2026-07-23
Status: Approved by user, ready for implementation planning

## Purpose

Add "Continue with Google" as an alternative sign-in/sign-up method on the web app,
alongside the existing custom email/password auth. Mobile (iOS/Android via Expo Go)
is out of scope for this iteration — Clerk's React Native SDK requires a compiled
native build, which isn't set up yet.

## Scope decisions

- **Platforms**: web only. Native gets email/password only until EAS development
  builds are set up as a separate piece of work.
- **Account linking**: if a Google sign-in's verified email matches an existing
  email/password account, log into that existing business (auto-link by email —
  Google verifies email ownership, so this is safe, and matches common practice).
- **New users**: a Google sign-in with no matching email creates a new business +
  user record, identical in shape to `/auth/register`, and sends them through the
  existing onboarding screen (`onboarded: false`) exactly like email signup does.
- **Backend verification**: Clerk's official Python SDK (not hand-rolled JWKS
  verification) — more battle-tested against revocation/clock-skew edge cases,
  at the cost of one new dependency and a `CLERK_SECRET_KEY` env var.

## Architecture & data flow

```
User clicks "Continue with Google" (web only)
        │
        ▼
Clerk's hosted Google OAuth popup
        │  (Clerk issues its own session token)
        ▼
Frontend: POST /api/auth/clerk-exchange { clerk_token }
        │
        ▼
Backend: Clerk SDK verifies the token → verified email + clerk_user_id
        │
        ├─ email matches existing user  → log into their existing business
        ├─ no match                     → create new business + user
        │                                  (same shape as /auth/register),
        │                                  onboarded=false
        ▼
Backend issues the SAME app JWT as today (existing make_token()) → { access_token }
        │
        ▼
Frontend: saveToken() + loadSession() — identical to the existing
          email/password flow from this point on
```

Clerk is isolated entirely to the exchange step. Once the backend mints the
existing app JWT, `get_current_user`, every protected route (~15 endpoints), and
`AuthContext`'s session storage / route-guard logic are **unchanged**.

## Components

### Backend (`backend/server.py`)

- New dependency: Clerk's official Python SDK (`clerk-backend-api`).
- New env var: `CLERK_SECRET_KEY` (already set in `backend/.env` by the user).
- New Pydantic model: `ClerkExchangeIn { clerk_token: str }`.
- New route: `POST /api/auth/clerk-exchange`.
  - Verifies `clerk_token` via the Clerk SDK → extracts verified email + `clerk_user_id`.
  - Looks up `db.users.find_one({"email": email.lower()})`.
    - **Found**: use the existing `user_id`/`business_id`. If the user doc has no
      `clerk_user_id` yet, backfill it (so future Google sign-ins for this user
      skip straight to a direct lookup).
    - **Not found**: create a new business + user via a shared helper (see
      refactor below), with `password_hash: None`, `clerk_user_id: <id>` set,
      business `name` defaulted from the Google account's display name (or "My
      Business" if unavailable), `onboarded: False`.
  - Returns `TokenOut` — identical response shape to `/auth/login` and
    `/auth/register`.
- **Refactor**: extract the "create business + user" block currently inside
  `register()` into a shared helper (e.g. `_create_business_and_user(email,
  business_name, password_hash)`), used by both `/auth/register` and the new
  Clerk path, so the two flows can't drift out of sync.
- **Guard**: `/auth/login` currently calls `pwd_ctx.verify(payload.password,
  user["password_hash"])` unconditionally — this crashes (`TypeError`) for a
  Google-only account where `password_hash` is `None`. Add a check: if
  `password_hash` is `None`, return 400 "This account uses Google sign-in.
  Continue with Google instead." instead of attempting verification.
- New optional field on `users` documents: `clerk_user_id: Optional[str]`.
  MongoDB is schemaless — no migration needed; existing documents simply lack
  the field until a Google sign-in touches them.

### Frontend (web only)

- New dependency: `@clerk/clerk-expo`.
- New env var: `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` (already set in
  `frontend/.env` by the user; must also be added to Netlify's build environment
  variables, since Expo bakes `EXPO_PUBLIC_*` values in at build time).
- `<ClerkProvider>` wraps the app in `app/_layout.tsx`, gated to
  `Platform.OS === "web"` so it cannot affect the working native/Expo Go setup.
- "Continue with Google" button added to the Sign In and Sign Up screens
  (rendered web-only).
- `AuthContext` gains one new method, `signInWithClerk(clerkToken: string)`,
  which POSTs to `/auth/clerk-exchange` and then calls the exact same
  `saveToken()` + `loadSession()` the password flow already uses — no changes
  to session storage, route guarding, or `/auth/me` handling.

## Error handling

- Invalid/expired Clerk token → backend returns 401 "Invalid Google sign-in
  session. Please try again."
- Password login attempted on a Google-only account (no `password_hash`) → 400
  "This account uses Google sign-in. Continue with Google instead."
- User closes the Google popup before completing sign-in → no error state,
  simply returns to the sign-in screen (standard OAuth cancel).
- Clerk exchange succeeds but the business/user write fails (Mongo error) →
  generic 500, same as any other unexpected backend error today.

## Testing

- Extend `backend/tests/test_backend.py` (or a new test file) with:
  - New email via Clerk exchange → creates a business, returns a valid token,
    `onboarded == False`.
  - Matching existing email → logs into the existing `business_id` (not a new
    one).
  - Invalid/expired Clerk token → 401.
  - Password login attempted on a Google-only account → 400 with the expected
    message (not a crash).
- Clerk's real API is never called in automated tests — the verification call
  is isolated behind one function so it can be mocked to return a fake verified
  email/`clerk_user_id`.
- Frontend: manual verification in the browser (the OAuth popup flow isn't
  practical to fully automate) — confirm the button renders, triggers Clerk's
  popup, and a successful Google sign-in lands on the dashboard (existing user)
  or onboarding screen (new user).

## Out of scope (for this iteration)

- Native (iOS/Android) Google sign-in — requires EAS development builds, a
  separate task.
- Account *unlinking* or letting a user disconnect Google from their account.
- Any Clerk features beyond Google OAuth (Clerk also offers other providers,
  MFA, etc. — not requested).
