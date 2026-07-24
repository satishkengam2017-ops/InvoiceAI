"""Stripe webhook route (public, signature-verified, idempotent)."""
import os
import uuid

import stripe
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select, update as sql_update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.models import Business, WebhookEvent

router = APIRouter(prefix="/webhooks", tags=["webhooks"])

STRIPE_WEBHOOK_SECRET = os.environ.get("STRIPE_WEBHOOK_SECRET", "")
VALID_PLANS = {"FREE", "STARTER", "PRO"}


@router.post("/stripe")
async def stripe_webhook(request: Request, db: AsyncSession = Depends(get_db)):
    """Handle Stripe events for automatic plan activation/deactivation.

    Payment Links redirect back with client_reference_id = "PLAN.BUSINESS_ID".
    We flip business.plan on checkout.session.completed and downgrade to FREE
    on customer.subscription.deleted. All events are deduped via WebhookEvent.
    """
    if not STRIPE_WEBHOOK_SECRET:
        raise HTTPException(status_code=503, detail="Stripe webhook secret not configured. Set STRIPE_WEBHOOK_SECRET.")

    payload = await request.body()
    sig_header = request.headers.get("stripe-signature")
    if not sig_header:
        raise HTTPException(status_code=400, detail="Missing stripe-signature header")

    try:
        event = stripe.Webhook.construct_event(payload, sig_header, STRIPE_WEBHOOK_SECRET)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid payload")
    except stripe.SignatureVerificationError:
        raise HTTPException(status_code=400, detail="Invalid signature")

    event_id = event["id"]
    event_type = event["type"]
    obj = event["data"]["object"]

    existing = (await db.execute(select(WebhookEvent).where(WebhookEvent.id == event_id))).scalar_one_or_none()
    if existing:
        return {"status": "ok", "message": "duplicate"}

    if event_type == "checkout.session.completed":
        client_ref = obj.get("client_reference_id") or ""
        customer_id = obj.get("customer")
        subscription_id = obj.get("subscription")
        if "." in client_ref:
            plan, biz_id = client_ref.split(".", 1)
            plan = plan.upper()
            try:
                uuid.UUID(biz_id)
            except ValueError:
                biz_id = None
            if plan in VALID_PLANS and biz_id:
                values: dict = {"plan": plan}
                if customer_id:
                    values["stripe_customer_id"] = customer_id
                if subscription_id:
                    values["stripe_subscription_id"] = subscription_id
                await db.execute(sql_update(Business).where(Business.id == biz_id).values(**values))

    elif event_type == "customer.subscription.deleted":
        customer_id = obj.get("customer")
        if customer_id:
            await db.execute(
                sql_update(Business).where(Business.stripe_customer_id == customer_id).values(plan="FREE")
            )

    # invoice.payment_failed: non-fatal, no action needed (matches pre-migration behavior)

    db.add(WebhookEvent(id=event_id, type=event_type))
    try:
        await db.commit()
    except IntegrityError:
        # Concurrent delivery of the same event raced past the dedup check
        # above; the mutations we just applied are idempotent SETs, so it's
        # safe to treat the losing commit as a duplicate rather than crash.
        await db.rollback()
        return {"status": "ok", "message": "duplicate"}

    return {"status": "ok"}
