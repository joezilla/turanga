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
  ToolCallResponseSchema,
  SKILL_OPS,
  OP_REQUIREMENTS,
  type JobSpec,
  type ConnectionOp,
  type ControlChannelMessage,
  type GuardModelRequest,
  type GuardModelResponse,
  type GuardConnectionRequest,
  type GuardConnectionResponse,
  type ToolCallRequest,
  type ToolCallResponse,
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

// Pure mapping of a connection op's response to what the harness does with it (exported for tests):
//  • ok      → a short summary folded into the model context (the mode-a demonstration).
//  • refusal → a `refusal` control message carrying the GUARD's kind (egress or permission — the
//              Guard decided it; E4-AD-10 provenance; the out-of-band channel is Story 4.5).
//  • plain error (not a refusal) → nothing; the run proceeds.
export function opOutcome(op: ConnectionOp, res: GuardConnectionResponse): { system?: string; refusal?: ControlChannelMessage } {
  if (res.ok) {
    const count = (res.data as { messageCount?: number } | undefined)?.messageCount;
    return { system: count === undefined ? `Ran ${op}.` : `Read ${count} message(s).` };
  }
  if (res.refusal) return { refusal: { type: "refusal", v: CONTRACT_VERSION, kind: res.refusal.kind, detail: res.refusal.detail } };
  return {};
}

// A logical tool call over the same per-run UDS (Story 6.4). The harness names a LOGICAL tool +
// operation + arguments; the Guard resolves the endpoint, enforces the per-op grant, attaches the held
// credential, performs the MCP `tools/call`, and returns the result — the harness never sees the URL
// or the token (AD-10).
async function guardToolCall(socketPath: string, req: ToolCallRequest): Promise<ToolCallResponse> {
  const t = await guardTransport(socketPath, req);
  if ("error" in t) return { v: CONTRACT_VERSION, ok: false, error: t.error };
  try {
    return ToolCallResponseSchema.parse(JSON.parse(t.raw));
  } catch {
    return { v: CONTRACT_VERSION, ok: false, error: "The guard returned an unreadable response." };
  }
}

// Pure mapping of a tool call's response to a RECORDED observability event (Story 6.5) — exported for
// tests. EVERY tool call emits a structured `tool` control message (count/latency/outcome/refusals),
// so a successful call is no longer invisible. Observed only: the message carries no cost (AC2).
//  • ok (success)              → outcome "ok"    + a context note for the model.
//  • ok but isError            → outcome "error" (the tool's OWN execution error) + a context note.
//  • refusal (Guard denial)    → outcome "refused" + the detail; no context note (a blocked call isn't context).
//  • transport / plain error   → outcome "error" + the detail.
// A refused/errored tool call is NOT a run failure (same posture as a blocked send).
export function toolRecord(toolId: string, toolName: string, operation: string, res: ToolCallResponse): { message: ControlChannelMessage; system?: string } {
  const latencyMs = res.latencyMs ?? 0;
  const base = { type: "tool" as const, v: CONTRACT_VERSION, toolId, toolName, operation, latencyMs };
  if (res.ok && !res.isError) return { message: { ...base, outcome: "ok" }, system: `Called ${operation}.` };
  if (res.ok && res.isError) return { message: { ...base, outcome: "error", detail: "the tool reported an error" }, system: `Called ${operation} (the tool reported an error).` };
  if (res.refusal) return { message: { ...base, outcome: "refused", detail: res.refusal.detail } };
  return { message: { ...base, outcome: "error", detail: res.error } };
}

/** The ops a run should attempt, derived from its attached skills (provider-agnostic, SM-4). */
function opsForSkills(skills: string[]): ConnectionOp[] {
  const ops = new Set<ConnectionOp>();
  for (const s of skills) for (const op of SKILL_OPS[s] ?? []) ops.add(op);
  return [...ops];
}
const isReadOp = (op: ConnectionOp) => OP_REQUIREMENTS[op].requiredScope === "read";

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

  // Story 4.4: deterministic skill execution through the generic Connection interface. Each attached
  // skill maps to provider-agnostic ops (SKILL_OPS); the Guard enforces the permission scope + send
  // gate and the allowlist, refusing (permission or egress) what isn't allowed. Ops run in phases so
  // the draft-reply flow reads → drafts (the model turn) → attempts send. All ops target the run's
  // Gmail connection handle; with no handle, there's nothing to run against.
  const gmailConn = spec.connections.find((c) => c.provider === "gmail");
  const ops = gmailConn ? opsForSkills(spec.skills) : [];
  async function runOp(op: ConnectionOp) {
    const cr = await guardConnectionCall(socketPath, { v: CONTRACT_VERSION, runId: spec.runId, connectionId: gmailConn!.id, op });
    const outcome = opOutcome(op, cr);
    if (outcome.refusal) emit(outcome.refusal);
    if (outcome.system) messages.push({ role: "system", content: outcome.system });
  }

  // Phase 1 — read ops gather context for the model.
  for (const op of ops.filter(isReadOp)) await runOp(op);

  // Phase 1b — tool calls (Story 6.4). Deterministic stub: for each granted tool, invoke its FIRST
  // granted operation through the Guard (a real model-driven tool loop is a later concern). The Guard
  // enforces the per-op grant + attaches the held credential; a refusal is relayed (recorded on the
  // Run), a success folds a note into context. A blocked/errored tool call is NOT a run failure.
  for (const tool of spec.tools) {
    const operation = tool.operations[0];
    if (!operation) continue; // an attached-but-ungranted tool has nothing to call
    const tr = await guardToolCall(socketPath, { v: CONTRACT_VERSION, runId: spec.runId, toolId: tool.id, operation, arguments: {} });
    const rec = toolRecord(tool.id, tool.name, operation, tr);
    emit(rec.message); // a RECORDED tool event for EVERY call (Story 6.5) — success is no longer invisible
    if (rec.system) messages.push({ role: "system", content: rec.system });
  }

  // Phase 2 — the model call → the agent turn (the response / the draft artifact for draft-reply).
  const res = await guardModelCall(socketPath, { v: CONTRACT_VERSION, runId: spec.runId, model: spec.model, messages });

  // The harness emits ONLY turn + done + relayed refusals (E4-AD-10). Cost/tokens `metrics` are the
  // Guard's out-of-band truth (Story 4.5) — reported Guard→orchestrator, not through this sandbox.
  emit({ type: "turn", v: CONTRACT_VERSION, role: "agent", text: res.ok ? (res.text ?? "") : `[model error] ${res.error ?? "unknown error"}` });

  // Phase 3 — outbound/write ops (label, send). A blocked send is a refusal, NOT a run failure — the
  // draft (Phase 2) stands and the run completes (AC3, AD-8).
  for (const op of ops.filter((op) => !isReadOp(op))) await runOp(op);

  emit({ type: "done", v: CONTRACT_VERSION, status: res.ok ? "succeeded" : "failed" });
}

// Run the loop only when executed as the entrypoint (not when imported by the unit test).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  runHarness().catch(() => {
    emit({ type: "done", v: CONTRACT_VERSION, status: "failed" });
    process.exit(0);
  });
}
