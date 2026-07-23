import { storage } from "@/src/utils/storage";

const BASE_URL = process.env.EXPO_PUBLIC_BACKEND_URL;

export const AUTH_TOKEN_KEY = "invoiceai_auth_token";

export type ApiError = { detail?: unknown; status: number; message: string };

async function getToken(): Promise<string | null> {
  return await storage.secureGet<string | null>(AUTH_TOKEN_KEY, null);
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
    const message =
      (body && typeof body === "object" && "detail" in body
        ? typeof (body as { detail: unknown }).detail === "string"
          ? String((body as { detail: string }).detail)
          : JSON.stringify((body as { detail: unknown }).detail)
        : `Request failed (${res.status})`);
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

export async function saveToken(token: string) {
  await storage.secureSet(AUTH_TOKEN_KEY, token);
}
export async function clearToken() {
  await storage.secureRemove(AUTH_TOKEN_KEY);
}
