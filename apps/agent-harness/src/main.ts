// agent-harness — runs INSIDE a per-run sandbox (AD-1/AD-4). No server, no DB, no network.
// It reads the immutable job spec (JOB_SPEC env, AD-9), then over the per-run Unix-domain socket
// (E4-AD-1/E4-AD-9 — the only egress) issues logical CONNECTION reads (Story 4.3, mode a) and a
// MODEL call, emitting the single control channel as newline-delimited JSON on stdout (E4-AD-2).
// It only ever names logical ops/handles — never a URL, key, or token (AD-10). (Multi-turn loops
// and per-skill op enforcement land in Story 4.4.)
import http from "node:http";
import {
  CONTRACT_VERSION,
  JobSpecSchema,
  GuardModelResponseSchema,
  GuardConnectionResponseSchema,
  type JobSpec,
  type JobConnection,
  type ControlChannelMessage,
  type GuardModelRequest,
  type GuardModelResponse,
  type GuardConnectionRequest,
  type GuardConnectionResponse,
} from "@turanga/contracts";

export function readJobSpec(raw: unknown): JobSpec {
  return JobSpecSchema.parse(raw);
}

function emit(msg: ControlChannelMessage): void {
  process.stdout.write(JSON.stringify(msg) + "\n"); // NDJSON — the one control channel out
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString();
}

const GUARD_TIMEOUT_MS = 90_000; // never hang the sandbox on a stalled guard/gateway
const MAX_GUARD_RESPONSE = 4 * 1024 * 1024; // bound the response we buffer

// One HTTP-over-UDS round trip to the per-run guard. Returns the raw body, or an error string on a
// transport failure. The harness never sees a URL, key, or token (AD-10).
function guardTransport(socketPath: string, req: unknown): Promise<{ raw: string } | { error: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: { raw: string } | { error: string }) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    const payload = JSON.stringify(req);
    const r = http.request(
      { socketPath, path: "/", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }, timeout: GUARD_TIMEOUT_MS },
      (res) => {
        let raw = "";
        res.on("data", (c) => {
          raw += c;
          if (raw.length > MAX_GUARD_RESPONSE) {
            res.destroy();
            done({ error: "The guard response was too large." });
          }
        });
        res.on("end", () => done({ raw }));
      },
    );
    r.on("timeout", () => {
      r.destroy();
      done({ error: "The guard timed out." });
    });
    r.on("error", () => done({ error: "Can't reach the guard." }));
    r.write(payload);
    r.end();
  });
}

async function guardModelCall(socketPath: string, req: GuardModelRequest): Promise<GuardModelResponse> {
  const t = await guardTransport(socketPath, req);
  if ("error" in t) return { v: CONTRACT_VERSION, ok: false, error: t.error };
  try {
    return GuardModelResponseSchema.parse(JSON.parse(t.raw));
  } catch {
    return { v: CONTRACT_VERSION, ok: false, error: "The guard returned an unreadable response." };
  }
}

// A logical, read-only connection request over the same per-run UDS (Story 4.3, mode a). The harness
// names an op + a connection handle; the Guard holds the credential + allowlist and decides.
async function guardConnectionCall(socketPath: string, req: GuardConnectionRequest): Promise<GuardConnectionResponse> {
  const t = await guardTransport(socketPath, req);
  if ("error" in t) return { v: CONTRACT_VERSION, ok: false, error: t.error };
  try {
    return GuardConnectionResponseSchema.parse(JSON.parse(t.raw));
  } catch {
    return { v: CONTRACT_VERSION, ok: false, error: "The guard returned an unreadable response." };
  }
}

// Pure mapping of a connection response to what the harness does with it (exported for unit tests):
//  • ok      → a short read summary folded into the model context (the mode-a demonstration).
//  • refusal → an `egress` refusal control message relayed to the transcript (E4-AD-10 provenance:
//              the Guard decided it; the out-of-band Guard→orchestrator channel is Story 4.5).
//  • plain error (not a refusal) → nothing; the run proceeds to its model call.
export function readOutcome(conn: JobConnection, res: GuardConnectionResponse): { system?: string; refusal?: ControlChannelMessage } {
  if (res.ok) {
    const count = (res.data as { messageCount?: number } | undefined)?.messageCount ?? 0;
    return { system: `Connection ${conn.provider} read: ${count} message(s).` };
  }
  if (res.refusal) return { refusal: { type: "refusal", v: CONTRACT_VERSION, kind: "egress", detail: res.refusal.detail } };
  return {};
}

export async function runHarness(): Promise<void> {
  let spec: JobSpec;
  try {
    // The immutable job spec is injected at container-create as JOB_SPEC (E4-AD-2 — create-time,
    // immutable, no network side-channel). Falls back to stdin for a manual `docker run -i`.
    const raw = process.env.JOB_SPEC ?? (await readStdin());
    spec = readJobSpec(JSON.parse(raw));
  } catch {
    emit({ type: "done", v: CONTRACT_VERSION, status: "failed" });
    return;
  }

  emit({ type: "turn", v: CONTRACT_VERSION, role: "user", text: spec.taskInput });

  const messages: GuardModelRequest["messages"] = [];
  if (spec.instructions.trim()) messages.push({ role: "system", content: spec.instructions });
  messages.push({ role: "user", content: spec.taskInput });

  // The run's own subdir of the shared volume is mounted at /guard (per-run isolation, E4-AD-1).
  const socketPath = `/guard/run.sock`;

  // Story 4.3: attempt each configured connection read through the Guard (mode a). Default-deny is
  // enforced Guard-side — a read the Guard refuses becomes an `egress` refusal in the transcript; a
  // successful read is folded into the model context. The token stays Guard-side (AD-10).
  for (const conn of spec.connections) {
    const cr = await guardConnectionCall(socketPath, { v: CONTRACT_VERSION, runId: spec.runId, connectionId: conn.id, op: "gmail.list" });
    const outcome = readOutcome(conn, cr);
    if (outcome.refusal) emit(outcome.refusal);
    if (outcome.system) messages.push({ role: "system", content: outcome.system });
  }

  const res = await guardModelCall(socketPath, { v: CONTRACT_VERSION, runId: spec.runId, model: spec.model, messages });

  // latency + tokens originate at the Guard (E4-AD-10) — the harness relays them for display. The
  // Guard measures latency even for a failed call, so metrics are emitted either way (tokens is 0
  // when the call didn't complete). costMinor stays 0: cost is metered by the Guard's per-run key
  // in Story 4.5 (0 = not-yet-metered placeholder).
  emit({ type: "metrics", v: CONTRACT_VERSION, latencyMs: res.latencyMs ?? 0, tokens: res.tokens ?? 0, costMinor: 0 });

  if (res.ok) {
    emit({ type: "turn", v: CONTRACT_VERSION, role: "agent", text: res.text ?? "" });
    emit({ type: "done", v: CONTRACT_VERSION, status: "succeeded" });
  } else {
    emit({ type: "turn", v: CONTRACT_VERSION, role: "agent", text: `[model error] ${res.error ?? "unknown error"}` });
    emit({ type: "done", v: CONTRACT_VERSION, status: "failed" });
  }
}

// Run the loop only when executed as the entrypoint (not when imported by the unit test).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  runHarness().catch(() => {
    emit({ type: "done", v: CONTRACT_VERSION, status: "failed" });
    process.exit(0);
  });
}
