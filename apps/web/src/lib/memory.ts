// Memory config client (Epic 8, Story 8.2). control-api is the only writer of memory config (AD-7);
// the web reads + PATCHes the operator's global defaults and can purge an agent's memories. Same base
// + credentials + Result pattern as $lib/tools. Per-agent memory config rides on the Agent (PATCH
// /agents), not here — this client owns the GLOBAL config + the purge only.
import type { MemoryGlobalConfig } from "$lib/agents";

const base = import.meta.env.VITE_CONTROL_API_URL ?? "http://localhost:8080";

export type { MemoryGlobalConfig };

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
