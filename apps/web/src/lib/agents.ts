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

/** A tool attached to an agent with the operations it may call (Story 6.3). Default-deny: an empty
 *  `operations` grants nothing. The control-api validates each operation against what the tool offers. */
export interface AttachedTool {
  toolId: string;
  operations: string[];
}

export interface Money {
  minor: number; // integer minor units (e.g. cents)
  currency: string; // ISO-4217, e.g. "USD"
}
export interface CostCap {
  perRun: Money | null;
  perDay: Money | null;
}

// ── Agent memory config (Epic 8) — mirrors @turanga/domain; KEEP IN SYNC. memoryConfig is OPERATIONAL
// (not in PUBLISHED_FIELDS): editing it saves but never makes an agent "dirty" or requires a republish.
export type MemoryKind = "episodic" | "semantic" | "procedure";
export const MEMORY_KINDS: readonly MemoryKind[] = ["episodic", "semantic", "procedure"] as const;

/** Per-agent memory config. `inherit` follows the global default (which ships OFF), so a new agent is
 *  effectively memory-off until enabled. recall/reflect toggle independently. */
export interface MemoryConfig {
  mode: "inherit" | "on" | "off";
  recall: boolean;
  reflect: boolean;
  kinds: MemoryKind[];
}
export const DEFAULT_MEMORY_CONFIG: MemoryConfig = { mode: "inherit", recall: true, reflect: true, kinds: [...MEMORY_KINDS] };

/** Operator-wide memory defaults (Settings → Memory). Ships OFF. `embeddingModel`/`privacy` are
 *  read-only in the UI (the pgvector dimension is fixed; `agent-scoped` is the only privacy value). */
export interface MemoryGlobalConfig {
  defaultEnabled: boolean;
  killSwitch: boolean;
  embeddingModel: string;
  retentionDays: number | null;
  privacy: "agent-scoped";
}

/** The single rule for whether + how memory runs for an agent — mirrors the server's
 *  `effectiveMemoryConfig`. `killSwitch` wins; `inherit` follows the global default. Used only for
 *  legible UI copy here; the run path (8.3/8.4) enforces it server-side. */
export function effectiveMemoryConfig(
  global: MemoryGlobalConfig,
  perAgent: MemoryConfig,
): { enabled: boolean; recall: boolean; reflect: boolean; kinds: MemoryKind[] } {
  if (global.killSwitch) return { enabled: false, recall: false, reflect: false, kinds: [] };
  const enabled = perAgent.mode === "on" ? true : perAgent.mode === "off" ? false : global.defaultEnabled;
  return { enabled, recall: enabled && perAgent.recall, reflect: enabled && perAgent.reflect, kinds: enabled ? perAgent.kinds : [] };
}

/** The definition fields a publish snapshots — the tab dots and the dirty bar read from this. */
export const PUBLISHED_FIELDS = [
  "name",
  "description",
  "model",
  "instructions",
  "variables",
  "skills",
  "attachedTools",
  "costCap",
] as const;
export type PublishedField = (typeof PUBLISHED_FIELDS)[number];

export interface Agent {
  id: string;
  name: string;
  description: string;
  state: LifecycleState;
  model: string | null; // "provider/model-id" (Story 3.2); null until selected
  instructions: string; // Story 3.3
  variables: AgentVariable[]; // Story 3.3
  skills: AttachedSkill[]; // Story 3.4
  attachedTools: AttachedTool[]; // Story 6.3
  costCap: CostCap; // Story 3.5
  memoryConfig: MemoryConfig; // Story 8.1/8.2 — operational (NOT a PublishedField)
  publishedVersion: number | null; // null = never published
  publishedAt: string | null;
  dirty: boolean; // server-derived: the draft differs from the published snapshot
  changedFields: PublishedField[]; // server-derived: which fields differ
  createdAt: string;
}

export interface AgentVersion {
  version: number;
  publishedAt: string;
  publishedBy: string | null;
  snapshot: Record<string, unknown>;
}

export interface AgentPatch {
  name?: string;
  description?: string;
  model?: string | null;
  instructions?: string;
  variables?: AgentVariable[];
  skills?: AttachedSkill[];
  attachedTools?: AttachedTool[];
  costCap?: CostCap;
  memoryConfig?: MemoryConfig; // Story 8.2 — per-agent memory controls
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/** The Activate gate (Story 5.1) — mirrors the domain rule the control-api enforces (the server is
 *  authoritative; this is for the disabled-with-reason UX). Returns the reasons an agent can't be
 *  activated, in a stable order; `[]` means activatable. Keep in sync with @turanga/domain. */
export function activationBlockers(agent: { model: string | null; costCap: CostCap }, modelProviderConnected: boolean): string[] {
  const reasons: string[] = [];
  if (!agent.model) reasons.push("Select a model.");
  else if (!modelProviderConnected) reasons.push("The selected model's provider isn't connected — reconnect it in Settings.");
  if (!agent.costCap.perRun) reasons.push("Set a per-run cost cap.");
  if (!agent.costCap.perDay) reasons.push("Set a per-day cost cap.");
  return reasons;
}

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

/** Promote a Draft agent to Active (Story 5.1). Server-gated — a 400 returns the blocker reason. */
export async function activateAgent(id: string): Promise<Result<Agent>> {
  const r = await req<{ agent: Agent }>(`/agents/${encodeURIComponent(id)}/activate`, { method: "POST" });
  return r.ok ? { ok: true, value: r.value.agent } : r;
}

/** Return an Active agent to Draft (Story 5.1). */
export async function deactivateAgent(id: string): Promise<Result<Agent>> {
  const r = await req<{ agent: Agent }>(`/agents/${encodeURIComponent(id)}/deactivate`, { method: "POST" });
  return r.ok ? { ok: true, value: r.value.agent } : r;
}

/** Snapshot the working draft as the next version. 400 when nothing has changed. */
export async function publishAgent(id: string): Promise<Result<Agent>> {
  const r = await req<{ agent: Agent }>(`/agents/${encodeURIComponent(id)}/publish`, { method: "POST" });
  return r.ok ? { ok: true, value: r.value.agent } : r;
}

/** Publish history, newest first. */
export async function listVersions(id: string): Promise<Result<AgentVersion[]>> {
  const r = await req<{ versions?: AgentVersion[] }>(`/agents/${encodeURIComponent(id)}/versions`);
  if (!r.ok) return r;
  if (!Array.isArray(r.value.versions)) return { ok: false, error: "The control plane returned an unexpected response." };
  return { ok: true, value: r.value.versions };
}

/** Copy this definition into a new, never-published draft. */
export async function duplicateAgent(id: string): Promise<Result<Agent>> {
  const r = await req<{ agent: Agent }>(`/agents/${encodeURIComponent(id)}/duplicate`, { method: "POST" });
  return r.ok ? { ok: true, value: r.value.agent } : r;
}

/** The tab a changed field belongs to — drives the per-tab "unpublished change" dot. */
export const FIELD_TAB: Record<PublishedField, "definition" | "tools" | "skills" | "limits"> = {
  name: "definition",
  description: "definition",
  model: "definition",
  instructions: "definition",
  variables: "definition",
  attachedTools: "tools",
  skills: "skills",
  costCap: "limits",
};
