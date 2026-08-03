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
  models: string[]; // the provider's available catalog (Story 2.4)
  enabledModels: string[]; // the curated subset selectable in the agent picker (Story 2.4)
}

export interface ConnectInput {
  provider: ProviderKind;
  apiKey: string;
  name?: string;
  baseUrl?: string;
  models?: string | string[]; // discovered/selected ids (array) or a comma string; control-api parses both
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

// Discover a provider's models before connecting (Story 2.4) — verifies the key + returns the model
// list without persisting anything, so the connect form can show them instead of asking you to type.
export function discoverModels(input: { provider: ProviderKind; apiKey: string; baseUrl?: string }): Promise<Result<{ models: string[] }>> {
  return req("/connections/providers/discover", {
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

// Set which of a provider's fetched models are enabled/selectable (Story 2.4).
export function setEnabledModels(id: string, enabled: string[]): Promise<Result<{ provider: Provider }>> {
  return req(`/connections/providers/${id}/models`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
}

// Re-query the provider's model catalog (Story 2.4). Needs the key (AD-10 — not stored control-api-side).
export function refreshModels(id: string, apiKey: string): Promise<Result<{ provider: Provider }>> {
  return req(`/connections/providers/${id}/refresh-models`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apiKey }),
  });
}

export interface DependentAgent {
  id: string;
  name: string;
  state: string;
}

// Agents that reference this provider (their model is "<kind>/…") — surfaced before removal (3.6).
export async function providerDependents(id: string): Promise<Result<DependentAgent[]>> {
  const r = await req<{ agents: DependentAgent[] }>(`/connections/providers/${id}/dependents`);
  return r.ok ? { ok: true, value: Array.isArray(r.value.agents) ? r.value.agents : [] } : r;
}
