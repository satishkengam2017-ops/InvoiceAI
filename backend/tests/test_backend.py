"""End-to-end backend tests for InvoiceAI FastAPI service."""
import time
import uuid
import requests
from conftest import API


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------
class TestHealth:
    def test_health_ok(self, api_client):
        r = api_client.get(f"{API}/health")
        assert r.status_code == 200
        body = r.json()
        assert body.get("status") == "ok"


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------
class TestAuth:
    def test_register_duplicate_returns_400(self, api_client):
        # Register a new user first
        email = f"TEST_{uuid.uuid4().hex[:10]}@example.com"
        r = api_client.post(f"{API}/auth/register", json={
            "email": email, "password": "Password123!", "business_name": "TEST_Dup"
        })
        assert r.status_code == 200
        # Duplicate
        r2 = api_client.post(f"{API}/auth/register", json={
            "email": email, "password": "Password123!", "business_name": "TEST_Dup"
        })
        assert r2.status_code == 400

    def test_login_wrong_password_400(self, api_client):
        r = api_client.post(f"{API}/auth/login", json={
            "email": "qa@invoiceai.example.com", "password": "WRONG_PASSWORD_x"
        })
        assert r.status_code == 400

    def test_login_success_returns_token(self, api_client):
        r = api_client.post(f"{API}/auth/login", json={
            "email": "qa@invoiceai.example.com", "password": "Password123!"
        })
        assert r.status_code == 200
        data = r.json()
        assert "access_token" in data and data.get("token_type") == "bearer"

    def test_me_requires_token(self, api_client):
        r = api_client.get(f"{API}/auth/me")
        assert r.status_code == 401

    def test_me_with_valid_token(self, auth_client):
        r = auth_client.get(f"{API}/auth/me")
        assert r.status_code == 200
        body = r.json()
        assert body["email"] == "qa@invoiceai.example.com"
        assert "business_id" in body and body["business_id"]
        assert "_id" not in body

    def test_clerk_exchange_with_invalid_token_returns_401(self, api_client):
        r = api_client.post(f"{API}/auth/clerk-exchange", json={"clerk_token": "not-a-real-token"})
        assert r.status_code in (401, 503)


# ---------------------------------------------------------------------------
# Business + Settings
# ---------------------------------------------------------------------------
class TestBusiness:
    def test_get_business_never_exposes_raw_key(self, auth_client):
        r = auth_client.get(f"{API}/business/me")
        assert r.status_code == 200
        body = r.json()
        assert "anthropic_api_key" not in body
        assert "has_anthropic_key" in body
        assert "_id" not in body

    def test_patch_business_updates_fields(self, auth_client):
        r = auth_client.patch(f"{API}/business/me", json={
            "name": "QA Testing Co", "invoice_prefix": "INV", "currency": "USD",
            "default_due_days": 14, "country": "US",
        })
        assert r.status_code == 200
        assert r.json()["name"] == "QA Testing Co"

    def test_settings_rejects_invalid_plan(self, auth_client):
        r = auth_client.patch(f"{API}/settings", json={"plan": "ENTERPRISE"})
        assert r.status_code == 400

    def test_plans_returns_both_stripe_urls_from_env(self, auth_client):
        """Regression: /api/plans must expose the STARTER and PRO Stripe upgrade URLs from backend env."""
        r = auth_client.get(f"{API}/plans")
        assert r.status_code == 200
        body = r.json()
        assert "current" in body and "plans" in body and "usage" in body
        by_key = {p["key"]: p for p in body["plans"]}
        assert set(by_key.keys()) == {"FREE", "STARTER", "PRO"}
        assert by_key["FREE"]["upgrade_url"] is None
        assert by_key["STARTER"]["upgrade_url"] == "https://buy.stripe.com/00w5kw7q56P38E94yz87K01"
        assert by_key["PRO"]["upgrade_url"] == "https://buy.stripe.com/7sYdR2fWB0qFg6Bc1187K02"
        # Sanity: FREE plan is 5 lifetime; STARTER=10/mo; PRO=50/mo
        assert by_key["FREE"]["limit"] == 5 and by_key["FREE"]["scope"] == "lifetime"
        assert by_key["STARTER"]["limit"] == 10 and by_key["STARTER"]["scope"] == "month"
        assert by_key["PRO"]["limit"] == 50 and by_key["PRO"]["scope"] == "month"

    def test_settings_updates_anthropic_key_masked(self, auth_client):
        r = auth_client.patch(f"{API}/settings", json={
            "anthropic_api_key": "sk-ant-DUMMY-not-a-real-key",
            "stripe_payment_url_default": "https://buy.stripe.com/test_dummy",
        })
        assert r.status_code == 200
        body = r.json()
        assert body["has_anthropic_key"] is True
        assert "anthropic_api_key" not in body
        assert body["stripe_payment_url_default"] == "https://buy.stripe.com/test_dummy"


# ---------------------------------------------------------------------------
# Customers CRUD + business isolation
# ---------------------------------------------------------------------------
class TestCustomers:
    def test_customer_crud(self, auth_client):
        # Create
        r = auth_client.post(f"{API}/customers", json={
            "name": "TEST_Acme Corp", "email": "TEST_acme@example.com", "company": "Acme"
        })
        assert r.status_code == 200
        cust = r.json()
        cid = cust["id"]
        assert cust["name"] == "TEST_Acme Corp"
        assert "_id" not in cust

        # Get
        r = auth_client.get(f"{API}/customers/{cid}")
        assert r.status_code == 200
        assert r.json()["id"] == cid

        # List
        r = auth_client.get(f"{API}/customers")
        assert r.status_code == 200
        assert any(c["id"] == cid for c in r.json())

        # Patch
        r = auth_client.patch(f"{API}/customers/{cid}", json={
            "name": "TEST_Acme Corp Updated", "company": "Acme"
        })
        assert r.status_code == 200
        assert r.json()["name"] == "TEST_Acme Corp Updated"

        # Delete (archive)
        r = auth_client.delete(f"{API}/customers/{cid}")
        assert r.status_code == 200

        # Ensure archived customer no longer listed
        r = auth_client.get(f"{API}/customers")
        assert not any(c["id"] == cid for c in r.json())

    def test_business_isolation(self, auth_client, fresh_business):
        # Create in primary business
        r = auth_client.post(f"{API}/customers", json={"name": "TEST_ISO_Primary"})
        assert r.status_code == 200
        primary_cid = r.json()["id"]

        # Fresh business should NOT see this customer
        s = fresh_business["session"]
        r = s.get(f"{API}/customers")
        assert r.status_code == 200
        assert not any(c["id"] == primary_cid for c in r.json())

        # And direct GET should be 404
        r = s.get(f"{API}/customers/{primary_cid}")
        assert r.status_code == 404


# ---------------------------------------------------------------------------
# Vendors CRUD + business isolation
# ---------------------------------------------------------------------------
class TestVendors:
    def test_vendor_crud(self, auth_client):
        r = auth_client.post(f"{API}/vendors", json={
            "name": "TEST_Acme Supply Co", "email": "TEST_acme-supply@example.com"
        })
        assert r.status_code == 200
        vendor = r.json()
        vid = vendor["id"]
        assert vendor["name"] == "TEST_Acme Supply Co"

        r = auth_client.get(f"{API}/vendors/{vid}")
        assert r.status_code == 200
        assert r.json()["id"] == vid

        r = auth_client.get(f"{API}/vendors")
        assert r.status_code == 200
        assert any(v["id"] == vid for v in r.json())

        r = auth_client.patch(f"{API}/vendors/{vid}", json={"name": "TEST_Acme Supply Co Updated"})
        assert r.status_code == 200
        assert r.json()["name"] == "TEST_Acme Supply Co Updated"

        r = auth_client.delete(f"{API}/vendors/{vid}")
        assert r.status_code == 200

        r = auth_client.get(f"{API}/vendors")
        assert not any(v["id"] == vid for v in r.json())

    def test_business_isolation(self, auth_client, fresh_business):
        r = auth_client.post(f"{API}/vendors", json={"name": "TEST_ISO_Vendor"})
        assert r.status_code == 200
        primary_vid = r.json()["id"]

        s = fresh_business["session"]
        r = s.get(f"{API}/vendors")
        assert r.status_code == 200
        assert not any(v["id"] == primary_vid for v in r.json())

        r = s.get(f"{API}/vendors/{primary_vid}")
        assert r.status_code == 404


# ---------------------------------------------------------------------------
# Expense categories CRUD
# ---------------------------------------------------------------------------
class TestExpenseCategories:
    def test_category_crud(self, auth_client):
        r = auth_client.post(f"{API}/expense-categories", json={
            "name": "TEST_Custom Category", "cra_t2125_line": "9270 Other expenses"
        })
        assert r.status_code == 200
        cat = r.json()
        cat_id = cat["id"]
        assert cat["name"] == "TEST_Custom Category"
        assert cat["is_default"] is False

        r = auth_client.get(f"{API}/expense-categories")
        assert r.status_code == 200
        assert any(c["id"] == cat_id for c in r.json())

        r = auth_client.patch(f"{API}/expense-categories/{cat_id}", json={"name": "TEST_Custom Category v2"})
        assert r.status_code == 200
        assert r.json()["name"] == "TEST_Custom Category v2"

        r = auth_client.delete(f"{API}/expense-categories/{cat_id}")
        assert r.status_code == 200

        r = auth_client.get(f"{API}/expense-categories")
        assert not any(c["id"] == cat_id for c in r.json())


# ---------------------------------------------------------------------------
# Default expense category seeding on business creation
# ---------------------------------------------------------------------------
class TestExpenseCategorySeeding:
    def test_new_business_gets_default_categories(self, fresh_business):
        s = fresh_business["session"]
        r = s.get(f"{API}/expense-categories")
        assert r.status_code == 200
        rows = r.json()
        names = {c["name"] for c in rows}
        assert names == {
            "Advertising & Marketing", "Bank Charges & Interest", "Insurance",
            "Meals & Entertainment", "Motor Vehicle Expenses", "Office Supplies",
            "Professional Fees", "Rent", "Repairs & Maintenance", "Salaries & Wages",
            "Supplies", "Travel", "Utilities", "Other Expenses",
        }
        assert all(c["is_default"] for c in rows)


# ---------------------------------------------------------------------------
# Expenses CRUD, filters, business isolation, category-in-use protection
# ---------------------------------------------------------------------------
class TestExpenses:
    def _make_category(self, s, name="TEST_Expense Category"):
        r = s.post(f"{API}/expense-categories", json={"name": name})
        assert r.status_code == 200
        return r.json()["id"]

    def test_expense_crud(self, auth_client):
        cat_id = self._make_category(auth_client)
        r = auth_client.post(f"{API}/expenses", json={
            "category_id": cat_id, "date": "2026-08-01", "amount_cents": 4250, "tax_cents": 250,
            "description": "TEST_Fuel fill-up",
        })
        assert r.status_code == 200
        expense = r.json()
        eid = expense["id"]
        assert expense["amount_cents"] == 4250
        assert expense["currency"]

        r = auth_client.get(f"{API}/expenses/{eid}")
        assert r.status_code == 200
        assert r.json()["id"] == eid

        r = auth_client.get(f"{API}/expenses", params={"category_id": cat_id})
        assert r.status_code == 200
        assert any(e["id"] == eid for e in r.json())

        r = auth_client.patch(f"{API}/expenses/{eid}", json={
            "category_id": cat_id, "date": "2026-08-01", "amount_cents": 5000, "tax_cents": 250,
        })
        assert r.status_code == 200
        assert r.json()["amount_cents"] == 5000

        r = auth_client.delete(f"{API}/expenses/{eid}")
        assert r.status_code == 200
        r = auth_client.get(f"{API}/expenses/{eid}")
        assert r.status_code == 404

    def test_date_range_filter(self, fresh_business):
        s = fresh_business["session"]
        cat_id = self._make_category(s)
        s.post(f"{API}/expenses", json={"category_id": cat_id, "date": "2026-01-15", "amount_cents": 1000})
        s.post(f"{API}/expenses", json={"category_id": cat_id, "date": "2026-06-15", "amount_cents": 2000})

        r = s.get(f"{API}/expenses", params={"from_date": "2026-06-01", "to_date": "2026-06-30"})
        assert r.status_code == 200
        rows = r.json()
        assert len(rows) == 1
        assert rows[0]["date"] == "2026-06-15"

    def test_business_isolation(self, auth_client, fresh_business):
        cat_id = self._make_category(auth_client, "TEST_ISO_Category")
        r = auth_client.post(f"{API}/expenses", json={"category_id": cat_id, "date": "2026-08-01", "amount_cents": 100})
        assert r.status_code == 200
        primary_eid = r.json()["id"]

        s = fresh_business["session"]
        r = s.get(f"{API}/expenses")
        assert r.status_code == 200
        assert not any(e["id"] == primary_eid for e in r.json())
        r = s.get(f"{API}/expenses/{primary_eid}")
        assert r.status_code == 404

    def test_category_delete_blocked_while_in_use(self, fresh_business):
        s = fresh_business["session"]
        cat_id = self._make_category(s, "TEST_In_Use_Category")
        r = s.post(f"{API}/expenses", json={"category_id": cat_id, "date": "2026-08-01", "amount_cents": 500})
        assert r.status_code == 200

        r = s.delete(f"{API}/expense-categories/{cat_id}")
        assert r.status_code == 409

    def test_create_rejects_category_from_other_business(self, auth_client, fresh_business):
        """Cross-tenant FK guard: a category_id belonging to another
        business must not be usable, even though it's a well-formed,
        existing row."""
        other_cat_id = self._make_category(fresh_business["session"], "TEST_Other_Biz_Category")
        r = auth_client.post(f"{API}/expenses", json={
            "category_id": other_cat_id, "date": "2026-08-01", "amount_cents": 100,
        })
        assert r.status_code == 400

    def test_create_rejects_nonexistent_category(self, auth_client):
        r = auth_client.post(f"{API}/expenses", json={
            "category_id": str(uuid.uuid4()), "date": "2026-08-01", "amount_cents": 100,
        })
        assert r.status_code == 400

    def test_create_rejects_malformed_category_id(self, auth_client):
        r = auth_client.post(f"{API}/expenses", json={
            "category_id": "not-a-uuid", "date": "2026-08-01", "amount_cents": 100,
        })
        assert r.status_code == 400

    def test_create_rejects_invalid_vendor_id(self, auth_client):
        cat_id = self._make_category(auth_client, "TEST_Vendor_Validation_Category")
        r = auth_client.post(f"{API}/expenses", json={
            "category_id": cat_id, "vendor_id": str(uuid.uuid4()), "date": "2026-08-01", "amount_cents": 100,
        })
        assert r.status_code == 400

    def test_create_rejects_vendor_from_other_business(self, auth_client, fresh_business):
        cat_id = self._make_category(auth_client, "TEST_Vendor_ISO_Category")
        other_s = fresh_business["session"]
        r = other_s.post(f"{API}/vendors", json={"name": "TEST_Other_Biz_Vendor"})
        assert r.status_code == 200
        other_vendor_id = r.json()["id"]

        r = auth_client.post(f"{API}/expenses", json={
            "category_id": cat_id, "vendor_id": other_vendor_id, "date": "2026-08-01", "amount_cents": 100,
        })
        assert r.status_code == 400

    def test_update_rejects_category_from_other_business(self, auth_client, fresh_business):
        cat_id = self._make_category(auth_client, "TEST_Update_Category")
        r = auth_client.post(f"{API}/expenses", json={"category_id": cat_id, "date": "2026-08-01", "amount_cents": 100})
        assert r.status_code == 200
        eid = r.json()["id"]

        other_cat_id = self._make_category(fresh_business["session"], "TEST_Update_Other_Biz_Category")
        r = auth_client.patch(f"{API}/expenses/{eid}", json={
            "category_id": other_cat_id, "date": "2026-08-01", "amount_cents": 100,
        })
        assert r.status_code == 400

    def test_create_rejects_invalid_date_format(self, auth_client):
        cat_id = self._make_category(auth_client, "TEST_Date_Validation_Category")
        r = auth_client.post(f"{API}/expenses", json={
            "category_id": cat_id, "date": "08/01/2026", "amount_cents": 100,
        })
        assert r.status_code == 400


# ---------------------------------------------------------------------------
# AI receipt scanning (graceful handling — mirrors TestAIExtract)
# ---------------------------------------------------------------------------
class TestReceiptScan:
    def test_no_key_returns_400(self, fresh_business):
        s = fresh_business["session"]
        files = {"file": ("receipt.jpg", b"fake-image-bytes", "image/jpeg")}
        # The session sets Content-Type: application/json by default (see
        # conftest.py); overriding it to None here lets `requests` generate
        # the correct multipart/form-data boundary for the file upload.
        r = s.post(f"{API}/expenses/scan-receipt", files=files, headers={"Content-Type": None})
        assert r.status_code == 400
        assert "Anthropic" in r.json().get("detail", "")

    def test_invalid_key_returns_502(self, fresh_business):
        s = fresh_business["session"]
        r = s.patch(f"{API}/settings", json={"anthropic_api_key": "sk-ant-invalid-key-for-test"})
        assert r.status_code == 200
        files = {"file": ("receipt.jpg", b"fake-image-bytes", "image/jpeg")}
        r = s.post(f"{API}/expenses/scan-receipt", files=files, headers={"Content-Type": None})
        assert r.status_code == 502, f"expected 502, got {r.status_code} {r.text}"


# ---------------------------------------------------------------------------
# Catalog CRUD
# ---------------------------------------------------------------------------
class TestCatalog:
    def test_catalog_crud(self, auth_client):
        r = auth_client.post(f"{API}/catalog", json={
            "name": "TEST_Consulting Hour", "unit_price_cents": 15000, "tax_percent": 0
        })
        assert r.status_code == 200
        item = r.json()
        iid = item["id"]
        assert item["unit_price_cents"] == 15000
        assert "_id" not in item

        r = auth_client.get(f"{API}/catalog")
        assert r.status_code == 200 and any(x["id"] == iid for x in r.json())

        r = auth_client.patch(f"{API}/catalog/{iid}", json={
            "name": "TEST_Consulting Hour v2", "unit_price_cents": 20000, "tax_percent": 5
        })
        assert r.status_code == 200
        assert r.json()["unit_price_cents"] == 20000

        r = auth_client.delete(f"{API}/catalog/{iid}")
        assert r.status_code == 200


# ---------------------------------------------------------------------------
# Invoices lifecycle (uses a fresh business so we can test FREE plan limit cleanly)
# ---------------------------------------------------------------------------
class TestInvoicesLifecycle:
    def _make_customer(self, s):
        r = s.post(f"{API}/customers", json={"name": "TEST_Cust_Inv"})
        assert r.status_code == 200
        return r.json()["id"]

    def test_full_invoice_lifecycle(self, fresh_business):
        s = fresh_business["session"]
        cid = self._make_customer(s)

        # Create invoice #1 - subtotal 200 + 10% tax = 220, minus 20 fixed discount = 200
        payload = {
            "customer_id": cid,
            "line_items": [
                {"name": "Item A", "quantity": 2, "unit_price_cents": 10000, "tax_percent": 10}
            ],
            "discount_type": "FIXED",
            "discount_value": 2000,  # $20 off
        }
        r = s.post(f"{API}/invoices", json=payload)
        assert r.status_code == 200, r.text
        inv1 = r.json()
        assert inv1["number"].startswith("INV-")
        assert inv1["number"].endswith("0001")
        # 2 * 10000 = 20000 subtotal, tax = 2000, discount = 2000 -> total = 20000
        assert inv1["subtotal_cents"] == 20000
        assert inv1["tax_total_cents"] == 2000
        assert inv1["discount_cents"] == 2000
        assert inv1["total_cents"] == 20000
        assert inv1["status"] == "DRAFT"
        assert "_id" not in inv1

        # Send (DRAFT -> SENT)
        r = s.post(f"{API}/invoices/{inv1['id']}/send")
        assert r.status_code == 200
        assert r.json()["status"] == "SENT"
        assert r.json()["sent_at"]

        # Duplicate (should become INV-0002 DRAFT)
        r = s.post(f"{API}/invoices/{inv1['id']}/duplicate")
        assert r.status_code == 200
        inv_dup = r.json()
        assert inv_dup["status"] == "DRAFT"
        assert inv_dup["number"].endswith("0002")

        # Partial payment on inv1
        r = s.post(f"{API}/invoices/{inv1['id']}/mark-paid", json={"amount_cents": 5000, "method": "cash"})
        assert r.status_code == 200
        assert r.json()["status"] == "PARTIALLY_PAID"

        # Full payment
        r = s.post(f"{API}/invoices/{inv1['id']}/mark-paid", json={"method": "cash"})
        assert r.status_code == 200
        assert r.json()["status"] == "PAID"

        # Void a PAID invoice must fail
        r = s.post(f"{API}/invoices/{inv1['id']}/void")
        assert r.status_code == 400

        # Void the duplicate (DRAFT) should succeed
        r = s.post(f"{API}/invoices/{inv_dup['id']}/void")
        assert r.status_code == 200
        assert r.json()["status"] == "VOID"

        # List + status filter
        r = s.get(f"{API}/invoices", params={"status_filter": "PAID"})
        assert r.status_code == 200
        assert all(inv["status"] == "PAID" for inv in r.json())
        assert any(inv["id"] == inv1["id"] for inv in r.json())

    def test_free_plan_lifetime_limit(self, fresh_business):
        s = fresh_business["session"]
        cid = self._make_customer(s)

        payload = {
            "customer_id": cid,
            "line_items": [{"name": "Item", "quantity": 1, "unit_price_cents": 1000}],
        }
        # Fresh business already has whatever invoices from other test; use its OWN fresh instance
        # So this fixture is unique per test - safe to create 5
        created = 0
        for i in range(5):
            r = s.post(f"{API}/invoices", json=payload)
            if r.status_code == 200:
                created += 1
            else:
                break
        assert created == 5, f"Expected to create 5, only created {created}"

        # 6th must be blocked with 402 PLAN_LIMIT_REACHED
        r = s.post(f"{API}/invoices", json=payload)
        assert r.status_code == 402
        detail = r.json().get("detail", {})
        # detail may be dict
        if isinstance(detail, dict):
            assert detail.get("error") == "PLAN_LIMIT_REACHED"

    def test_invoice_customer_from_other_business_rejected(self, auth_client, fresh_business):
        # Create customer in primary business
        r = auth_client.post(f"{API}/customers", json={"name": "TEST_XBiz"})
        primary_cid = r.json()["id"]
        # Fresh business tries to create invoice with that customer
        s = fresh_business["session"]
        r = s.post(f"{API}/invoices", json={
            "customer_id": primary_cid,
            "line_items": [{"name": "x", "quantity": 1, "unit_price_cents": 100}],
        })
        assert r.status_code == 400

    def test_invoice_patch_customer_from_other_business_rejected(self, auth_client, fresh_business):
        # Regression test: PATCH must reject repointing customer_id to another
        # business's customer, same as POST already does. Also confirms the
        # invoice's customer_id/customer are left untouched by the rejection.
        s = fresh_business["session"]
        own_cid = self._make_customer(s)
        r = s.post(f"{API}/invoices", json={
            "customer_id": own_cid,
            "line_items": [{"name": "Item", "quantity": 1, "unit_price_cents": 1000}],
        })
        assert r.status_code == 200, r.text
        inv = r.json()

        # Create a customer in a DIFFERENT business (the primary auth_client's)
        r = auth_client.post(f"{API}/customers", json={"name": "TEST_XBiz_Patch"})
        assert r.status_code == 200
        foreign_cid = r.json()["id"]

        r = s.patch(f"{API}/invoices/{inv['id']}", json={
            "customer_id": foreign_cid,
            "line_items": [{"name": "Item", "quantity": 1, "unit_price_cents": 1000}],
        })
        assert r.status_code == 400

        # Invoice must be unchanged: still points at the original customer
        r = s.get(f"{API}/invoices/{inv['id']}")
        assert r.status_code == 200
        assert r.json()["customer_id"] == own_cid
        assert r.json()["customer"]["id"] == own_cid

    def test_invoice_patch_replaces_line_items(self, fresh_business):
        # Regression test: PATCH replacing line items must fully replace, not
        # accumulate, and the PATCH response itself (not just a subsequent
        # GET) must reflect only the new items.
        s = fresh_business["session"]
        cid = self._make_customer(s)
        r = s.post(f"{API}/invoices", json={
            "customer_id": cid,
            "line_items": [
                {"name": "Old Widget", "quantity": 1, "unit_price_cents": 1000},
                {"name": "Old Gadget", "quantity": 1, "unit_price_cents": 500},
            ],
        })
        assert r.status_code == 200, r.text
        inv = r.json()
        assert len(inv["line_items"]) == 2

        r = s.patch(f"{API}/invoices/{inv['id']}", json={
            "customer_id": cid,
            "line_items": [{"name": "New Replacement", "quantity": 3, "unit_price_cents": 2000}],
        })
        assert r.status_code == 200, r.text
        patched = r.json()
        names = [li["name"] for li in patched["line_items"]]
        assert names == ["New Replacement"], names
        assert patched["subtotal_cents"] == 6000

        # Independent GET must agree (confirms DB state, not just response shape)
        r = s.get(f"{API}/invoices/{inv['id']}")
        assert r.status_code == 200
        names = [li["name"] for li in r.json()["line_items"]]
        assert names == ["New Replacement"], names

    def test_email_pdf_from_other_business_rejected(self, auth_client, fresh_business):
        # Regression test: POST /invoices/{id}/email-pdf must be scoped by
        # business_id like every other invoice route. The 404 check runs
        # before any PDF rendering or Supabase Storage upload is attempted,
        # so this needs no external infra beyond the app itself.
        s = fresh_business["session"]
        cid = self._make_customer(s)
        r = s.post(f"{API}/invoices", json={
            "customer_id": cid,
            "line_items": [{"name": "Item", "quantity": 1, "unit_price_cents": 1000}],
        })
        assert r.status_code == 200, r.text
        invoice_id = r.json()["id"]

        r = auth_client.post(f"{API}/invoices/{invoice_id}/email-pdf", json={
            "html": "<html><body>Should not render</body></html>",
        })
        assert r.status_code == 404


# ---------------------------------------------------------------------------
# Estimates CRUD + business isolation
# ---------------------------------------------------------------------------
class TestEstimatesCRUD:
    def _make_customer(self, s, name="TEST_Cust_Est"):
        r = s.post(f"{API}/customers", json={"name": name})
        assert r.status_code == 200, r.text
        return r.json()["id"]

    def test_estimate_crud(self, fresh_business):
        s = fresh_business["session"]
        cid = self._make_customer(s)
        payload = {
            "customer_id": cid,
            "line_items": [{"name": "Item A", "quantity": 2, "unit_price_cents": 10000, "tax_percent": 10}],
            "discount_type": "FIXED",
            "discount_value": 2000,
        }
        r = s.post(f"{API}/estimates", json=payload)
        assert r.status_code == 200, r.text
        est = r.json()
        assert est["number"].startswith("EST-")
        assert est["number"].endswith("0001")
        assert est["subtotal_cents"] == 20000
        assert est["tax_total_cents"] == 2000
        assert est["discount_cents"] == 2000
        assert est["total_cents"] == 20000
        assert est["status"] == "DRAFT"
        eid = est["id"]

        r = s.get(f"{API}/estimates/{eid}")
        assert r.status_code == 200
        assert r.json()["id"] == eid

        r = s.get(f"{API}/estimates")
        assert r.status_code == 200
        assert any(e["id"] == eid for e in r.json())

        r = s.patch(f"{API}/estimates/{eid}", json={
            "customer_id": cid,
            "line_items": [{"name": "Item B", "quantity": 1, "unit_price_cents": 5000}],
        })
        assert r.status_code == 200
        assert r.json()["total_cents"] == 5000
        names = [li["name"] for li in r.json()["line_items"]]
        assert names == ["Item B"]

        r = s.delete(f"{API}/estimates/{eid}")
        assert r.status_code == 200
        r = s.get(f"{API}/estimates/{eid}")
        assert r.status_code == 404

    def test_delete_blocked_once_sent(self, fresh_business):
        # NOTE: deviates from the plan's literal test body, which drove this
        # via POST /estimates/{id}/send. That endpoint doesn't exist yet -
        # it's added by Task 5 (TestEstimatesLifecycle), which runs after
        # this task. Task 4's own EstimateIn/create_estimate already accepts
        # an explicit `status` on creation (mirroring how InvoiceIn/
        # create_invoice accepts `status` too), so we reach the same "estimate
        # in a non-DRAFT state" precondition directly through create, without
        # depending on a not-yet-implemented endpoint. Once Task 5 lands,
        # this still exercises the identical PATCH/DELETE-blocked-once-
        # non-DRAFT behavior; only the setup path differs.
        s = fresh_business["session"]
        cid = self._make_customer(s)
        r = s.post(f"{API}/estimates", json={
            "customer_id": cid,
            "line_items": [{"name": "Item", "quantity": 1, "unit_price_cents": 1000}],
            "status": "SENT",
        })
        assert r.status_code == 200, r.text
        est = r.json()
        assert est["status"] == "SENT"
        eid = est["id"]

        r = s.delete(f"{API}/estimates/{eid}")
        assert r.status_code == 400

        r = s.patch(f"{API}/estimates/{eid}", json={
            "customer_id": cid,
            "line_items": [{"name": "Item", "quantity": 1, "unit_price_cents": 1000}],
        })
        assert r.status_code == 400

    def test_business_isolation(self, auth_client, fresh_business):
        r = auth_client.post(f"{API}/customers", json={"name": "TEST_ISO_Est_Cust"})
        assert r.status_code == 200
        cid = r.json()["id"]
        r = auth_client.post(f"{API}/estimates", json={
            "customer_id": cid,
            "line_items": [{"name": "Item", "quantity": 1, "unit_price_cents": 1000}],
        })
        assert r.status_code == 200
        primary_eid = r.json()["id"]

        s = fresh_business["session"]
        r = s.get(f"{API}/estimates")
        assert r.status_code == 200
        assert not any(e["id"] == primary_eid for e in r.json())
        r = s.get(f"{API}/estimates/{primary_eid}")
        assert r.status_code == 404


# ---------------------------------------------------------------------------
# Estimate lifecycle: send / accept / decline / duplicate
# ---------------------------------------------------------------------------
class TestEstimatesLifecycle:
    def _make_estimate(self, s, cust_name="TEST_Cust_EstLC"):
        r = s.post(f"{API}/customers", json={"name": cust_name})
        assert r.status_code == 200
        cid = r.json()["id"]
        r = s.post(f"{API}/estimates", json={
            "customer_id": cid,
            "line_items": [{"name": "Item", "quantity": 1, "unit_price_cents": 5000}],
        })
        assert r.status_code == 200, r.text
        return r.json()

    def test_send_accept_flow(self, fresh_business):
        s = fresh_business["session"]
        est = self._make_estimate(s)

        r = s.post(f"{API}/estimates/{est['id']}/send")
        assert r.status_code == 200
        assert r.json()["status"] == "SENT"
        assert r.json()["sent_at"]

        r = s.post(f"{API}/estimates/{est['id']}/accept")
        assert r.status_code == 200
        assert r.json()["status"] == "ACCEPTED"
        assert r.json()["accepted_at"]

    def test_accept_before_send_rejected(self, fresh_business):
        s = fresh_business["session"]
        est = self._make_estimate(s)
        r = s.post(f"{API}/estimates/{est['id']}/accept")
        assert r.status_code == 400

    def test_decline_flow(self, fresh_business):
        s = fresh_business["session"]
        est = self._make_estimate(s)
        s.post(f"{API}/estimates/{est['id']}/send")

        r = s.post(f"{API}/estimates/{est['id']}/decline")
        assert r.status_code == 200
        assert r.json()["status"] == "DECLINED"
        assert r.json()["declined_at"]

        # A declined estimate can't then be accepted.
        r = s.post(f"{API}/estimates/{est['id']}/accept")
        assert r.status_code == 400

    def test_duplicate(self, fresh_business):
        s = fresh_business["session"]
        est = self._make_estimate(s)
        s.post(f"{API}/estimates/{est['id']}/send")

        r = s.post(f"{API}/estimates/{est['id']}/duplicate")
        assert r.status_code == 200
        dup = r.json()
        assert dup["id"] != est["id"]
        assert dup["status"] == "DRAFT"
        assert dup["number"].endswith("0002")
        assert dup["total_cents"] == est["total_cents"]
        names = [li["name"] for li in dup["line_items"]]
        assert names == ["Item"]


# ---------------------------------------------------------------------------
# Dashboard
# ---------------------------------------------------------------------------
class TestDashboard:
    def test_dashboard_summary_shape(self, auth_client):
        r = auth_client.get(f"{API}/dashboard/summary")
        assert r.status_code == 200
        data = r.json()
        for k in ["revenue_this_month_cents", "outstanding_cents", "overdue_cents",
                  "chart_months", "plan_usage", "plan"]:
            assert k in data, f"missing key {k}"
        assert isinstance(data["chart_months"], list) and len(data["chart_months"]) == 6
        assert "used" in data["plan_usage"] and "limit" in data["plan_usage"]


# ---------------------------------------------------------------------------
# AI extraction (graceful handling)
# ---------------------------------------------------------------------------
class TestAIExtract:
    def test_no_key_returns_400(self, fresh_business):
        # fresh_business has no anthropic key set
        s = fresh_business["session"]
        r = s.post(f"{API}/ai/extract-invoice", json={"text": "Invoice Acme for 5 hours @ $95"})
        assert r.status_code == 400
        assert "Anthropic" in r.json().get("detail", "")

    def test_invalid_key_returns_502(self, fresh_business):
        s = fresh_business["session"]
        # Set a fake key
        r = s.patch(f"{API}/settings", json={"anthropic_api_key": "sk-ant-invalid-key-for-test"})
        assert r.status_code == 200
        # Now call extract; should not crash, should return 502
        r = s.post(f"{API}/ai/extract-invoice", json={"text": "Invoice Acme for 5 hours @ $95"})
        assert r.status_code == 502, f"expected 502, got {r.status_code} {r.text}"
