# Forgot Password — Design

## Problem

InvoiceAI has no way for a user to recover access if they forget their password. The sign-in screen has no "Forgot password?" link, and there is no backend support for password reset.

## Context

Auth in this app is hybrid:
- Email/password accounts are handled entirely by our own backend (`bcrypt` hash in `User.password_hash`, our own JWT via `/auth/login` and `/auth/register`).
- Google sign-in goes through Clerk and is exchanged for our own JWT via `/auth/clerk-exchange` (`backend/app/auth.py`). Clerk has no visibility into, or control over, the password-based accounts.

This means password reset must be built entirely in our own backend — Clerk cannot help, since it never manages these passwords.

There is also no existing transactional-email capability. The existing "Send Email" invoice feature does not send email itself; it opens a `mailto:` link in the user's own mail client, or (on web) uploads a PDF and lets the user's browser handle sending. A password reset, by definition, requires the *app* to send an email the user did not compose — a genuinely new capability.

## Email delivery

Sent via SMTP using the user's existing Hostinger mailbox, not a dedicated transactional-email API. New backend env vars:

```
SMTP_HOST=smtp.hostinger.com
SMTP_PORT=465
SMTP_USERNAME=
SMTP_PASSWORD=
SMTP_FROM_EMAIL=
```

Implemented with Python's stdlib `smtplib` (SSL, port 465), invoked via `asyncio.to_thread` to avoid blocking the event loop. No new third-party dependency.

## Flow

1. User taps "Forgot password?" on the sign-in screen → new screen asks for their email → `POST /api/auth/forgot-password { email }`.
2. Backend always responds with a generic message ("If that email is registered, a code has been sent.") regardless of whether the account exists, to avoid leaking which emails are registered. If the account *does* exist, the backend:
   - Invalidates any previous unused/unexpired code for that user.
   - Generates a random 6-digit numeric code.
   - Stores only its bcrypt hash, plus an expiry and a zeroed attempt counter.
   - Emails the plaintext code to the user via SMTP.
3. User enters the code plus a new password (and confirmation) on the next screen → `POST /api/auth/reset-password { email, code, new_password }`.
4. Backend looks up the user's most recent unused code:
   - If none exists, or it's expired, or attempts are exhausted → `400 "Code expired or invalid. Request a new one."`
   - Otherwise, checks the submitted code against the stored hash. On mismatch, increments the attempt counter (max 5 attempts per code) and returns the same 400. On match, marks the code used, updates `User.password_hash`, and returns success.
5. Frontend redirects to sign-in on success, where the user logs in with their new password.

### Google-only accounts

If the account has no `password_hash` yet (Google-only), this flow is also how they set one for the first time. After completing it, they can sign in either with email/password or with "Continue with Google" — this mirrors the existing account-linking behavior in `_create_business_and_user`, where a single `User` row can have both a `password_hash` and a `clerk_user_id`.

## Data model

New table `PasswordResetCode`:

| column | type | notes |
|---|---|---|
| `id` | UUID PK | |
| `user_id` | FK → `users.id` | |
| `code_hash` | string | bcrypt, same `pwd_ctx` as passwords |
| `expires_at` | datetime | 15 minutes from creation |
| `attempts` | int | starts at 0, max 5 |
| `used_at` | datetime, nullable | set on successful reset |
| `created_at` | datetime | |

A dedicated table (rather than columns on `User`) keeps the reset-code lifecycle isolated and matches the existing `WebhookEvent` pattern of a small, single-purpose table.

## API

### `POST /api/auth/forgot-password`
Request: `{ "email": string }`
Response (always, regardless of whether the account exists): `200 { "message": "If that email is registered, a code has been sent." }`

### `POST /api/auth/reset-password`
Request: `{ "email": string, "code": string, "new_password": string }`
Response: `200 { "message": "Password updated." }` or `400` with a user-facing error (see flow above).

## Frontend

Two new screens under `frontend/app/(auth)/`:
- `forgot-password.tsx` — email input, submits to `/forgot-password`, then navigates to the code-entry screen (passing the email along) regardless of the generic response.
- `reset-password.tsx` — code + new password + confirm password inputs, submits to `/reset-password`, then routes to `/(auth)/sign-in` on success.

A "Forgot password?" link is added to `frontend/app/(auth)/sign-in.tsx`, next to the existing "New here? Create an account" link.

## Out of scope

- **Native deep-linking**: not needed. Because the flow is code-entry (not a clickable email link), the same screens work identically on web and native — the user just retypes the code into whichever app instance they requested it from.
- **Resend cooldown / rate-limiting on `/forgot-password` requests**: a fast-follow, not built in this pass. Noted as a known gap (someone could currently trigger repeated reset emails to the same address).

## Testing

Mirrors the existing `test_stripe_webhook.py` style — real HTTP requests against a running backend, real Postgres, no mocks. New `test_forgot_password.py` covering:
- Requesting a code for a real account, then completing reset with it.
- Requesting a code for a nonexistent email still returns the generic 200 (no enumeration).
- Wrong code increments attempts and eventually locks out the code.
- Expired code is rejected.
- Reusing an already-used code is rejected.
- Google-only account (`password_hash` null) can complete the flow and ends up with a usable password.
