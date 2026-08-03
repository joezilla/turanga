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
  ToolCallRequestSchema,
  authorizes,
  type ConnectionOp,
  type SkillScope,
  type GuardModelRequest,
  type GuardModelResponse,
  type GuardConnectionRequest,
  type GuardConnectionResponse,
  type ToolCallRequest,
  type ToolCallResponse,
  type GuardRunEvent,
} from "@turanga/contracts";
import { httpMcpToolCaller, type McpToolCaller } from "./mcp.js";

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
/** A granted tool the Guard holds for the life of a run (Story 6.4, AD-10). `operations` is the
 *  per-operation allow-list (default-deny); `credential` is the HELD bearer token (decrypted
 *  control-side, "" for a no-auth tool) — attached only inside the MCP call, never crossing the UDS. */
export interface ProvisionTool {
  toolId: string;
  url: string;
  credential: string;
  operations: string[];
}
export interface RunProvision {
  connections: ProvisionConnection[];
  grants: SkillGrant[];
  tools?: ProvisionTool[]; // Story 6.4 — granted tools + held credentials (control-plane only, never the jobSpec)
  costKey?: string; // the per-run LiteLLM cost key (Story 4.5) — held by the Guard, never the sandbox
}

/** The Filter Hook (E4-AD-6, Story 4.6): a synchronous inspection seam in the Guard —
 *  `inspect(direction, meta, body?) → allow | block(reason)` — invoked on the connection gateway's
 *  egress request AND its ingress response (AD-2 / FR-10, "ingress/egress payloads"). It is an
 *  interface + registration point, NOT scanning logic. A no-op hook is registered by default and
 *  MUST NOT alter behavior; the real content/PII inspector is the deferred roadmap reference monitor.
 *  (It never runs on the model-provider path — that's cost-metered, AD-2. Mode-b plain-egress
 *  connect is deferred with mode-b; the same hook serves it when it lands.) */
export type FilterDirection = "egress" | "ingress";
export type FilterHook = (direction: FilterDirection, meta: { destination: string; op: string }, body?: unknown) => { allow: true } | { allow: false; reason: string };
const NOOP_HOOK: FilterHook = () => ({ allow: true });

/** A trivial test filter that blocks when the serialized meta/body contains `sentinel` (Story 4.6).
 *  It proves the seam end-to-end; it is NOT a real inspector. */
export function sentinelFilterHook(sentinel: string): FilterHook {
  return (_direction, meta, body) => {
    if (sentinel && JSON.stringify({ meta, body }).includes(sentinel)) return { allow: false, reason: "the payload matched the content filter." };
    return { allow: true };
  };
}

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
  mcpCall?: McpToolCaller; // Story 6.4 — the Guard-side tool `tools/call`; injectable for tests (default: real SDK)
  modelTimeoutMs?: number;
  connectionTimeoutMs?: number;
  filterHook?: FilterHook; // defaults to the no-op (4.6 swaps in the real one)
  // Story 4.5 — the out-of-band Guard→orchestrator control-plane channel (E4-AD-10). Cost `metrics`
  // and a budget-breach `kill` are reported here, NOT through the sandbox. Default posts an HTTP
  // callback to control-api; injectable for tests.
  controlCallbackUrl?: string;
  callbackToken?: string;
  emitRunEvent?: (runId: string, event: GuardRunEvent) => void | Promise<void>;
}

interface RunState {
  server: http.Server;
  allowlist: Set<string>; // union of the run's Connections' + tools' destinations (default-deny)
  credentials: Map<string, ProvisionConnection>; // by connectionId — the held tokens (AD-10)
  grants: SkillGrant[]; // the agent's attached-skill grants — the authority to run an op (4.4)
  tools: Map<string, ProvisionTool>; // by toolId — granted ops + the held tool credential (Story 6.4, AD-10)
  costKey?: string; // the per-run LiteLLM cost key (Story 4.5) — held here, never in the sandbox (AD-10)
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i; // reject anything that could escape the socket dir
const MAX_REQ_BODY = 256 * 1024; // a request is small; cap to prevent memory-exhaustion DoS
const SOCKET_NAME = "run.sock";
const MICROS_PER_USD = 1_000_000;

// A LiteLLM budget block on /chat/completions is HTTP 400 with a "budget exceeded" message (NOT 429
// — 429 is rate-limits). Match the message; classify a team message as the daily cap.
function budgetBreach(status: number, message: string): { scope: "run" | "day" } | null {
  if (status !== 400 || !/budget|exceeded/i.test(message)) return null;
  return { scope: /team|crossed spend/i.test(message) ? "day" : "run" };
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
  const mcpCall = cfg.mcpCall ?? httpMcpToolCaller();
  const modelTimeoutMs = cfg.modelTimeoutMs ?? 60_000;
  const connectionTimeoutMs = cfg.connectionTimeoutMs ?? 30_000;
  const filterHook = cfg.filterHook ?? NOOP_HOOK;
  const runs = new Map<string, RunState>();

  // Out-of-band Guard→orchestrator channel (E4-AD-10). Default: an HTTP callback to control-api,
  // authenticated by the shared callback token. Best-effort (a lost event must never hang a run).
  const emitRunEvent =
    cfg.emitRunEvent ??
    ((runId: string, event: GuardRunEvent) => {
      if (!cfg.controlCallbackUrl) return;
      void doFetch(`${cfg.controlCallbackUrl}/internal/guard/runs/${encodeURIComponent(runId)}/events`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-guard-callback": cfg.callbackToken ?? "" },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(5_000),
      }).catch(() => {});
    });

  function runDir(runId: string): string {
    if (!ULID_RE.test(runId)) throw new Error("Invalid runId.");
    return path.join(cfg.socketDir, runId);
  }

  // Proxy a model call to LiteLLM using the run's PER-RUN COST KEY (Story 4.5, AD-6) — LiteLLM 400s
  // the call when the per-run or per-agent(daily) budget is exceeded, capping spend regardless of the
  // harness. Cost/tokens + any breach are reported to the orchestrator OUT OF BAND (E4-AD-10), never
  // through the sandbox. `runId` is the trusted socket runId, not the body's.
  async function proxyModel(runId: string, req: GuardModelRequest): Promise<GuardModelResponse> {
    const started = Date.now();
    const state = runs.get(runId);
    // Fail-closed (E4-AD-8/NFR-2): a REGISTERED run must carry a per-run cost key — refuse rather
    // than borrow the unmetered master key (that would be an unkillable, uncapped run). The master
    // fallback remains only for an unregistered call (direct unit tests; unreachable via the UDS).
    if (state && !state.costKey) {
      return { v: CONTRACT_VERSION, ok: false, error: "The model call was refused — this run has no cost key (misconfiguration).", latencyMs: 0 };
    }
    const costKey = state?.costKey ?? cfg.litellmMasterKey;
    try {
      const r = await doFetch(`${cfg.litellmBaseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${costKey}` },
        body: JSON.stringify({ model: req.model, messages: req.messages }),
        signal: AbortSignal.timeout(modelTimeoutMs), // never let a stalled gateway hang the run
      });
      const latencyMs = Date.now() - started;
      const costMicros = Math.round((Number(r.headers.get("x-litellm-response-cost")) || 0) * MICROS_PER_USD);
      const body = (await r.json().catch(() => ({}))) as {
        choices?: { message?: { content?: string } }[];
        usage?: { total_tokens?: number };
        error?: { message?: string };
      };
      const tokens = body?.usage?.total_tokens ?? 0;
      // Report cost/tokens for this call to the orchestrator (E4-AD-10) — this is the cost truth now,
      // replacing the harness's metrics emit.
      void emitRunEvent(runId, { type: "metrics", v: CONTRACT_VERSION, latencyMs, tokens, costMicros });
      if (!r.ok) {
        const message = body?.error?.message ?? `The model gateway rejected the call (HTTP ${r.status}).`;
        const breach = budgetBreach(r.status, message);
        if (breach) void emitRunEvent(runId, { type: "kill", v: CONTRACT_VERSION, scope: breach.scope }); // → orchestrator reaps
        return { v: CONTRACT_VERSION, ok: false, error: message, latencyMs };
      }
      return { v: CONTRACT_VERSION, ok: true, text: body?.choices?.[0]?.message?.content ?? "", tokens, latencyMs };
    } catch (e) {
      const timedOut = e instanceof Error && e.name === "TimeoutError";
      void emitRunEvent(runId, { type: "metrics", v: CONTRACT_VERSION, latencyMs: Date.now() - started, tokens: 0, costMicros: 0 });
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

    // 3. Filter Hook — EGRESS (no-op by default, E4-AD-6). Inspect the outbound request body; a
    //    block becomes a refusal (never a silent pass). The hook runs only on otherwise-permitted
    //    egress, and never sees the held credential (attached below, after this point).
    const meta = { destination: adapter.host, op: req.op };
    const egressVerdict = filterHook("egress", meta, req.params);
    if (!egressVerdict.allow) return refuse(adapter.host, `Blocked egress to ${adapter.host} — ${egressVerdict.reason}`, "egress", started);

    // 4. Forward through the provider adapter with the HELD token (never returned to the sandbox).
    try {
      const params = (req.params ?? {}) as Record<string, unknown>;
      const result = await adapter.forward(req.op, params, cred.accessToken, doFetch, connectionTimeoutMs);
      const latencyMs = Date.now() - started;
      if (!result.ok) return { v: CONTRACT_VERSION, ok: false, error: result.error, latencyMs };
      // 5. Filter Hook — INGRESS (no-op by default). Inspect the returned data before it re-enters
      //    the sandbox; a block withholds the data as a refusal (the sandbox gets a refusal, not it).
      const ingressVerdict = filterHook("ingress", meta, result.data);
      if (!ingressVerdict.allow) return refuse(adapter.host, `Blocked ingress from ${adapter.host} — ${ingressVerdict.reason}`, "egress", started);
      return { v: CONTRACT_VERSION, ok: true, data: result.data, latencyMs };
    } catch (e) {
      const timedOut = e instanceof Error && e.name === "TimeoutError";
      return refuse(adapter.host, `Blocked egress to ${adapter.host} — ${timedOut ? "the connection timed out." : "the connection couldn't be reached."}`, "egress", started);
    }
  }

  // A tool refusal (Story 6.4). Same fail-closed record as a connection refusal, but the tool refusal
  // shape carries only { kind, detail } (no `destination` — contracts).
  function refuseTool(kind: "permission" | "egress", detail: string, started: number): ToolCallResponse {
    return { v: CONTRACT_VERSION, ok: false, refusal: { kind, detail }, latencyMs: Date.now() - started };
  }

  // Broker a tool call (Story 6.4) — the runtime twin of forwardConnection. Enforced fail-closed:
  // (1) PERMISSION — the tool must be provisioned for this run AND the operation must be in its
  //     granted allow-list (default-deny, per-operation) — checked BEFORE the endpoint/credential.
  // (2) EGRESS — the tool endpoint host must be on the run's allowlist (default-deny).
  // (3) FORWARD — the MCP `tools/call` with the HELD credential (attached Guard-side, never returned
  //     to the sandbox — AD-10). `isError` is the tool's own execution error, passed through as-is
  //     (distinct from a Guard refusal). `runId` comes from the socket, not the body.
  async function forwardTool(runId: string, req: ToolCallRequest): Promise<ToolCallResponse> {
    const started = Date.now();
    const state = runs.get(runId);
    const tool = state?.tools.get(req.toolId);

    // 1. PERMISSION (default-deny, AC2) — no provisioned tool, or an ungranted operation, refuses
    //    before any endpoint/credential is consulted.
    if (!state || !tool) {
      return refuseTool("permission", "That tool isn't attached to this run.", started);
    }
    if (!tool.operations.includes(req.operation)) {
      return refuseTool("permission", `Blocked — operation "${req.operation}" isn't granted for this tool. Grant it in the agent's Tools section.`, started);
    }

    // 2. EGRESS (default-deny) — the tool endpoint host must be on the allowlist (added at register).
    let host: string;
    try {
      host = new URL(tool.url).host;
    } catch {
      return refuseTool("egress", "Blocked — the tool endpoint isn't a valid URL.", started);
    }
    if (!state.allowlist.has(host)) {
      return refuseTool("egress", `Blocked egress to ${host} — not on this agent's allowlist.`, started);
    }

    // 3. Filter Hook — EGRESS (no-op by default, E4-AD-6). Inspect the outbound arguments; a block
    //    becomes a refusal (never a silent pass). Runs on otherwise-permitted egress; never sees the
    //    held credential (attached below).
    const meta = { destination: host, op: req.operation };
    const egressVerdict = filterHook("egress", meta, req.arguments);
    if (!egressVerdict.allow) return refuseTool("egress", `Blocked egress to ${host} — ${egressVerdict.reason}`, started);

    // 4. Forward the MCP tools/call with the HELD credential (never returned to the sandbox).
    const r = await mcpCall({ url: tool.url, credential: tool.credential || undefined, operation: req.operation, arguments: req.arguments, timeoutMs: connectionTimeoutMs });
    const latencyMs = Date.now() - started;
    if (!r.ok) return { v: CONTRACT_VERSION, ok: false, error: r.error, latencyMs };
    // 5. Filter Hook — INGRESS (no-op by default). Inspect the returned content before it re-enters
    //    the sandbox; a block withholds it as a refusal.
    const ingressVerdict = filterHook("ingress", meta, r.content);
    if (!ingressVerdict.allow) return refuseTool("egress", `Blocked ingress from ${host} — ${ingressVerdict.reason}`, started);
    return { v: CONTRACT_VERSION, ok: true, content: r.content, isError: r.isError, latencyMs };
  }

  // Dispatch one UDS request: a CONNECTION op (has `op`), a TOOL call (has `toolId`), or a MODEL call
  // (has `messages`). Anything else is malformed. Fail-closed — an unparseable request is rejected,
  // never forwarded. Tool is checked before model because both carry `operation`-ish fields; the
  // discriminating keys (`connectionId`/`toolId`/`messages`) keep the safeParse branches disjoint.
  async function handle(runId: string, raw: string): Promise<{ status: number; body: unknown }> {
    const json = safeJson(raw);
    const conn = GuardConnectionRequestSchema.safeParse(json);
    if (conn.success) return { status: 200, body: await forwardConnection(runId, conn.data) };
    const tool = ToolCallRequestSchema.safeParse(json);
    if (tool.success) return { status: 200, body: await forwardTool(runId, tool.data) };
    const model = GuardModelRequestSchema.safeParse(json);
    if (model.success) return { status: 200, body: await proxyModel(runId, model.data) };
    return { status: 400, body: { v: CONTRACT_VERSION, ok: false, error: "Malformed guard request." } };
  }

  return {
    proxyModel, // exported for unit tests
    forwardConnection, // exported for unit tests
    forwardTool, // exported for unit tests (Story 6.4)
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
      // Story 6.4 — hold the granted tools + their credentials, and add each tool endpoint's host to
      // the allowlist (default-deny egress, exactly like a connection's destinations).
      const tools = new Map<string, ProvisionTool>();
      for (const t of provision.tools ?? []) {
        tools.set(t.toolId, t);
        try {
          allowlist.add(new URL(t.url).host);
        } catch {
          /* a bad url just won't be reachable — the egress check refuses it */
        }
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
          // Fail-closed (NFR-2): ANY throw in dispatch (e.g. a Filter Hook that throws, or an
          // unserializable body) becomes a written refused response — never a hung request.
          try {
            const { status, body } = await handle(runId, raw);
            httpRes.writeHead(status, { "content-type": "application/json" });
            httpRes.end(JSON.stringify(body));
          } catch (e) {
            console.error(`[egress-guard] run ${runId} dispatch error:`, e instanceof Error ? e.message : e);
            httpRes.writeHead(500, { "content-type": "application/json" });
            httpRes.end(JSON.stringify({ v: CONTRACT_VERSION, ok: false, error: "The guard refused the request (internal error)." }));
          }
        });
      });
      // A per-run socket error must not crash the shared guard process (blast radius = all runs).
      server.on("error", (e) => console.error(`[egress-guard] run ${runId} socket error:`, e instanceof Error ? e.message : e));
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      runs.set(runId, { server, allowlist, credentials, grants, tools, costKey: provision.costKey });
      return { socketPath };
    },
    async teardown(runId: string): Promise<void> {
      if (!ULID_RE.test(runId)) return; // never touch the FS for a bad id
      const state = runs.get(runId);
      if (state) {
        state.credentials.clear(); // drop the held connection tokens the instant the run ends (AD-10)
        state.tools.clear(); // …and the held tool credentials (Story 6.4, AD-10)
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
