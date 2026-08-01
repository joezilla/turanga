// Agents client. control-api is the only writer of Agent state (AD-7); the web POSTs and
// never touches the DB. Session cookie via credentials:'include'; discriminated results so
// a control-plane outage isn't rendered as a validation error.
const base = import.meta.env.VITE_CONTROL_API_URL ?? "http://localhost:8080";

export type LifecycleState = "draft" | "active";

export interface AgentVariable {
  name: string;
  value: string;
}

export type SkillId = "read-search" | "draft-reply" | "flag-label" | "summarize";
export type SkillScope = "none" | "read" | "read-write";
export interface AttachedSkill {
  skill: SkillId;
  scope: SkillScope;
  send: boolean;
}

export interface Money {
  minor: number; // integer minor units (e.g. cents)
  currency: string; // ISO-4217, e.g. "USD"
}
export interface CostCap {
  perRun: Money | null;
  perDay: Money | null;
}

export interface Agent {
  id: string;
  name: string;
  state: LifecycleState;
  model: string | null; // "provider/model-id" (Story 3.2); null until selected
  instructions: string; // Story 3.3
  variables: AgentVariable[]; // Story 3.3
  skills: AttachedSkill[]; // Story 3.4
  costCap: CostCap; // Story 3.5
  createdAt: string;
}

export interface AgentPatch {
  name?: string;
  model?: string | null;
  instructions?: string;
  variables?: AgentVariable[];
  skills?: AttachedSkill[];
  costCap?: CostCap;
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
  const r = await req<{ agents?: Agent[] }>("/agents");
  if (!r.ok) return r;
  // A 200 with a malformed/empty body must not white-screen the list.
  if (!Array.isArray(r.value.agents)) return { ok: false, error: "The control plane returned an unexpected response." };
  return { ok: true, value: r.value.agents };
}

export async function createAgent(name?: string): Promise<Result<Agent>> {
  const r = await req<{ agent: Agent }>("/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(name ? { name } : {}),
  });
  return r.ok ? { ok: true, value: r.value.agent } : r;
}

export async function getAgent(id: string): Promise<Result<Agent>> {
  const r = await req<{ agent: Agent }>(`/agents/${encodeURIComponent(id)}`);
  return r.ok ? { ok: true, value: r.value.agent } : r;
}

export async function updateAgent(id: string, patch: AgentPatch): Promise<Result<Agent>> {
  const r = await req<{ agent: Agent }>(`/agents/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  return r.ok ? { ok: true, value: r.value.agent } : r;
}
