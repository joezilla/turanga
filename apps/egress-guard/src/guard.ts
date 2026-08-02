// The Guard's per-run egress (Epic 4). Each run gets its OWN subdirectory + Unix-domain socket
// on the shared volume (E4-AD-1) — a sandbox is mounted only its own subdir (a per-run subpath),
// so it can never see another run's socket. In Story 4.1 the socket serves only the harness↔Guard
// model-call contract (E4-AD-9) — the Guard proxies the call to LiteLLM. SEAMS marked below land
// later: allowlist + credentialed reads (4.3), per-run cost key (4.5), Filter Hook (4.6).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { GuardModelRequestSchema, type GuardModelRequest, type GuardModelResponse } from "@turanga/contracts";

export interface GuardConfig {
  socketDir: string; // shared volume dir; each run gets <socketDir>/<runId>/run.sock
  litellmBaseUrl: string;
  litellmMasterKey: string;
  fetchImpl?: typeof fetch; // injectable for tests
  modelTimeoutMs?: number;
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i; // reject anything that could escape the socket dir
const MAX_REQ_BODY = 256 * 1024; // a model request is small; cap to prevent memory-exhaustion DoS
const SOCKET_NAME = "run.sock";

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function createGuard(cfg: GuardConfig) {
  const doFetch = cfg.fetchImpl ?? fetch;
  const timeoutMs = cfg.modelTimeoutMs ?? 60_000;
  const servers = new Map<string, http.Server>();

  function runDir(runId: string): string {
    if (!ULID_RE.test(runId)) throw new Error("Invalid runId.");
    return path.join(cfg.socketDir, runId);
  }

  // Proxy a model call to LiteLLM. Story 4.5 swaps the master key for the per-run cost key + adds
  // kill-on-429; 4.6 runs the Filter Hook on the body first.
  async function proxyModel(req: GuardModelRequest): Promise<GuardModelResponse> {
    const started = Date.now();
    try {
      const r = await doFetch(`${cfg.litellmBaseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${cfg.litellmMasterKey}` },
        body: JSON.stringify({ model: req.model, messages: req.messages }),
        signal: AbortSignal.timeout(timeoutMs), // never let a stalled gateway hang the run
      });
      const latencyMs = Date.now() - started;
      const body = (await r.json().catch(() => ({}))) as {
        choices?: { message?: { content?: string } }[];
        usage?: { total_tokens?: number };
        error?: { message?: string };
      };
      if (!r.ok) return { v: 1, ok: false, error: body?.error?.message ?? `The model gateway rejected the call (HTTP ${r.status}).`, latencyMs };
      return { v: 1, ok: true, text: body?.choices?.[0]?.message?.content ?? "", tokens: body?.usage?.total_tokens, latencyMs };
    } catch (e) {
      const timedOut = e instanceof Error && e.name === "TimeoutError";
      return { v: 1, ok: false, error: timedOut ? "The model gateway timed out." : "Can't reach the model gateway.", latencyMs: Date.now() - started };
    }
  }

  return {
    proxyModel, // exported for unit tests
    async register(runId: string): Promise<{ socketPath: string }> {
      const dir = runDir(runId);
      if (servers.has(runId)) await this.teardown(runId); // a re-register must not leak the old server
      fs.mkdirSync(dir, { recursive: true });
      const socketPath = path.join(dir, SOCKET_NAME);
      try {
        fs.unlinkSync(socketPath);
      } catch {
        /* not present — fine */
      }
      const server = http.createServer((httpReq, httpRes) => {
        let raw = "";
        let aborted = false;
        httpReq.on("data", (c) => {
          if (aborted) return;
          raw += c;
          if (raw.length > MAX_REQ_BODY) {
            aborted = true;
            httpRes.writeHead(413, { "content-type": "application/json" });
            httpRes.end(JSON.stringify({ v: 1, ok: false, error: "Model request too large." }));
            httpReq.destroy();
          }
        });
        httpReq.on("end", async () => {
          if (aborted) return;
          const parsed = GuardModelRequestSchema.safeParse(safeJson(raw));
          const out: GuardModelResponse = parsed.success ? await proxyModel(parsed.data) : { v: 1, ok: false, error: "Malformed model request." };
          httpRes.writeHead(parsed.success ? 200 : 400, { "content-type": "application/json" });
          httpRes.end(JSON.stringify(out));
        });
      });
      // A per-run socket error must not crash the shared guard process (blast radius = all runs).
      server.on("error", (e) => console.error(`[egress-guard] run ${runId} socket error:`, e instanceof Error ? e.message : e));
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      servers.set(runId, server);
      return { socketPath };
    },
    async teardown(runId: string): Promise<void> {
      if (!ULID_RE.test(runId)) return; // never touch the FS for a bad id
      const server = servers.get(runId);
      if (server) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        servers.delete(runId);
      }
      try {
        fs.rmSync(path.join(cfg.socketDir, runId), { recursive: true, force: true });
      } catch {
        /* already gone */
      }
    },
    activeRuns(): string[] {
      return [...servers.keys()];
    },
  };
}

export type Guard = ReturnType<typeof createGuard>;
