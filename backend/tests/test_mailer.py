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
