// Agents client. control-api is the only writer of Agent state (AD-7); the web POSTs and
// never touches the DB. Session cookie via credentials:'include'; discriminated results so
// a control-plane outage isn't rendered as a validation error.
const base = import.meta.env.VITE_CONTROL_API_URL ?? "http://localhost:8080";

export type LifecycleState = "draft" | "active";

export interface Agent {
  id: string;
  name: string;
  state: LifecycleState;
  createdAt: string;
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

export async function listAgents(): Promise<Result<Agent[]>> {
  const r = await req<{ agents: Agent[] }>("/agents");
  return r.ok ? { ok: true, value: r.value.agents } : r;
}

export async function createAgent(name?: string): Promise<Result<Agent>> {
  const r = await req<{ agent: Agent }>("/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(name ? { name } : {}),
  });
  return r.ok ? { ok: true, value: r.value.agent } : r;
}
