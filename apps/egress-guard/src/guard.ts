// The Guard's per-run egress (Epic 4). Each run gets its OWN subdirectory + Unix-domain socket
// on the shared volume (E4-AD-1) — a sandbox is mounted only its own subdir (a per-run subpath),
// so it can never see another run's socket. The socket serves the harness↔Guard logical-request
// contract (E4-AD-9): a MODEL call (proxied to LiteLLM) or a CONNECTION op (mode a, AD-5).
//
// Every connection op is enforced fail-closed in two stages: (1) PERMISSION — the op must be
// authorized by the agent's granted skill scopes/send (Story 4.4, permission-first so an
// out-of-scope/ungranted op refuses independent of connection state); (2) EGRESS — default-deny
// against the run's allowlist + a held credential (Story 4.3). Any error/miss ⇒ refused (NFR-2).
// The agent never holds the token (AD-10). Provider specifics live ONLY in a ConnectionAdapter
// (SM-4). Seams ahead: per-run cost key (4.5), real Filter Hook content-scanning (4.6 — the no-op
// interface is wired here).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import {
  CONTRACT_VERSION,
  GuardModelRequestSchema,
  GuardConnectionRequestSchema,
  authorizes,
  type ConnectionOp,
  type SkillScope,
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
/** The agent's attached-skill grants — the authority to run an op (Story 4.4). */
export interface SkillGrant {
  scope: SkillScope;
  send: boolean;
}
export interface RunProvision {
  connections: ProvisionConnection[];
  grants: SkillGrant[];
}

/** The Filter Hook (E4-AD-6): a synchronous inspection point invoked before a credentialed
 *  forward. A no-op hook is registered by default and MUST NOT alter behavior; the real
 *  content-scanning hook lands in Story 4.6. */
export type FilterHook = (direction: "egress", meta: { destination: string; op: string }) => { allow: true } | { allow: false; reason: string };
const NOOP_HOOK: FilterHook = () => ({ allow: true });

// ── Connection adapters (SM-4) ───────────────────────────────────────────────────────────────────
// The ONLY place provider (Gmail) specifics live. `forwardConnection` and the enforcement above stay
// provider-agnostic; a new connector is a new adapter, no change to the guard/enforcement.
interface ConnectionAdapter {
  host: string; // the destination the allowlist is checked against
  forward(op: ConnectionOp, params: Record<string, unknown> | undefined, accessToken: string, doFetch: typeof fetch, timeoutMs: number): Promise<{ ok: true; data: unknown } | { ok: false; error: string }>;
}

const gmailAdapter: ConnectionAdapter = {
  host: "gmail.googleapis.com",
  async forward(op, params, accessToken, doFetch, timeoutMs) {
    const base = "https://gmail.googleapis.com/gmail/v1/users/me";
    const auth = { authorization: `Bearer ${accessToken}` };
    const signal = AbortSignal.timeout(timeoutMs);
    if (op === "read") {
      const n = Math.min(25, Math.max(1, Number(params?.maxResults ?? 5)));
      const r = await doFetch(`${base}/messages?maxResults=${n}`, { method: "GET", headers: auth, signal });
      const body = (await r.json().catch(() => ({}))) as { messages?: { id: string }[]; error?: { message?: string } };
      if (!r.ok) return { ok: false, error: body?.error?.message ?? `Gmail read failed (HTTP ${r.status}).` };
      const ids = (body.messages ?? []).map((m) => m.id);
      return { ok: true, data: { messageCount: ids.length, messageIds: ids } };
    }
    if (op === "label") {
      const id = String(params?.messageId ?? "");
      const r = await doFetch(`${base}/messages/${encodeURIComponent(id)}/modify`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ addLabelIds: params?.addLabelIds ?? [], removeLabelIds: params?.removeLabelIds ?? [] }),
        signal,
      });
      const body = (await r.json().catch(() => ({}))) as { error?: { message?: string } };
      if (!r.ok) return { ok: false, error: body?.error?.message ?? `Gmail label failed (HTTP ${r.status}).` };
      return { ok: true, data: { labeled: id } };
    }
    // op === "send"
    const r = await doFetch(`${base}/messages/send`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ raw: String(params?.raw ?? "") }),
      signal,
    });
    const body = (await r.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
    if (!r.ok) return { ok: false, error: body?.error?.message ?? `Gmail send failed (HTTP ${r.status}).` };
    return { ok: true, data: { sent: body.id } };
  },
};

const ADAPTERS: Record<string, ConnectionAdapter> = { gmail: gmailAdapter };

// Per-op refusal copy (cause → consequence → recovery). The Guard owns the refusal record; the
// harness relays it. Provider-agnostic — names the action + the Skills-section recovery.
function permissionDetail(op: ConnectionOp): string {
  switch (op) {
    case "send":
      return "Blocked send — this agent isn't permitted to send. Turn on Allow send for an outbound skill in the Skills section.";
    case "label":
      return "Blocked — this agent isn't permitted to modify (needs a read-write skill scope). Widen a skill's scope in the Skills section.";
    case "read":
      return "Blocked — this agent isn't permitted to read (needs a read skill scope). Widen a skill's scope in the Skills section.";
  }
}

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
  grants: SkillGrant[]; // the agent's attached-skill grants — the authority to run an op (4.4)
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

  // A refusal is the fail-closed default: any denial becomes a structured record (FR-3/FR-8/NFR-2/
  // NFR-4) — never a permitted op.
  function refuse(destination: string, detail: string, kind: "egress" | "permission", started: number): GuardConnectionResponse {
    return { v: CONTRACT_VERSION, ok: false, refusal: { destination, detail, kind }, latencyMs: Date.now() - started };
  }

  // Mode (a) credentialed-connection gateway (AD-5), enforced fail-closed. `runId` comes from the
  // socket, not the body — one run can't act as another.
  async function forwardConnection(runId: string, req: GuardConnectionRequest): Promise<GuardConnectionResponse> {
    const started = Date.now();
    const state = runs.get(runId);
    const grants = state?.grants ?? [];

    // 1. PERMISSION (Story 4.4) — authorize the op against the agent's skill grants BEFORE any
    //    credential is consulted. An out-of-scope/ungranted op refuses even with no connection.
    if (!authorizes(grants, req.op)) {
      return refuse("", permissionDetail(req.op), "permission", started);
    }

    // 2. EGRESS (Story 4.3) — default-deny: the connection's destination on the allowlist AND a held
    //    credential. The connection's provider (adapter) resolves the destination so a refusal can
    //    name it even when uncredentialed (NFR-4). Any miss ⇒ egress refusal (empty allowlist ⇒ nothing).
    const cred = state?.credentials.get(req.connectionId);
    const adapter = cred ? ADAPTERS[cred.provider] : undefined;
    if (!state || !cred || !adapter) {
      return refuse("the requested destination", `Blocked egress to the requested destination — not on this agent's allowlist.`, "egress", started);
    }
    if (!state.allowlist.has(adapter.host)) {
      return refuse(adapter.host, `Blocked egress to ${adapter.host} — not on this agent's allowlist.`, "egress", started);
    }
    if (!cred.accessToken) {
      return refuse(adapter.host, `Blocked egress to ${adapter.host} — no connection credential is available for this run.`, "egress", started);
    }

    // 3. Filter Hook (no-op by default, E4-AD-6). A block becomes an egress refusal.
    const verdict = filterHook("egress", { destination: adapter.host, op: req.op });
    if (!verdict.allow) return refuse(adapter.host, `Blocked egress to ${adapter.host} — ${verdict.reason}`, "egress", started);

    // 4. Forward through the provider adapter with the HELD token (never returned to the sandbox).
    try {
      const params = (req.params ?? {}) as Record<string, unknown>;
      const result = await adapter.forward(req.op, params, cred.accessToken, doFetch, connectionTimeoutMs);
      const latencyMs = Date.now() - started;
      return result.ok ? { v: CONTRACT_VERSION, ok: true, data: result.data, latencyMs } : { v: CONTRACT_VERSION, ok: false, error: result.error, latencyMs };
    } catch (e) {
      const timedOut = e instanceof Error && e.name === "TimeoutError";
      return refuse(adapter.host, `Blocked egress to ${adapter.host} — ${timedOut ? "the connection timed out." : "the connection couldn't be reached."}`, "egress", started);
    }
  }

  // Dispatch one UDS request: a CONNECTION op (has `op`) or a MODEL call (has `messages`). Anything
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
    async register(runId: string, provision: RunProvision = { connections: [], grants: [] }): Promise<{ socketPath: string }> {
      const dir = runDir(runId);
      if (runs.has(runId)) await this.teardown(runId); // a re-register must not leak the old server/creds
      fs.mkdirSync(dir, { recursive: true });
      const socketPath = path.join(dir, SOCKET_NAME);
      try {
        fs.unlinkSync(socketPath);
      } catch {
        /* not present — fine */
      }
      // Build the run's allowlist (union of Connection destinations, default-deny), credential map,
      // and skill grants (the authority to run an op).
      const allowlist = new Set<string>();
      const credentials = new Map<string, ProvisionConnection>();
      for (const c of provision.connections) {
        for (const d of c.destinations) allowlist.add(d);
        credentials.set(c.connectionId, c);
      }
      const grants = provision.grants ?? [];
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
      runs.set(runId, { server, allowlist, credentials, grants });
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
