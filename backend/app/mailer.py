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
