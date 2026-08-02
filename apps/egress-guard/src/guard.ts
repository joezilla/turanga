// The Guard's per-run egress (Epic 4). Each run gets its OWN subdirectory + Unix-domain socket
// on the shared volume (E4-AD-1) — a sandbox is mounted only its own subdir (a per-run subpath),
// so it can never see another run's socket. The socket serves the harness↔Guard logical-request
// contract (E4-AD-9): a MODEL call (proxied to LiteLLM) or a CONNECTION read (mode a, AD-5 — the
// Guard terminates TLS, attaches the HELD credential, forwards; the agent never holds the token).
// Egress is DEFAULT-DENY against the run's allowlist (FR-8/NFR-2) — any error/misconfig refuses.
// SEAMS still ahead: per-run cost key (4.5), real Filter Hook content-scanning (4.6 — the no-op
// interface is wired here). Plain CONNECT egress (mode b) is deferred.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import {
  CONTRACT_VERSION,
  GuardModelRequestSchema,
  GuardConnectionRequestSchema,
  type GuardModelRequest,
  type GuardModelResponse,
  type GuardConnectionRequest,
  type GuardConnectionResponse,
} from "@turanga/contracts";

/** A credential the Guard holds for the life of a run (AD-10) — never crosses the UDS to the
 *  sandbox, never persisted. `accessToken` is a short-lived token minted by control-api. */
export interface ProvisionConnection {
  connectionId: string;
  provider: "gmail";
  destinations: string[];
  accessToken: string;
}
export interface RunProvision {
  connections: ProvisionConnection[];
}

/** The Filter Hook (E4-AD-6): a synchronous inspection point invoked before a credentialed
 *  forward. A no-op hook is registered by default and MUST NOT alter behavior; the real
 *  content-scanning hook lands in Story 4.6. */
export type FilterHook = (direction: "egress", meta: { destination: string; op: string }) => { allow: true } | { allow: false; reason: string };
const NOOP_HOOK: FilterHook = () => ({ allow: true });

export interface GuardConfig {
  socketDir: string; // shared volume dir; each run gets <socketDir>/<runId>/run.sock
  litellmBaseUrl: string;
  litellmMasterKey: string;
  fetchImpl?: typeof fetch; // injectable for tests (model + connection forwards)
  modelTimeoutMs?: number;
  connectionTimeoutMs?: number;
  filterHook?: FilterHook; // defaults to the no-op (4.6 swaps in the real one)
}

interface RunState {
  server: http.Server;
  allowlist: Set<string>; // union of the run's Connections' declared destinations (default-deny)
  credentials: Map<string, ProvisionConnection>; // by connectionId — the held tokens (AD-10)
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i; // reject anything that could escape the socket dir
const MAX_REQ_BODY = 256 * 1024; // a request is small; cap to prevent memory-exhaustion DoS
const SOCKET_NAME = "run.sock";

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// The destination a logical op resolves to. The allowlist is checked against this — the harness
// never names a host, so it can't reach one the op doesn't map to.
function destinationForOp(op: GuardConnectionRequest["op"]): string {
  switch (op) {
    case "gmail.list":
      return "gmail.googleapis.com";
  }
}

export function createGuard(cfg: GuardConfig) {
  const doFetch = cfg.fetchImpl ?? fetch;
  const modelTimeoutMs = cfg.modelTimeoutMs ?? 60_000;
  const connectionTimeoutMs = cfg.connectionTimeoutMs ?? 30_000;
  const filterHook = cfg.filterHook ?? NOOP_HOOK;
  const runs = new Map<string, RunState>();

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
        signal: AbortSignal.timeout(modelTimeoutMs), // never let a stalled gateway hang the run
      });
      const latencyMs = Date.now() - started;
      const body = (await r.json().catch(() => ({}))) as {
        choices?: { message?: { content?: string } }[];
        usage?: { total_tokens?: number };
        error?: { message?: string };
      };
      if (!r.ok) return { v: CONTRACT_VERSION, ok: false, error: body?.error?.message ?? `The model gateway rejected the call (HTTP ${r.status}).`, latencyMs };
      return { v: CONTRACT_VERSION, ok: true, text: body?.choices?.[0]?.message?.content ?? "", tokens: body?.usage?.total_tokens, latencyMs };
    } catch (e) {
      const timedOut = e instanceof Error && e.name === "TimeoutError";
      return { v: CONTRACT_VERSION, ok: false, error: timedOut ? "The model gateway timed out." : "Can't reach the model gateway.", latencyMs: Date.now() - started };
    }
  }

  // A refusal is the fail-closed default: any denial, missing credential, off-allowlist destination,
  // or error becomes a structured refusal record (FR-8/NFR-2/NFR-4) — never a permitted egress.
  function refuse(destination: string, detail: string, started: number): GuardConnectionResponse {
    return { v: CONTRACT_VERSION, ok: false, refusal: { destination, detail }, latencyMs: Date.now() - started };
  }

  // Mode (a) credentialed-connection gateway (AD-5): resolve the destination, enforce default-deny
  // against the run's allowlist, run the Filter Hook, attach the HELD credential, forward. The token
  // never crosses back to the sandbox (it isn't in the response). `runId` comes from the socket, not
  // the body — one run can't act as another.
  async function forwardConnection(runId: string, req: GuardConnectionRequest): Promise<GuardConnectionResponse> {
    const started = Date.now();
    const destination = destinationForOp(req.op);
    const state = runs.get(runId);
    // Default-deny: the destination must be on the allowlist AND we must hold a credential for the
    // named connection. Either miss → refused (AC2/AC3). Empty allowlist ⇒ everything refuses.
    if (!state || !state.allowlist.has(destination)) {
      return refuse(destination, `Blocked egress to ${destination} — not on this agent's allowlist.`, started);
    }
    const cred = state.credentials.get(req.connectionId);
    if (!cred || cred.provider !== "gmail") {
      return refuse(destination, `Blocked egress to ${destination} — no connection credential is available for this run.`, started);
    }
    // Filter Hook (no-op by default, E4-AD-6). A block becomes a refusal.
    const verdict = filterHook("egress", { destination, op: req.op });
    if (!verdict.allow) return refuse(destination, `Blocked egress to ${destination} — ${verdict.reason}`, started);

    try {
      const maxResults = req.params?.maxResults ?? 5;
      // Read-only Gmail: list recent message ids. The held token is attached HERE (AD-5), never
      // exposed to the sandbox.
      const r = await doFetch(`https://${destination}/gmail/v1/users/me/messages?maxResults=${maxResults}`, {
        method: "GET",
        headers: { authorization: `Bearer ${cred.accessToken}` },
        signal: AbortSignal.timeout(connectionTimeoutMs),
      });
      const latencyMs = Date.now() - started;
      const body = (await r.json().catch(() => ({}))) as { messages?: { id: string }[]; error?: { message?: string } };
      if (!r.ok) return { v: CONTRACT_VERSION, ok: false, error: body?.error?.message ?? `Gmail rejected the read (HTTP ${r.status}).`, latencyMs };
      const ids = (body.messages ?? []).map((m) => m.id);
      return { v: CONTRACT_VERSION, ok: true, data: { messageCount: ids.length, messageIds: ids }, latencyMs };
    } catch (e) {
      // Fail-closed: a forward error is refused, never silently permitted.
      const timedOut = e instanceof Error && e.name === "TimeoutError";
      return refuse(destination, `Blocked egress to ${destination} — ${timedOut ? "the connection timed out." : "the connection couldn't be reached."}`, started);
    }
  }

  // Dispatch one UDS request: a CONNECTION read (has `op`) or a MODEL call (has `messages`). Anything
  // else is malformed. Fail-closed — an unparseable request is rejected, never forwarded.
  async function handle(runId: string, raw: string): Promise<{ status: number; body: unknown }> {
    const json = safeJson(raw);
    const conn = GuardConnectionRequestSchema.safeParse(json);
    if (conn.success) return { status: 200, body: await forwardConnection(runId, conn.data) };
    const model = GuardModelRequestSchema.safeParse(json);
    if (model.success) return { status: 200, body: await proxyModel(model.data) };
    return { status: 400, body: { v: CONTRACT_VERSION, ok: false, error: "Malformed guard request." } };
  }

  return {
    proxyModel, // exported for unit tests
    forwardConnection, // exported for unit tests
    async register(runId: string, provision: RunProvision = { connections: [] }): Promise<{ socketPath: string }> {
      const dir = runDir(runId);
      if (runs.has(runId)) await this.teardown(runId); // a re-register must not leak the old server/creds
      fs.mkdirSync(dir, { recursive: true });
      const socketPath = path.join(dir, SOCKET_NAME);
      try {
        fs.unlinkSync(socketPath);
      } catch {
        /* not present — fine */
      }
      // Build the run's allowlist (union of Connection destinations, default-deny) + credential map.
      const allowlist = new Set<string>();
      const credentials = new Map<string, ProvisionConnection>();
      for (const c of provision.connections) {
        for (const d of c.destinations) allowlist.add(d);
        credentials.set(c.connectionId, c);
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
            httpRes.end(JSON.stringify({ v: CONTRACT_VERSION, ok: false, error: "Guard request too large." }));
            httpReq.destroy();
          }
        });
        httpReq.on("end", async () => {
          if (aborted) return;
          const { status, body } = await handle(runId, raw);
          httpRes.writeHead(status, { "content-type": "application/json" });
          httpRes.end(JSON.stringify(body));
        });
      });
      // A per-run socket error must not crash the shared guard process (blast radius = all runs).
      server.on("error", (e) => console.error(`[egress-guard] run ${runId} socket error:`, e instanceof Error ? e.message : e));
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      runs.set(runId, { server, allowlist, credentials });
      return { socketPath };
    },
    async teardown(runId: string): Promise<void> {
      if (!ULID_RE.test(runId)) return; // never touch the FS for a bad id
      const state = runs.get(runId);
      if (state) {
        state.credentials.clear(); // drop the held tokens the instant the run ends (AD-10)
        await new Promise<void>((resolve) => state.server.close(() => resolve()));
        runs.delete(runId);
      }
      try {
        fs.rmSync(path.join(cfg.socketDir, runId), { recursive: true, force: true });
      } catch {
        /* already gone */
      }
    },
    activeRuns(): string[] {
      return [...runs.keys()];
    },
  };
}

export type Guard = ReturnType<typeof createGuard>;
