// Memory config client (Epic 8, Story 8.2). control-api is the only writer of memory config (AD-7);
// the web reads + PATCHes the operator's global defaults and can purge an agent's memories. Same base
// + credentials + Result pattern as $lib/tools. Per-agent memory config rides on the Agent (PATCH
// /agents), not here — this client owns the GLOBAL config + the purge only.
import type { MemoryGlobalConfig, MemoryKind, MemoryStatus, MemoryEventKind } from "$lib/agents";

const base = import.meta.env.VITE_CONTROL_API_URL ?? "http://localhost:8080";

export type { MemoryGlobalConfig, MemoryStatus, MemoryEventKind };

/** A memory as the observability surface shows it (Story 8.5/8.6) — the server view(), no embedding. */
export interface MemoryView {
  id: string;
  kind: MemoryKind;
  content: string;
  summary: string;
  topic: string | null;
  salience: number;
  pinned: boolean;
  status: MemoryStatus; // Story 8.6 — active | pending | quarantined
  useCount: number;
  lastUsedAt: string | null;
  sourceRunId: string | null;
  validFrom: string;
  validUntil: string | null; // in the past ⇒ superseded
  createdAt: string;
}

/** A learning-changelog event (Story 8.6). */
export interface MemoryEvent {
  id: string;
  memoryId: string | null;
  kind: MemoryEventKind;
  summary: string;
  sourceRunId: string | null;
  at: string;
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

export function getMemoryConfig(): Promise<Result<MemoryGlobalConfig>> {
  return req<MemoryGlobalConfig>("/memory/config");
}

// A partial patch — only the sent keys change; the server upserts + returns the merged config.
export function setMemoryConfig(patch: Partial<MemoryGlobalConfig>): Promise<Result<MemoryGlobalConfig>> {
  return req<MemoryGlobalConfig>("/memory/config", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
}

// Opt-in, agent-scoped purge (destructive — confirm in the UI first). Removes ONLY this agent's memories.
export function purgeAgentMemory(agentId: string): Promise<Result<{ purged: number }>> {
  return req(`/memory/agents/${encodeURIComponent(agentId)}`, { method: "DELETE" });
}

// ── Observability + curation (Story 8.5) — agent-scoped; control-api is the sole writer (AD-7). ──
const mid = (agentId: string, id: string) => `/memory/agents/${encodeURIComponent(agentId)}/${encodeURIComponent(id)}`;

export async function listAgentMemories(agentId: string): Promise<Result<MemoryView[]>> {
  const r = await req<{ memories?: MemoryView[] }>(`/memory/agents/${encodeURIComponent(agentId)}`);
  if (!r.ok) return r;
  if (!Array.isArray(r.value.memories)) return { ok: false, error: "The control plane returned an unexpected response." };
  return { ok: true, value: r.value.memories };
}

/** Edit content/summary/pinned. Editing content re-embeds server-side so recall stays accurate. */
export function editMemory(agentId: string, id: string, patch: { content?: string; summary?: string; pinned?: boolean }): Promise<Result<{ memory: MemoryView }>> {
  return req(mid(agentId, id), { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
}

export function setMemoryPinned(agentId: string, id: string, pinned: boolean): Promise<Result<{ memory: MemoryView }>> {
  return editMemory(agentId, id, { pinned });
}

/** Forget ONE memory (distinct from the bulk purge). Forgetting a PENDING memory is a reject. */
export function forgetMemory(agentId: string, id: string): Promise<Result<{ ok: true }>> {
  return req(mid(agentId, id), { method: "DELETE" });
}

// ── Oversight (Story 8.6) — staged approval + quarantine + the changelog. ──
export function acceptMemory(agentId: string, id: string): Promise<Result<{ memory: MemoryView }>> {
  return req(`${mid(agentId, id)}/accept`, { method: "POST" });
}
/** Reject a pending memory = delete it (logged as 'rejected' server-side). */
export function rejectMemory(agentId: string, id: string): Promise<Result<{ ok: true }>> {
  return forgetMemory(agentId, id);
}
export function quarantineMemory(agentId: string, id: string): Promise<Result<{ memory: MemoryView }>> {
  return req(`${mid(agentId, id)}/quarantine`, { method: "POST" });
}
export function unquarantineMemory(agentId: string, id: string): Promise<Result<{ memory: MemoryView }>> {
  return req(`${mid(agentId, id)}/unquarantine`, { method: "POST" });
}
export async function listMemoryChangelog(agentId: string): Promise<Result<MemoryEvent[]>> {
  const r = await req<{ events?: MemoryEvent[] }>(`/memory/agents/${encodeURIComponent(agentId)}/events`);
  if (!r.ok) return r;
  if (!Array.isArray(r.value.events)) return { ok: false, error: "The control plane returned an unexpected response." };
  return { ok: true, value: r.value.events };
}
