"""Email sending via Resend's HTTPS API (e.g. password reset codes).

Not raw SMTP: Railway blocks outbound SMTP (ports 465/587) on Trial/Hobby
plans, only unblocking it on Pro and above - confirmed by testing directly
from this app's own Railway container, where every SMTP port timed out
while port 443 to the same host connected instantly. Resend's API runs
entirely over HTTPS (443), which Railway does not block.
"""
import os

import httpx

RESEND_API_URL = "https://api.resend.com/emails"


async def send_email(to: str, subject: str, body: str) -> None:
    api_key = os.environ["RESEND_API_KEY"]
    from_email = os.environ["RESEND_FROM_EMAIL"]

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            RESEND_API_URL,
            headers={"Authorization": f"Bearer {api_key}"},
            json={"from": from_email, "to": [to], "subject": subject, "text": body},
        )
    resp.raise_for_status()
