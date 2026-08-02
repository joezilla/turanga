// The Guard's per-run egress (Epic 4). Each run gets its OWN Unix-domain socket on the shared
// volume (E4-AD-1); the sandbox's only way out is that socket. In Story 4.1 the socket serves
// only the harness↔Guard model-call contract (E4-AD-9) — the Guard proxies the call to LiteLLM.
// SEAMS marked below land in later stories: the allowlist + credentialed-connection reads (4.3),
// the per-run cost key (4.5), and the Filter Hook (4.6). The harness never sees a URL/key/token.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { GuardModelRequestSchema, type GuardModelRequest, type GuardModelResponse } from "@turanga/contracts";

export interface GuardConfig {
  socketDir: string; // shared volume dir holding <runId>.sock
  litellmBaseUrl: string;
  litellmMasterKey: string;
  fetchImpl?: typeof fetch; // injectable for tests
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function createGuard(cfg: GuardConfig) {
  const doFetch = cfg.fetchImpl ?? fetch;
  const servers = new Map<string, http.Server>();

  // Proxy a model call to LiteLLM. Story 4.5 swaps the master key for the per-run cost key and
  // adds kill-on-429; 4.6 runs the Filter Hook on the body first.
  async function proxyModel(req: GuardModelRequest): Promise<GuardModelResponse> {
    const started = Date.now();
    try {
      const r = await doFetch(`${cfg.litellmBaseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${cfg.litellmMasterKey}` },
        body: JSON.stringify({ model: req.model, messages: req.messages }),
      });
      const latencyMs = Date.now() - started;
      const body = (await r.json().catch(() => ({}))) as {
        choices?: { message?: { content?: string } }[];
        usage?: { total_tokens?: number };
        error?: { message?: string };
      };
      if (!r.ok) return { v: 1, ok: false, error: body?.error?.message ?? `The model gateway rejected the call (HTTP ${r.status}).`, latencyMs };
      return { v: 1, ok: true, text: body?.choices?.[0]?.message?.content ?? "", tokens: body?.usage?.total_tokens, latencyMs };
    } catch {
      return { v: 1, ok: false, error: "Can't reach the model gateway.", latencyMs: Date.now() - started };
    }
  }

  function socketPathFor(runId: string): string {
    return path.join(cfg.socketDir, `${runId}.sock`);
  }

  return {
    proxyModel, // exported for unit tests
    async register(runId: string): Promise<{ socketPath: string }> {
      const socketPath = socketPathFor(runId);
      try {
        fs.unlinkSync(socketPath);
      } catch {
        /* not present — fine */
      }
      const server = http.createServer((httpReq, httpRes) => {
        let raw = "";
        httpReq.on("data", (c) => (raw += c));
        httpReq.on("end", async () => {
          const parsed = GuardModelRequestSchema.safeParse(safeJson(raw));
          const out: GuardModelResponse = parsed.success
            ? await proxyModel(parsed.data)
            : { v: 1, ok: false, error: "Malformed model request." };
          httpRes.writeHead(parsed.success ? 200 : 400, { "content-type": "application/json" });
          httpRes.end(JSON.stringify(out));
        });
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      servers.set(runId, server);
      return { socketPath };
    },
    async teardown(runId: string): Promise<void> {
      const server = servers.get(runId);
      if (server) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        servers.delete(runId);
      }
      try {
        fs.unlinkSync(socketPathFor(runId));
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
