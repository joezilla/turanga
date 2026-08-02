// agent-harness — runs INSIDE a per-run sandbox (AD-1/AD-4). No server, no DB, no network.
// It reads the immutable job spec on stdin (AD-9), makes ONE model call through the Guard over
// the per-run Unix-domain socket (E4-AD-1/E4-AD-9 — the only egress), and emits the single
// control channel as newline-delimited JSON on stdout (E4-AD-2). Story 4.1: the bare loop.
// (Multi-turn loops, skills, and connection reads land in Stories 4.3/4.4.)
import http from "node:http";
import {
  JobSpecSchema,
  GuardModelResponseSchema,
  type JobSpec,
  type ControlChannelMessage,
  type GuardModelRequest,
  type GuardModelResponse,
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

// HTTP over the per-run guard UDS. The harness never sees a URL, key, or token (AD-10).
function guardModelCall(socketPath: string, req: GuardModelRequest): Promise<GuardModelResponse> {
  return new Promise((resolve) => {
    const payload = JSON.stringify(req);
    const r = http.request(
      { socketPath, path: "/", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try {
            resolve(GuardModelResponseSchema.parse(JSON.parse(raw)));
          } catch {
            resolve({ v: 1, ok: false, error: "The guard returned an unreadable response." });
          }
        });
      },
    );
    r.on("error", () => resolve({ v: 1, ok: false, error: "Can't reach the guard." }));
    r.write(payload);
    r.end();
  });
}

export async function runHarness(): Promise<void> {
  let spec: JobSpec;
  try {
    // The immutable job spec is injected at container-create as JOB_SPEC (E4-AD-2 — create-time,
    // immutable, no network side-channel). Falls back to stdin for a manual `docker run -i`.
    const raw = process.env.JOB_SPEC ?? (await readStdin());
    spec = readJobSpec(JSON.parse(raw));
  } catch {
    emit({ type: "done", v: 1, status: "failed" });
    return;
  }

  emit({ type: "turn", v: 1, role: "user", text: spec.taskInput });

  const messages: GuardModelRequest["messages"] = [];
  if (spec.instructions.trim()) messages.push({ role: "system", content: spec.instructions });
  messages.push({ role: "user", content: spec.taskInput });

  const socketPath = `/guard/${spec.runId}.sock`;
  const res = await guardModelCall(socketPath, { v: 1, runId: spec.runId, model: spec.model, messages });

  if (res.ok) {
    emit({ type: "turn", v: 1, role: "agent", text: res.text ?? "" });
    emit({ type: "done", v: 1, status: "succeeded" });
  } else {
    emit({ type: "turn", v: 1, role: "agent", text: `[model error] ${res.error ?? "unknown error"}` });
    emit({ type: "done", v: 1, status: "failed" });
  }
}

// Run the loop only when executed as the entrypoint (not when imported by the unit test).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  runHarness().catch(() => {
    emit({ type: "done", v: 1, status: "failed" });
    process.exit(0);
  });
}
