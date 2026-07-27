"""Tests for app.mailer.send_email — mocks httpx since we don't want real
emails sent in automated tests, and no live Resend API key is guaranteed to
be present in a test environment. This is a pure unit test of our own
adapter code around Resend's HTTP API, not an integration test of our own
systems, so mocking here is appropriate.
"""
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.mailer import send_email


@pytest.fixture(autouse=True)
def resend_env(monkeypatch):
    monkeypatch.setenv("RESEND_API_KEY", "re_test_dummy_key")
    monkeypatch.setenv("RESEND_FROM_EMAIL", "test@example.com")


def test_send_email_calls_resend_with_correct_args():
    mock_response = MagicMock()
    mock_response.raise_for_status = MagicMock()

    with patch("httpx.AsyncClient.post", new=AsyncMock(return_value=mock_response)) as mock_post:
        asyncio.run(send_email(to="user@example.com", subject="Test Subject", body="Test body"))

    mock_post.assert_called_once()
    args, kwargs = mock_post.call_args
    assert args[0] == "https://api.resend.com/emails"
    assert kwargs["headers"]["Authorization"] == "Bearer re_test_dummy_key"
    assert kwargs["json"] == {
        "from": "test@example.com",
        "to": ["user@example.com"],
        "subject": "Test Subject",
        "text": "Test body",
    }
    mock_response.raise_for_status.assert_called_once()
