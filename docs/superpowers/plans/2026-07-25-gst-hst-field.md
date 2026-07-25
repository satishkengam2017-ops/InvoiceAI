# GST/HST Registration No. Field Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a single, optional "GST/HST Registration No." text field to the Business Profile card on the Settings screen, persisted as a new column on the business.

**Architecture:** One new nullable string column on `Business` (Alembic migration), one new field on the `BusinessUpdate` schema, one new `Input` in the existing Business Profile form — no new routes, since `GET/PATCH /business/me` already round-trip every model column automatically.

**Tech Stack:** SQLAlchemy 2.0, Alembic, FastAPI/Pydantic, React Native (Expo).

## Global Constraints

- Field name: `gst_hst_number` everywhere (model column, schema field, TypeScript type, state variable `gstHstNumber`/setter `setGstHstNumber`).
- No format validation on the value — GST/HST formats vary by country.
- No changes to invoice PDFs, the AI extraction prompt, or any route other than the existing `PATCH /business/me`.

---

### Task 1: Backend — add the `gst_hst_number` column

**Files:**
- Modify: `backend/app/models.py`
- Modify: `backend/app/schemas.py`
- Create: `backend/alembic/versions/<new>_add_gst_hst_number.py`

**Interfaces:**
- Consumes: existing `Business` model, existing `BusinessUpdate` schema (both already defined).
- Produces: `Business.gst_hst_number` column, `BusinessUpdate.gst_hst_number` field — consumed by Task 2's frontend work via the existing `GET/PATCH /business/me` routes (no route code changes needed; they already serialize/accept every column).

- [ ] **Step 1: Add the column to the SQLAlchemy model**

In `backend/app/models.py`, find this line in the `Business` class:

```python
    website: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    logo_url: Mapped[Optional[str]] = mapped_column(String, nullable=True)
```

Add a new line immediately after `logo_url`:

```python
    website: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    logo_url: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    gst_hst_number: Mapped[Optional[str]] = mapped_column(String, nullable=True)
```

- [ ] **Step 2: Add the field to the Pydantic schema**

In `backend/app/schemas.py`, find the `BusinessUpdate` class:

```python
class BusinessUpdate(BaseModel):
    name: Optional[str] = None
    legal_name: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    website: Optional[str] = None
    logo_url: Optional[str] = None
```

Add a new line immediately after `logo_url`:

```python
class BusinessUpdate(BaseModel):
    name: Optional[str] = None
    legal_name: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    website: Optional[str] = None
    logo_url: Optional[str] = None
    gst_hst_number: Optional[str] = None
```

- [ ] **Step 3: Generate and fill in the Alembic migration**

Run, from `backend/`:

```bash
.venv\Scripts\python.exe -m alembic revision -m "add_gst_hst_number"
```

This creates a new file in `backend/alembic/versions/` with an auto-generated revision ID and `down_revision = '8f9241962755'` (the current head — confirmed by reading `backend/alembic/versions/8f9241962755_initial_schema.py`). Open the new file and replace its `upgrade()`/`downgrade()` functions with:

```python
def upgrade() -> None:
    op.add_column('businesses', sa.Column('gst_hst_number', sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column('businesses', 'gst_hst_number')
```

(`op` and `sa` are already imported by Alembic's generated template — do not add duplicate imports.)

- [ ] **Step 4: Apply the migration and verify**

```bash
cd backend
.venv\Scripts\python.exe -m alembic upgrade head
```

Load env vars first (`set -a && source .env && set +a` in git-bash) — never print/echo the file's contents or any secret value. Expected: migration applies with no errors.

Then verify live:

```bash
.venv\Scripts\python.exe -c "from app.models import Business; print('gst_hst_number' in Business.__table__.columns)"
```

Expected: `True`.

- [ ] **Step 5: Live verification against the real database**

Build a throwaway script (do not commit it) that: registers a fresh test business, `PATCH /business/me` with `{"gst_hst_number": "123456789RT0001"}`, confirms the response includes that value, `GET /business/me` confirms it persisted, then `PATCH /business/me` with `{"gst_hst_number": null}` confirms it can be cleared back to null. Clean up the test business/user at the end.

- [ ] **Step 6: Commit**

```bash
git add backend/app/models.py backend/app/schemas.py backend/alembic/versions/
git commit -m "Add gst_hst_number column to Business"
```

---

### Task 2: Frontend — add the form field

**Files:**
- Modify: `frontend/app/(app)/settings.tsx`
- Modify: `frontend/src/lib/types.ts`

**Interfaces:**
- Consumes: `PATCH /business/me` via the existing `api.patch<Business>("/business/me", {...})` call already used by `saveProfile` (Task 1's backend work — the field is already accepted once that's deployed).
- Produces: nothing consumed by other tasks — this is the last task in the plan.

- [ ] **Step 1: Add the type field**

In `frontend/src/lib/types.ts`, find the `Business` type's `website`/`logo_url` fields (same fields referenced in the backend model) and add `gst_hst_number` alongside them:

```typescript
  gst_hst_number?: string | null;
```

(Match the exact style of the adjacent optional string fields already in that type.)

- [ ] **Step 2: Add state and wire it into load/save**

In `frontend/app/(app)/settings.tsx`, find this line:

```typescript
  const [defaultTerms, setDefaultTerms] = useState(business?.default_terms || "");
```

Add a new line immediately after it:

```typescript
  const [defaultTerms, setDefaultTerms] = useState(business?.default_terms || "");
  const [gstHstNumber, setGstHstNumber] = useState(business?.gst_hst_number || "");
```

Find this `useEffect` block:

```typescript
  useEffect(() => {
    if (business) {
      setName(business.name);
      setEmail(business.email || "");
      setCurrency(business.currency);
      setDefaultTerms(business.default_terms || "");
      setStripeUrl(business.stripe_payment_url_default || "");
      setPlan(business.plan);
    }
  }, [business]);
```

Add `setGstHstNumber` alongside `setDefaultTerms`:

```typescript
  useEffect(() => {
    if (business) {
      setName(business.name);
      setEmail(business.email || "");
      setCurrency(business.currency);
      setDefaultTerms(business.default_terms || "");
      setGstHstNumber(business.gst_hst_number || "");
      setStripeUrl(business.stripe_payment_url_default || "");
      setPlan(business.plan);
    }
  }, [business]);
```

Find `saveProfile`:

```typescript
  const saveProfile = async () => {
    setSaving(true);
    try {
      await api.patch<Business>("/business/me", {
        name: name.trim(),
        email: email.trim(),
        currency: currency.trim().toUpperCase(),
        default_terms: defaultTerms.trim() || null,
      });
```

Add `gst_hst_number` to the PATCH payload:

```typescript
  const saveProfile = async () => {
    setSaving(true);
    try {
      await api.patch<Business>("/business/me", {
        name: name.trim(),
        email: email.trim(),
        currency: currency.trim().toUpperCase(),
        default_terms: defaultTerms.trim() || null,
        gst_hst_number: gstHstNumber.trim() || null,
      });
```

- [ ] **Step 3: Add the form field**

Find this line in the Business Profile card:

```typescript
            <Input testID="settings-terms" label="Default terms" value={defaultTerms} onChangeText={setDefaultTerms} multiline />
            <Button testID="settings-save-profile" title="Save Profile" loading={saving} onPress={saveProfile} />
```

Insert the new field between them:

```typescript
            <Input testID="settings-terms" label="Default terms" value={defaultTerms} onChangeText={setDefaultTerms} multiline />
            <Input testID="settings-gst-hst" label="GST/HST Registration No." value={gstHstNumber} onChangeText={setGstHstNumber} />
            <Button testID="settings-save-profile" title="Save Profile" loading={saving} onPress={saveProfile} />
```

- [ ] **Step 4: Typecheck**

```bash
cd frontend
npx tsc --noEmit
```

Expected: no errors referencing `frontend/app/(app)/settings.tsx` or `frontend/src/lib/types.ts`.

- [ ] **Step 5: Manual verification — web**

Start the web app against a backend that has Task 1's migration applied. Sign in, go to Settings, confirm the "GST/HST Registration No." field appears in the Business Profile card, type a value, tap Save Profile, confirm the success alert, reload the page, confirm the value persisted. Clear it and save again, confirm it saves as empty without erroring.

- [ ] **Step 6: Commit**

```bash
git add "frontend/app/(app)/settings.tsx" frontend/src/lib/types.ts
git commit -m "Add GST/HST Registration No. field to Settings"
```
