# Design: GST/HST Registration No. field on Business Profile

## Problem

The Settings screen's "Business Profile" card has no way to record a GST/HST registration number. The backend already has a generic, unused `tax_numbers` list mechanism, but the user wants a single, simple, dedicated field rather than a list-editing UI.

## Scope

- New nullable `gst_hst_number` column on `Business` (Alembic migration).
- Add `gst_hst_number: Optional[str] = None` to the `BusinessUpdate` Pydantic schema.
- One new text input on the Settings screen's existing Business Profile card.
- No changes to invoice PDFs, the AI extraction prompt, or anywhere else the business's data is used — this is purely a captured/saved field for now.

## Backend

- `backend/app/models.py`: add `gst_hst_number: Mapped[Optional[str]] = mapped_column(String, nullable=True)` to the `Business` model, alongside the other optional string columns (e.g. next to `website`/`logo_url`).
- New Alembic migration: `ALTER TABLE businesses ADD COLUMN gst_hst_number VARCHAR NULL`.
- `backend/app/schemas.py`: add `gst_hst_number: Optional[str] = None` to `BusinessUpdate`, in the same position as the model (near `website`/`legal_name`).
- No route changes needed: `GET /business/me` and `PATCH /business/me` (`backend/app/routers/business.py`) both already round-trip every column via `to_dict()`/`payload.model_dump(exclude_unset=True)` — a new column is automatically included once it exists on the model and schema.

## Frontend

- `frontend/app/(app)/settings.tsx`: add one `Input` to the existing Business Profile card (same card as Business name/Contact email/Currency/Default terms — `settings.tsx` lines ~184–195), labeled "GST/HST Registration No.", plain text, optional (no format validation — GST/HST formats vary by country and this app isn't locked to one). Wire it into the same `profile` state object and `saveProfile` PATCH payload the other four fields already use.
- `frontend/src/lib/types.ts`: add `gst_hst_number?: string | null;` to the `Business` type.

## Error handling

None needed beyond what already exists — it's a plain optional string field going through the same save path (`PATCH /business/me`) as `name`/`email`/`currency`/`default_terms`, which already has its own save-in-progress/error alert handling in `settings.tsx`.

## Testing

Manual only, matching this codebase's existing convention for Settings/Business Profile fields (no automated tests cover `name`/`email`/`currency`/`default_terms` either). Verify: field saves and persists across a page reload; leaving it blank doesn't error; an existing business with no value shows an empty field rather than "null" or crashing.
