// Model-provider connections client. control-api enforces auth server-side; we send the
// session cookie via credentials:'include'. Discriminated results so an outage isn't shown
// as a validation error.
const base = import.meta.env.VITE_CONTROL_API_URL ?? "http://localhost:8080";

export type ProviderKind = "openai" | "anthropic" | "openai-compatible";
export type ProviderStatus = "connected" | "error" | "unconfigured";

export interface Provider {
  id: string;
  provider: ProviderKind;
  name: string;
  baseUrl: string | null;
  keyLast4: string | null;
  status: ProviderStatus;
  lastError: string | null;
  models: string[];
}

export interface ConnectInput {
  provider: ProviderKind;
  apiKey: string;
  name?: string;
  baseUrl?: string;
  models?: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

async function req<T>(path: string, init?: RequestInit): Promise<Result<T>> {
  try {
    const r = await fetch(`${base}${path}`, { credentials: "include", ...init });
    if (r.ok) return { ok: true, value: (await r.json().catch(() => ({}))) as T };
    const body = (await r.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: body.error ?? `Request failed (${r.status}).` };
  } catch {
    return { ok: false, error: "Can't reach the control plane." };
  }
}

export async function listProviders(): Promise<Result<Provider[]>> {
  const r = await req<{ providers: Provider[] }>("/connections/providers");
  return r.ok ? { ok: true, value: r.value.providers } : r;
}

export function connectProvider(input: ConnectInput): Promise<Result<{ provider: Provider }>> {
  return req("/connections/providers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function rotateKey(id: string, apiKey: string): Promise<Result<{ provider: Provider }>> {
  return req(`/connections/providers/${id}/rotate-key`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apiKey }),
  });
}

export function removeProvider(id: string): Promise<Result<{ ok: true }>> {
  return req(`/connections/providers/${id}`, { method: "DELETE" });
}
