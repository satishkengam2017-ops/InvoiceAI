"""Tests for POST /api/webhooks/stripe — signature verification, idempotency, plan flips.

These tests require STRIPE_WEBHOOK_SECRET to be set on the backend. The test
harness signs payloads with the same secret using HMAC-SHA256 mirroring
Stripe's real Signature header format `t=<ts>,v1=<hex>`.
"""
import hashlib
import hmac
import json
import os
import time
import uuid

import pytest
import requests

from conftest import API, BASE_URL


# The test harness MUST use the same secret the backend was booted with.
# Main test runner sets this env var before invoking pytest.
WEBHOOK_SECRET = os.environ.get("TEST_STRIPE_WEBHOOK_SECRET", "")


def _sig(payload: bytes, secret: str, ts: int | None = None) -> str:
    ts = ts or int(time.time())
    signed = f"{ts}.{payload.decode()}".encode()
    mac = hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()
    return f"t={ts},v1={mac}"


def _event(evt_type: str, obj: dict, evt_id: str | None = None) -> bytes:
    return json.dumps({
        "id": evt_id or f"evt_TEST_{uuid.uuid4().hex[:16]}",
        "type": evt_type,
        "data": {"object": obj},
    }).encode()


def _post(payload: bytes, sig: str | None):
    headers = {"Content-Type": "application/json"}
    if sig is not None:
        headers["Stripe-Signature"] = sig
    return requests.post(f"{API}/webhooks/stripe", data=payload, headers=headers)


@pytest.fixture(scope="module")
def secret_configured():
    if not WEBHOOK_SECRET:
        pytest.skip("TEST_STRIPE_WEBHOOK_SECRET not set on backend; skipping signed tests")
    return WEBHOOK_SECRET


class TestWebhookSignatureGates:
    def test_missing_signature_header_returns_400(self, secret_configured):
        payload = _event("checkout.session.completed", {"client_reference_id": "STARTER.x"})
        r = _post(payload, sig=None)
        assert r.status_code == 400

    def test_invalid_signature_returns_400(self, secret_configured):
        payload = _event("checkout.session.completed", {"client_reference_id": "STARTER.x"})
        bad_sig = _sig(payload, "whsec_WRONG_SECRET_xxxxxxxxxxxxxxxxxxxxx")
        r = _post(payload, sig=bad_sig)
        assert r.status_code == 400


class TestWebhookPlanFlips:
    def _fresh_biz(self):
        email = f"TEST_wh_{uuid.uuid4().hex[:10]}@example.com"
        s = requests.Session()
        r = s.post(f"{API}/auth/register", json={
            "email": email, "password": "Password123!", "business_name": "TEST_WH_BIZ"
        })
        assert r.status_code == 200
        token = r.json()["access_token"]
        s.headers.update({"Content-Type": "application/json", "Authorization": f"Bearer {token}"})
        me = s.get(f"{API}/auth/me").json()
        return s, me["business_id"]

    def _get_plan(self, s):
        r = s.get(f"{API}/business/me")
        assert r.status_code == 200
        return r.json().get("plan")

    def test_checkout_completed_flips_to_starter(self, secret_configured):
        s, biz_id = self._fresh_biz()
        assert self._get_plan(s) == "FREE"
        payload = _event("checkout.session.completed", {
            "client_reference_id": f"STARTER.{biz_id}",
            "customer": "cus_TEST_starter",
            "subscription": "sub_TEST_starter",
        })
        r = _post(payload, _sig(payload, secret_configured))
        assert r.status_code == 200, r.text
        assert self._get_plan(s) == "STARTER"

    def test_checkout_completed_flips_to_pro(self, secret_configured):
        s, biz_id = self._fresh_biz()
        payload = _event("checkout.session.completed", {
            "client_reference_id": f"PRO.{biz_id}",
            "customer": "cus_TEST_pro",
            "subscription": "sub_TEST_pro",
        })
        r = _post(payload, _sig(payload, secret_configured))
        assert r.status_code == 200
        assert self._get_plan(s) == "PRO"

    def test_idempotency_duplicate_event(self, secret_configured):
        s, biz_id = self._fresh_biz()
        evt_id = f"evt_TEST_dup_{uuid.uuid4().hex[:12]}"
        payload = _event(
            "checkout.session.completed",
            {"client_reference_id": f"STARTER.{biz_id}", "customer": "cus_dup", "subscription": "sub_dup"},
            evt_id=evt_id,
        )
        r1 = _post(payload, _sig(payload, secret_configured))
        r2 = _post(payload, _sig(payload, secret_configured))
        assert r1.status_code == 200 and r2.status_code == 200
        assert r2.json().get("message") == "duplicate"
        # Only processed once — plan is STARTER (not double-changed)
        assert self._get_plan(s) == "STARTER"

    def test_malformed_client_reference_id_no_dot(self, secret_configured):
        s, biz_id = self._fresh_biz()
        payload = _event("checkout.session.completed", {"client_reference_id": "GARBAGE"})
        r = _post(payload, _sig(payload, secret_configured))
        assert r.status_code == 200
        # Plan unchanged
        assert self._get_plan(s) == "FREE"

    def test_malformed_client_reference_id_unknown_plan(self, secret_configured):
        s, biz_id = self._fresh_biz()
        payload = _event(
            "checkout.session.completed",
            {"client_reference_id": f"ENTERPRISE.{biz_id}", "customer": "cus_x"},
        )
        r = _post(payload, _sig(payload, secret_configured))
        assert r.status_code == 200
        assert self._get_plan(s) == "FREE"

    def test_subscription_deleted_downgrades_to_free(self, secret_configured):
        s, biz_id = self._fresh_biz()
        cust_id = f"cus_TEST_del_{uuid.uuid4().hex[:8]}"
        # Upgrade first
        p1 = _event("checkout.session.completed", {
            "client_reference_id": f"PRO.{biz_id}",
            "customer": cust_id,
            "subscription": "sub_TEST_del",
        })
        r = _post(p1, _sig(p1, secret_configured))
        assert r.status_code == 200
        assert self._get_plan(s) == "PRO"
        # Now cancel
        p2 = _event("customer.subscription.deleted", {"customer": cust_id, "id": "sub_TEST_del"})
        r = _post(p2, _sig(p2, secret_configured))
        assert r.status_code == 200
        assert self._get_plan(s) == "FREE"

    def test_invoice_payment_failed_no_plan_change(self, secret_configured):
        s, biz_id = self._fresh_biz()
        cust_id = f"cus_TEST_pf_{uuid.uuid4().hex[:8]}"
        p1 = _event("checkout.session.completed", {
            "client_reference_id": f"STARTER.{biz_id}",
            "customer": cust_id,
            "subscription": "sub_TEST_pf",
        })
        _post(p1, _sig(p1, secret_configured))
        assert self._get_plan(s) == "STARTER"
        p2 = _event("invoice.payment_failed", {"customer": cust_id})
        r = _post(p2, _sig(p2, secret_configured))
        assert r.status_code == 200
        assert self._get_plan(s) == "STARTER"


class TestWebhookFailSafeWhenSecretEmpty:
    """Only meaningful when STRIPE_WEBHOOK_SECRET is empty on the backend.

    Because our other tests require the secret to be set, we mark this as
    skipped-by-default and rely on a dedicated pre-test run (see test runner
    log). We include the assertion here for completeness so a future test
    session with the .env restored auto-covers it.
    """
    def test_returns_503_when_secret_empty(self):
        if os.environ.get("EXPECT_WEBHOOK_SECRET_EMPTY") != "1":
            pytest.skip("Only run when backend booted with empty STRIPE_WEBHOOK_SECRET")
        r = requests.post(f"{API}/webhooks/stripe", data=b"{}", headers={
            "Content-Type": "application/json", "Stripe-Signature": "t=1,v1=deadbeef"
        })
        assert r.status_code == 503
