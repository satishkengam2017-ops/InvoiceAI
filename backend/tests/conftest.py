"""Shared pytest fixtures for InvoiceAI backend tests."""
import os
import uuid
import requests
import pytest

# Read backend URL from frontend .env (source of truth for public URL)
BASE_URL = os.environ.get(
    "EXPO_PUBLIC_BACKEND_URL",
    "https://smart-invoice-dev.preview.emergentagent.com",
).rstrip("/")
API = f"{BASE_URL}/api"


@pytest.fixture(scope="session")
def api_base():
    return API


@pytest.fixture()
def api_client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


def _register_or_login(session: requests.Session, email: str, password: str, business_name: str) -> str:
    r = session.post(f"{API}/auth/register", json={
        "email": email, "password": password, "business_name": business_name
    })
    if r.status_code == 200:
        return r.json()["access_token"]
    # Fallback to login (user already exists)
    r = session.post(f"{API}/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    return r.json()["access_token"]


@pytest.fixture(scope="session")
def primary_token():
    """Auth token for the canonical QA test user.

    NOTE: `qa@invoiceai.test` (per /app/memory/test_credentials.md) fails the
    backend's Pydantic EmailStr validator, which rejects the reserved `.test`
    TLD with 422. Falling back to a valid domain here so the rest of the
    suite can execute; the 422 issue is reported to the main agent.
    """
    s = requests.Session()
    return _register_or_login(s, "qa@invoiceai.example.com", "Password123!", "QA Testing Co")


@pytest.fixture()
def auth_client(primary_token):
    s = requests.Session()
    s.headers.update({
        "Content-Type": "application/json",
        "Authorization": f"Bearer {primary_token}",
    })
    return s


@pytest.fixture()
def fresh_business():
    """Register a fresh, isolated business (unique email) and return (session, token, email)."""
    email = f"TEST_{uuid.uuid4().hex[:10]}@example.com"
    s = requests.Session()
    r = s.post(f"{API}/auth/register", json={
        "email": email, "password": "Password123!", "business_name": "TEST_ISO_BIZ"
    })
    assert r.status_code == 200, r.text
    token = r.json()["access_token"]
    s.headers.update({"Content-Type": "application/json", "Authorization": f"Bearer {token}"})
    return {"session": s, "token": token, "email": email}
