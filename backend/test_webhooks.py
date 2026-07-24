"""Live verification test for Stripe webhook route against Postgres."""
import asyncio
import hashlib
import hmac
import json
import os
import time
import uuid
from datetime import datetime

import httpx
from fastapi import FastAPI
from sqlalchemy import select
from starlette.testclient import TestClient
from starlette.types import ASGIApp
from httpx import ASGITransport

# CRITICAL: Set STRIPE_WEBHOOK_SECRET BEFORE importing app.routers.webhooks
# This must happen at import time since the module reads it via os.environ.get(...)
TEST_WEBHOOK_SECRET = "whsec_test_fake_secret_for_verification_only"
os.environ["STRIPE_WEBHOOK_SECRET"] = TEST_WEBHOOK_SECRET

# Now safe to import the router
from app.routers.webhooks import router
from app.db import get_db, engine
from app.models import Business, WebhookEvent


def construct_stripe_signature(payload: str, secret: str) -> str:
    """Construct a valid Stripe webhook signature header.

    Matches Stripe's scheme: signed_payload = "{timestamp}.{payload_body}",
    then v1={hmac_sha256_hex_of_signed_payload}
    """
    timestamp = str(int(time.time()))
    signed_payload = f"{timestamp}.{payload}"
    signature = hmac.new(secret.encode(), signed_payload.encode(), hashlib.sha256).hexdigest()
    return f"t={timestamp},v1={signature}"


async def test_webhooks():
    """Run comprehensive webhook tests."""
    print("=" * 80)
    print("LIVE WEBHOOK VERIFICATION TEST")
    print("=" * 80)

    # Create minimal FastAPI app with just the webhooks router
    app = FastAPI()
    app.include_router(router)

    # Use httpx AsyncClient with ASGITransport for true async support
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        # Get async DB session for setup/cleanup
        db_gen = get_db()
        db = await db_gen.__anext__()

        try:
            # Register a test business with known ID and stripe_customer_id
            test_biz_id = str(uuid.uuid4())  # Proper UUID string
            test_owner_id = str(uuid.uuid4())  # Required owner_user_id
            test_customer_id = f"cus_test_{uuid.uuid4().hex[:8]}"
            test_subscription_id = f"sub_test_{uuid.uuid4().hex[:8]}"

            test_business = Business(
                id=test_biz_id,
                owner_user_id=test_owner_id,
                email="test@example.com",
                name="Test Business",
                plan="FREE",
                stripe_customer_id=None,
                stripe_subscription_id=None,
            )
            db.add(test_business)
            await db.commit()
            print(f"\n[SETUP] Created test business: {test_biz_id}")

            # Test 1: POST with NO stripe-signature header
            print("\n[TEST 1] POST with NO stripe-signature header")
            payload = json.dumps({"id": "evt_test1", "type": "checkout.session.completed"})
            resp = await client.post("/webhooks/stripe", content=payload)
            print(f"  Status: {resp.status_code}")
            print(f"  Response: {resp.json()}")
            assert resp.status_code == 400, f"Expected 400, got {resp.status_code}"
            assert "Missing stripe-signature header" in resp.json()["detail"]
            print("  [PASS]")

            # Test 2: POST with invalid/garbage signature
            print("\n[TEST 2] POST with invalid/garbage signature")
            payload = json.dumps({"id": "evt_test2", "type": "checkout.session.completed"})
            resp = await client.post(
                "/webhooks/stripe",
                content=payload,
                headers={"stripe-signature": "invalid_signature_here"}
            )
            print(f"  Status: {resp.status_code}")
            print(f"  Response: {resp.json()}")
            assert resp.status_code == 400, f"Expected 400, got {resp.status_code}"
            assert "Invalid signature" in resp.json()["detail"]
            print("  [PASS]")

            # Test 3: Valid checkout.session.completed event
            print("\n[TEST 3] Valid checkout.session.completed event")
            evt_id_3 = f"evt_checkout_{uuid.uuid4().hex[:8]}"
            payload_obj = {
                "id": evt_id_3,
                "type": "checkout.session.completed",
                "data": {
                    "object": {
                        "client_reference_id": f"STARTER.{test_biz_id}",
                        "customer": test_customer_id,
                        "subscription": test_subscription_id,
                    }
                }
            }
            payload = json.dumps(payload_obj)
            sig_header = construct_stripe_signature(payload, TEST_WEBHOOK_SECRET)
            resp = await client.post(
                "/webhooks/stripe",
                content=payload,
                headers={"stripe-signature": sig_header}
            )
            print(f"  Status: {resp.status_code}")
            print(f"  Response: {resp.json()}")
            assert resp.status_code == 200, f"Expected 200, got {resp.status_code}"

            # Query DB to verify business was updated
            await db.refresh(test_business)
            print(f"  Business plan: {test_business.plan}")
            print(f"  Business stripe_customer_id: {test_business.stripe_customer_id}")
            print(f"  Business stripe_subscription_id: {test_business.stripe_subscription_id}")
            assert test_business.plan == "STARTER", f"Expected plan STARTER, got {test_business.plan}"
            assert test_business.stripe_customer_id == test_customer_id
            assert test_business.stripe_subscription_id == test_subscription_id
            print("  [PASS]")

            # Test 4: POST same event again (idempotency)
            print("\n[TEST 4] POST same checkout event again (idempotency)")
            resp = await client.post(
                "/webhooks/stripe",
                content=payload,
                headers={"stripe-signature": sig_header}
            )
            print(f"  Status: {resp.status_code}")
            print(f"  Response: {resp.json()}")
            assert resp.status_code == 200
            assert resp.json()["message"] == "duplicate"

            # Verify business plan/fields were NOT changed again
            await db.refresh(test_business)
            print(f"  Business plan (unchanged): {test_business.plan}")
            assert test_business.plan == "STARTER"
            assert test_business.stripe_customer_id == test_customer_id
            print("  [PASS] (true idempotency confirmed)")

            # Test 5: customer.subscription.deleted event
            print("\n[TEST 5] customer.subscription.deleted event")
            evt_id_5 = f"evt_sub_deleted_{uuid.uuid4().hex[:8]}"
            payload_obj = {
                "id": evt_id_5,
                "type": "customer.subscription.deleted",
                "data": {
                    "object": {
                        "customer": test_customer_id,
                    }
                }
            }
            payload = json.dumps(payload_obj)
            sig_header = construct_stripe_signature(payload, TEST_WEBHOOK_SECRET)
            resp = await client.post(
                "/webhooks/stripe",
                content=payload,
                headers={"stripe-signature": sig_header}
            )
            print(f"  Status: {resp.status_code}")
            print(f"  Response: {resp.json()}")
            assert resp.status_code == 200

            # Query DB to verify plan reverted to FREE
            await db.refresh(test_business)
            print(f"  Business plan (should be FREE): {test_business.plan}")
            assert test_business.plan == "FREE"
            print("  [PASS]")

            # Test 6: invoice.payment_failed event (no-op)
            print("\n[TEST 6] invoice.payment_failed event (no-op)")
            evt_id_6 = f"evt_payment_failed_{uuid.uuid4().hex[:8]}"
            payload_obj = {
                "id": evt_id_6,
                "type": "invoice.payment_failed",
                "data": {
                    "object": {
                        "customer": test_customer_id,
                    }
                }
            }
            payload = json.dumps(payload_obj)
            sig_header = construct_stripe_signature(payload, TEST_WEBHOOK_SECRET)
            resp = await client.post(
                "/webhooks/stripe",
                content=payload,
                headers={"stripe-signature": sig_header}
            )
            print(f"  Status: {resp.status_code}")
            print(f"  Response: {resp.json()}")
            assert resp.status_code == 200

            # Verify plan unchanged
            await db.refresh(test_business)
            print(f"  Business plan (unchanged, should be FREE): {test_business.plan}")
            assert test_business.plan == "FREE"
            print("  [PASS] (no-op confirmed)")

            # Test 7: Verify WebhookEvent rows exist
            print("\n[TEST 7] Verify WebhookEvent rows exist in DB")
            event_ids = [evt_id_3, evt_id_5, evt_id_6]
            for evt_id in event_ids:
                result = await db.execute(select(WebhookEvent).where(WebhookEvent.id == evt_id))
                webhook_event = result.scalar_one_or_none()
                print(f"  Event {evt_id[:20]}... found: {webhook_event is not None}")
                assert webhook_event is not None, f"WebhookEvent {evt_id} not found in DB"
            print("  [PASS]")

            # Cleanup: Delete test rows
            print("\n[CLEANUP] Deleting test data")
            result = await db.execute(select(WebhookEvent).where(WebhookEvent.id.in_(event_ids)))
            webhook_events = result.scalars().all()
            for we in webhook_events:
                await db.delete(we)

            await db.delete(test_business)
            await db.commit()
            print(f"  [OK] Cleaned up test business {test_biz_id} and webhook events")

            print("\n" + "=" * 80)
            print("ALL TESTS PASSED")
            print("=" * 80)

        finally:
            await db.close()


if __name__ == "__main__":
    asyncio.run(test_webhooks())
