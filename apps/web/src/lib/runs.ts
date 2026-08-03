// Runs client (Epic 4, Story 4.2). control-api is the only writer of Run state (AD-7): the web
// POSTs to start a run and then watches it live over SSE. Mirrors the control-channel message
// shapes from @turanga/contracts (kept local so the web has no server dep). Same base +
// credentials pattern as $lib/agents.
const base = import.meta.env.VITE_CONTROL_API_URL ?? "http://localhost:8080";

export type RunStatus = "created" | "running" | "succeeded" | "failed" | "killed";

// One control-channel message — the discriminated union the harness/Guard emit (E4-AD-9/10).
export type RunMessage =
  | { type: "turn"; v: 4; role: "user" | "agent"; text: string }
  | { type: "metrics"; v: 4; latencyMs: number; tokens: number; costMicros: number }
  | { type: "refusal"; v: 4; kind: "egress" | "permission"; detail: string }
  | { type: "done"; v: 4; status: "succeeded" | "failed" | "killed" };

export interface Run {
  id: string;
  agentId: string;
  status: RunStatus;
  taskInput: string;
  transcript: RunMessage[];
  reason: string | null;
  createdAt: string;
  endedAt: string | null;
}

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

/** Fetch a run (for its persisted reason + cost summary after it resolves). Best-effort. */
export async function getRun(id: string): Promise<Run | null> {
  try {
    const r = await fetch(`${base}/runs/${encodeURIComponent(id)}`, { credentials: "include" });
    if (!r.ok) return null;
    return ((await r.json()) as { run: Run }).run;
  } catch {
    return null;
  }
}
