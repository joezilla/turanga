// Gmail data-connection client. control-api enforces auth server-side; we send the session
// cookie (credentials:'include'). The OAuth start is a top-level navigation (cookies flow).
const base = import.meta.env.VITE_CONTROL_API_URL ?? "http://localhost:8080";

export type DataStatus = "connected" | "error" | "unconfigured";
export interface DataConnection {
  id: string;
  provider: string;
  name: string;
  accountEmail: string | null;
  scopes: string[];
  destinations: string[];
  status: DataStatus;
  lastError: string | null;
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

export async function getConfig(): Promise<Result<boolean>> {
  const r = await req<{ googleConfigured: boolean }>("/connections/config");
  return r.ok ? { ok: true, value: r.value.googleConfigured } : r;
}

export async function listData(): Promise<Result<DataConnection[]>> {
  const r = await req<{ connections: DataConnection[] }>("/connections/data");
  return r.ok ? { ok: true, value: r.value.connections } : r;
}

export function removeData(id: string): Promise<Result<{ ok: true }>> {
  return req(`/connections/data/${id}`, { method: "DELETE" });
}

export function googleStartUrl(): string {
  return `${base}/oauth/google/start`;
}
