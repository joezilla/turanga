// Runs client (Epic 4, Story 4.2). control-api is the only writer of Run state (AD-7): the web
// POSTs to start a run and then watches it live over SSE. Mirrors the control-channel message
// shapes from @turanga/contracts (kept local so the web has no server dep). Same base +
// credentials pattern as $lib/agents.
const base = import.meta.env.VITE_CONTROL_API_URL ?? "http://localhost:8080";

export type RunStatus = "created" | "running" | "succeeded" | "failed" | "killed";

// One control-channel message — the discriminated union the harness/Guard emit (E4-AD-9/10).
// Mirrors @turanga/contracts CONTRACT_VERSION (currently 10). Kept local so the web has no server dep.
export type RunMessage =
  | { type: "turn"; v: 10; role: "user" | "agent"; text: string }
  | { type: "metrics"; v: 10; latencyMs: number; tokens: number; costMicros: number }
  | { type: "refusal"; v: 10; kind: "egress" | "permission"; detail: string }
  | { type: "tool"; v: 10; toolId: string; toolName: string; operation: string; outcome: "ok" | "error" | "refused"; latencyMs: number; detail?: string } // Story 6.5
  | { type: "recall"; v: 10; memoryIds: string[]; count: number } // Story 8.3 — orchestrator-authored recall event
  | { type: "done"; v: 10; status: "succeeded" | "failed" | "killed"; reason?: string }; // Story 12.6 — stop reason

/** Per-tool invocation statistics for an agent (Story 6.5) — observed only, no cost. Mirrors the
 *  control-api ToolStat. */
export interface ToolStat {
  toolId: string;
  toolName: string;
  invocations: number;
  ok: number;
  errors: number;
  refusals: number;
  avgLatencyMs: number;
  lastUsedAt: string | null;
}

export interface Run {
  id: string;
  agentId: string;
  status: RunStatus;
  taskInput: string;
  transcript: RunMessage[];
  reason: string | null;
  costMicros: number; // persisted run-cost summary in micro-USD (Story 4.5); shown in run history (5.3)
  createdAt: string;
  endedAt: string | null;
}

/** A run without its transcript — the run-history list row (Story 5.3). The review view fetches the
 *  full Run (with transcript) via getRun. */
export type RunSummary = Omit<Run, "transcript">;

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/** Start a run (async on the server: returns the created/running run immediately; watch its
 *  events for the live transcript). */
export async function startRun(agentId: string, taskInput: string): Promise<Result<Run>> {
  try {
    const r = await fetch(`${base}/runs`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId, taskInput }),
    });
    if (r.ok) {
      const body = (await r.json().catch(() => ({}))) as { run?: Run };
      if (!body.run) return { ok: false, error: "The control plane returned an unexpected response." };
      return { ok: true, value: body.run };
    }
    const body = (await r.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: body.error ?? `Couldn't start the run (${r.status}).` };
  } catch {
    return { ok: false, error: "Can't reach the control plane." };
  }
}

/** The SSE endpoint for a run's live control-channel messages (open with EventSource). */
export function runEventsUrl(id: string): string {
  return `${base}/runs/${encodeURIComponent(id)}/events`;
}

/** The agent's cumulative spend today in micro-USD (the daily meter; Story 4.5). Best-effort — a
 *  read failure just leaves the daily line blank. */
export async function getAgentCost(agentId: string): Promise<{ todayMicros: number } | null> {
  try {
    const r = await fetch(`${base}/agents/${encodeURIComponent(agentId)}/cost`, { credentials: "include" });
    if (!r.ok) return null;
    return (await r.json()) as { todayMicros: number };
  } catch {
    return null;
  }
}

/** The agent's per-tool invocation stats (Story 6.5) — count/latency/outcome/refusals from its runs'
 *  recorded tool calls. Best-effort — a read failure returns [] so the Tools section still renders. */
export async function getAgentToolStats(agentId: string): Promise<ToolStat[]> {
  try {
    const r = await fetch(`${base}/agents/${encodeURIComponent(agentId)}/tool-stats`, { credentials: "include" });
    if (!r.ok) return [];
    const body = (await r.json()) as { stats?: ToolStat[] };
    return Array.isArray(body.stats) ? body.stats : [];
  } catch {
    return [];
  }
}

/** Every agent's cumulative spend today in micro-USD, keyed by agent id (the agents-list daily meter,
 *  Story 5.2). Best-effort — a read failure returns `{}` so the list never white-screens; an agent
 *  absent from the map has no spend today (render 0). Same UTC-midnight window as `getAgentCost`. */
export async function getAgentsCost(): Promise<Record<string, number>> {
  try {
    const r = await fetch(`${base}/agents/cost`, { credentials: "include" });
    if (!r.ok) return {};
    const body = (await r.json()) as { costs?: Record<string, number> };
    return body.costs ?? {};
  } catch {
    return {};
  }
}

/** An agent's past runs, newest-first (run history, Story 5.3). Discriminated so the history page can
 *  tell an outage (`ok:false` → a retryable error) from a genuinely empty history (`ok:true, value:[]`)
 *  — silently showing "No runs yet." during a backend failure would be a false negative on an
 *  observability surface. */
export async function listRuns(agentId: string): Promise<Result<RunSummary[]>> {
  try {
    const r = await fetch(`${base}/runs?agentId=${encodeURIComponent(agentId)}`, { credentials: "include" });
    if (!r.ok) return { ok: false, error: `Couldn't load runs (${r.status}).` };
    const body = (await r.json()) as { runs?: RunSummary[] };
    return { ok: true, value: Array.isArray(body.runs) ? body.runs : [] };
  } catch {
    return { ok: false, error: "Can't reach the control plane." };
  }
}

/** Fetch a run's full record (transcript + reason + cost). Discriminated so the review page can tell a
 *  genuine 404 (`ok:true, value:null` → "That run doesn't exist.") from an outage (`ok:false` → a
 *  retryable error) — the two must not both read as "doesn't exist." */
export async function getRun(id: string): Promise<Result<Run | null>> {
  try {
    const r = await fetch(`${base}/runs/${encodeURIComponent(id)}`, { credentials: "include" });
    if (r.status === 404) return { ok: true, value: null };
    if (!r.ok) return { ok: false, error: `Couldn't load the run (${r.status}).` };
    const body = (await r.json()) as { run?: Run };
    return { ok: true, value: body.run ?? null };
  } catch {
    return { ok: false, error: "Can't reach the control plane." };
  }
}

/** The legible cause line for a run's outcome (Story 5.3 AC2). Killed/failed always yield a cause —
 *  the persisted `reason` when present, else an honest fallback (a harness `done:failed` persists no
 *  reason, so the "error" case must never render blank). `null` for non-terminal/succeeded runs. */
export function runCause(status: RunStatus, reason: string | null): string | null {
  if (status !== "killed" && status !== "failed") return null;
  if (reason) return reason;
  return status === "failed" ? "The run failed — no cause was recorded. See the transcript." : "The run was killed.";
}
