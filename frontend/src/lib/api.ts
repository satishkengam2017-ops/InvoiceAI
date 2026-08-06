import { storage } from "@/src/utils/storage";

const BASE_URL = process.env.EXPO_PUBLIC_BACKEND_URL;

export const AUTH_TOKEN_KEY = "invoiceai_auth_token";

export type ApiError = { detail?: unknown; status: number; message: string };

async function getToken(): Promise<string | null> {
  return await storage.secureGet<string | null>(AUTH_TOKEN_KEY, null);
}

// FastAPI/Pydantic 422 responses put `detail` as an array of
// { msg, loc, ... } objects rather than a string - falling through to
// JSON.stringify for that shape shows the user a raw JSON blob instead of
// the human-readable validation message buried inside it.
function extractErrorMessage(detail: unknown, status: number): string {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail) && detail.length > 0 && detail.every((d) => d && typeof d === "object" && "msg" in d)) {
    return detail.map((d) => String((d as { msg: unknown }).msg)).join(" ");
  }
  if (detail === undefined) return `Request failed (${status})`;
  return JSON.stringify(detail);
}

async function apiFetch<T = unknown>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const token = await getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init.headers as Record<string, string> | undefined),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${BASE_URL}/api${path}`, { ...init, headers });
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }

  if (!res.ok) {
    const detail = body && typeof body === "object" && "detail" in body ? (body as { detail: unknown }).detail : undefined;
    const message = extractErrorMessage(detail, res.status);
    const err = new Error(message) as Error & { status?: number; body?: unknown };
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body as T;
}

export const api = {
  get: <T = unknown>(p: string) => apiFetch<T>(p),
  post: <T = unknown>(p: string, data?: unknown) =>
    apiFetch<T>(p, { method: "POST", body: JSON.stringify(data ?? {}) }),
  patch: <T = unknown>(p: string, data?: unknown) =>
    apiFetch<T>(p, { method: "PATCH", body: JSON.stringify(data ?? {}) }),
  del: <T = unknown>(p: string) => apiFetch<T>(p, { method: "DELETE" }),
};

export type ScanReceiptResult = {
  vendor_name: string | null;
  date: string | null;
  amount_cents: number | null;
  tax_cents: number | null;
  category_id: string | null;
  description: string | null;
};

// Uses raw fetch (not apiFetch) because this is a multipart upload, not
// JSON. Reading the picked image through fetch()+.blob() — rather than
// building a React-Native-specific {uri, name, type} FormData entry —
// works identically on native and web, per Expo's documented pattern for
// expo-image-picker uploads.
export async function scanReceipt(fileUri: string, fileName: string, mimeType: string): Promise<ScanReceiptResult> {
  const token = await getToken();
  const fileBlob = await (await fetch(fileUri)).blob();
  const form = new FormData();
  form.append("file", fileBlob, fileName);

  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${BASE_URL}/api/expenses/scan-receipt`, {
    method: "POST",
    headers,
    body: form,
  });
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }

  if (!res.ok) {
    const detail = body && typeof body === "object" && "detail" in body ? (body as { detail: unknown }).detail : undefined;
    const message = extractErrorMessage(detail, res.status);
    const err = new Error(message) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return body as ScanReceiptResult;
}

export async function saveToken(token: string) {
  await storage.secureSet(AUTH_TOKEN_KEY, token);
}
export async function clearToken() {
  await storage.secureRemove(AUTH_TOKEN_KEY);
}
