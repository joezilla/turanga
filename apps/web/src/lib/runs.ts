// Runs client (Epic 4, Story 4.2). control-api is the only writer of Run state (AD-7): the web
// POSTs to start a run and then watches it live over SSE. Mirrors the control-channel message
// shapes from @turanga/contracts (kept local so the web has no server dep). Same base +
// credentials pattern as $lib/agents.
const base = import.meta.env.VITE_CONTROL_API_URL ?? "http://localhost:8080";

export type RunStatus = "created" | "running" | "succeeded" | "failed" | "killed";

// One control-channel message — the discriminated union the harness/Guard emit (E4-AD-9/10).
export type RunMessage =
  | { type: "turn"; v: 2; role: "user" | "agent"; text: string }
  | { type: "metrics"; v: 2; latencyMs: number; tokens: number; costMinor: number }
  | { type: "refusal"; v: 2; kind: "egress" | "permission"; detail: string }
  | { type: "done"; v: 2; status: "succeeded" | "failed" | "killed" };

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
