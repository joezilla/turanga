import { describe, it, expect } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGuard, sentinelFilterHook, type ProvisionConnection, type SkillGrant, type ProvisionTool } from "./guard.js";
import { fakeMcpToolCaller } from "./mcp.js";
import type { GuardModelResponse, ToolCallRequest } from "@turanga/contracts";

const okFetch = (async () =>
  new Response(JSON.stringify({ choices: [{ message: { content: "hello from the model" } }], usage: { total_tokens: 12 } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;

const errFetch = (async () =>
  new Response(JSON.stringify({ error: { message: "no key configured (401)" } }), { status: 401, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

describe("guard model proxy", () => {
  it("maps a model request to a LiteLLM call and returns the completion", async () => {
    const guard = createGuard({ socketDir: "/tmp", litellmBaseUrl: "http://litellm:4000", litellmMasterKey: "sk", fetchImpl: okFetch });
    const res = await guard.proxyModel("01ARZ3NDEKTSV4RRFFQ69G5FAV", { v: 5, runId: "r", model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }] });
    expect(res.ok).toBe(true);
    expect(res.text).toBe("hello from the model");
    expect(res.tokens).toBe(12);
  });

  it("surfaces a provider error (no fallback)", async () => {
    const guard = createGuard({ socketDir: "/tmp", litellmBaseUrl: "http://litellm:4000", litellmMasterKey: "sk", fetchImpl: errFetch });
    const res = await guard.proxyModel("01ARZ3NDEKTSV4RRFFQ69G5FAV", { v: 5, runId: "r", model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }] });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/401/);
  });
});

const RUN = "01ARZ3NDEKTSV4RRFFQ69G5FAV"; // a valid ULID

describe("guard per-run socket lifecycle", () => {
  it("rejects a non-ULID runId (no path traversal)", async () => {
    const guard = createGuard({ socketDir: "/tmp", litellmBaseUrl: "http://x", litellmMasterKey: "sk", fetchImpl: okFetch });
    await expect(guard.register("../../etc/x")).rejects.toThrow(/invalid/i);
  });

  it("register provisions a UDS in the run's own subdir that serves the model contract; teardown removes it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-"));
    const guard = createGuard({ socketDir: dir, litellmBaseUrl: "http://litellm:4000", litellmMasterKey: "sk", fetchImpl: okFetch });
    const { socketPath } = await guard.register(RUN, { connections: [], grants: [], costKey: "sk-run-lifecycle" }); // a registered run carries a cost key (4.5)
    expect(fs.existsSync(socketPath)).toBe(true);
    expect(socketPath).toContain(`${RUN}/run.sock`); // per-run subdir (isolation)
    expect(guard.activeRuns()).toEqual([RUN]);

    // A harness-style HTTP-over-UDS call resolves through the socket.
    const body = JSON.stringify({ v: 5, runId: RUN, model: "m", messages: [{ role: "user", content: "hi" }] });
    const out = await new Promise<GuardModelResponse>((resolve) => {
      const req = http.request({ socketPath, path: "/", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => resolve(JSON.parse(raw)));
      });
      req.end(body);
    });
    expect(out.ok).toBe(true);
    expect(out.text).toBe("hello from the model");

    await guard.teardown(RUN);
    expect(fs.existsSync(socketPath)).toBe(false);
    expect(guard.activeRuns()).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

const gmailConn: ProvisionConnection = { connectionId: "gmail", provider: "gmail", destinations: ["gmail.googleapis.com", "oauth2.googleapis.com"], accessToken: "tok-secret-123" };
const FULL_GRANT: SkillGrant[] = [{ scope: "read-write", send: true }]; // authorizes any op — used to reach the egress stage
const readReq = { v: 5 as const, runId: RUN, connectionId: "gmail", op: "read" as const, params: { maxResults: 5 } };

// A fetch spy that captures the outbound request and returns a Gmail-style message list.
function captureGmailFetch() {
  const calls: { url: string; auth: string | undefined }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(url), auth: headers.authorization });
    return new Response(JSON.stringify({ messages: [{ id: "m1" }, { id: "m2" }] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("guard credentialed-connection gateway (mode a) + default-deny allowlist (4.3)", () => {
  async function withGuard(provision: { connections: ProvisionConnection[]; grants?: SkillGrant[] }, fetchImpl: typeof fetch) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-"));
    const guard = createGuard({ socketDir: dir, litellmBaseUrl: "http://x", litellmMasterKey: "sk", fetchImpl });
    await guard.register(RUN, { connections: provision.connections, grants: provision.grants ?? FULL_GRANT });
    return { guard, dir, cleanup: async () => { await guard.teardown(RUN); fs.rmSync(dir, { recursive: true, force: true }); } };
  }

  it("forwards an allowlisted read with the HELD credential; the token never returns to the sandbox (AC1)", async () => {
    const { impl, calls } = captureGmailFetch();
    const { guard, cleanup } = await withGuard({ connections: [gmailConn] }, impl);
    const res = await guard.forwardConnection(RUN, readReq);
    expect(res.ok).toBe(true);
    expect((res.data as { messageCount: number }).messageCount).toBe(2);
    // The Guard terminated TLS and attached the held token itself (AD-5)…
    expect(calls[0].auth).toBe("Bearer tok-secret-123");
    expect(calls[0].url).toContain("gmail.googleapis.com/gmail/v1/users/me/messages");
    // …and the token is NOWHERE in what crosses back to the sandbox (AD-10).
    expect(JSON.stringify(res)).not.toContain("tok-secret-123");
    await cleanup();
  });

  it("refuses a read when the allowlist is empty — reaches nothing (AC3)", async () => {
    const { impl, calls } = captureGmailFetch();
    const { guard, cleanup } = await withGuard({ connections: [] }, impl);
    const res = await guard.forwardConnection(RUN, readReq);
    expect(res.ok).toBe(false);
    expect(res.refusal?.kind).toBe("egress");
    expect(res.refusal?.detail).toMatch(/not on this agent's allowlist/);
    expect(calls).toHaveLength(0); // never forwarded
    await cleanup();
  });

  it("refuses a read for a connection whose credential the run doesn't hold (egress)", async () => {
    const { impl, calls } = captureGmailFetch();
    const { guard, cleanup } = await withGuard({ connections: [{ ...gmailConn, connectionId: "other" }] }, impl);
    const res = await guard.forwardConnection(RUN, readReq); // asks for connectionId "gmail"
    expect(res.ok).toBe(false);
    expect(res.refusal?.kind).toBe("egress");
    expect(calls).toHaveLength(0);
    await cleanup();
  });

  it("fails closed — a forward error becomes a refusal, never a permitted egress (NFR-2)", async () => {
    const throwing = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    const { guard, cleanup } = await withGuard({ connections: [gmailConn] }, throwing);
    const res = await guard.forwardConnection(RUN, readReq);
    expect(res.ok).toBe(false);
    expect(res.refusal?.destination).toBe("gmail.googleapis.com");
    await cleanup();
  });

  it("a no-op filter block refuses; teardown zeroes the held credentials", async () => {
    const { impl } = captureGmailFetch();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-"));
    const guard = createGuard({ socketDir: dir, litellmBaseUrl: "http://x", litellmMasterKey: "sk", fetchImpl: impl, filterHook: () => ({ allow: false, reason: "blocked by test sentinel" }) });
    await guard.register(RUN, { connections: [gmailConn], grants: FULL_GRANT });
    const blocked = await guard.forwardConnection(RUN, readReq);
    expect(blocked.ok).toBe(false);
    expect(blocked.refusal?.detail).toMatch(/blocked by test sentinel/);
    await guard.teardown(RUN);
    const afterTeardown = await guard.forwardConnection(RUN, readReq);
    expect(afterTeardown.ok).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("guard skill-permission enforcement (4.4, permission-first)", () => {
  async function withGrants(grants: SkillGrant[], connections: ProvisionConnection[], fetchImpl: typeof fetch) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-"));
    const guard = createGuard({ socketDir: dir, litellmBaseUrl: "http://x", litellmMasterKey: "sk", fetchImpl });
    await guard.register(RUN, { connections, grants });
    return { guard, cleanup: async () => { await guard.teardown(RUN); fs.rmSync(dir, { recursive: true, force: true }); } };
  }
  const op = (o: "read" | "label" | "send") => ({ v: 5 as const, runId: RUN, connectionId: "gmail", op: o });

  it("refuses an out-of-scope op with kind=permission BEFORE any credential is consulted (AC2)", async () => {
    const { impl, calls } = captureGmailFetch();
    // read-only grant + a fully credentialed connection: a `label` (write) op must still refuse on
    // permission, and must NOT reach the adapter (fetch never called).
    const { guard, cleanup } = await withGrants([{ scope: "read", send: false }], [gmailConn], impl);
    const res = await guard.forwardConnection(RUN, op("label"));
    expect(res.ok).toBe(false);
    expect(res.refusal?.kind).toBe("permission");
    expect(calls).toHaveLength(0); // permission-first: no forward, no credential use
    await cleanup();
  });

  it("refuses send when the send grant is off — kind=permission (AC3)", async () => {
    const { impl, calls } = captureGmailFetch();
    const { guard, cleanup } = await withGrants([{ scope: "read-write", send: false }], [gmailConn], impl);
    const res = await guard.forwardConnection(RUN, op("send"));
    expect(res.ok).toBe(false);
    expect(res.refusal?.kind).toBe("permission");
    expect(res.refusal?.detail).toMatch(/Allow send/);
    expect(calls).toHaveLength(0);
    await cleanup();
  });

  it("send passes permission (grant on) then refuses on egress when no credential is held", async () => {
    const { impl } = captureGmailFetch();
    const { guard, cleanup } = await withGrants([{ scope: "read-write", send: true }], [], impl); // no connection provisioned
    const res = await guard.forwardConnection(RUN, op("send"));
    expect(res.ok).toBe(false);
    expect(res.refusal?.kind).toBe("egress"); // permission passed, egress failed
    await cleanup();
  });

  it("no grants (default-deny) refuses even a read on permission, ahead of egress", async () => {
    const { impl, calls } = captureGmailFetch();
    const { guard, cleanup } = await withGrants([], [gmailConn], impl);
    const res = await guard.forwardConnection(RUN, op("read"));
    expect(res.ok).toBe(false);
    expect(res.refusal?.kind).toBe("permission");
    expect(calls).toHaveLength(0);
    await cleanup();
  });
});

describe("guard filter hook seam (4.6)", () => {
  const gmailWithLabel: ProvisionConnection = { ...gmailConn };
  async function withFilter(fetchImpl: typeof fetch, filterHook?: ReturnType<typeof sentinelFilterHook>) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-"));
    const guard = createGuard({ socketDir: dir, litellmBaseUrl: "http://x", litellmMasterKey: "sk", fetchImpl, filterHook });
    await guard.register(RUN, { connections: [gmailWithLabel], grants: FULL_GRANT });
    return { guard, cleanup: async () => { await guard.teardown(RUN); fs.rmSync(dir, { recursive: true, force: true }); } };
  }

  it("the default (no-op) hook does not alter behavior — an allowed read forwards unchanged (AC1)", async () => {
    const { impl, calls } = captureGmailFetch();
    const { guard, cleanup } = await withFilter(impl); // no filterHook ⇒ NOOP default
    const res = await guard.forwardConnection(RUN, readReq);
    expect(res.ok).toBe(true);
    expect((res.data as { messageCount: number }).messageCount).toBe(2);
    expect(calls).toHaveLength(1); // forwarded, same as without the hook
    await cleanup();
  });

  it("a registered sentinel hook blocks a matching EGRESS payload + records it (adapter never called) (AC2)", async () => {
    const { impl, calls } = captureGmailFetch();
    const { guard, cleanup } = await withFilter(impl, sentinelFilterHook("BLOCKME"));
    const res = await guard.forwardConnection(RUN, { ...readReq, params: { note: "please BLOCKME now" } });
    expect(res.ok).toBe(false);
    expect(res.refusal?.detail).toMatch(/matched the content filter/i);
    expect(calls).toHaveLength(0); // blocked before the forward — nothing egressed
    await cleanup();
  });

  it("a registered sentinel hook blocks a matching INGRESS response — the data is withheld (AC2)", async () => {
    // The Gmail response carries the sentinel (a message id); the ingress hook must withhold it.
    const impl = (async () => new Response(JSON.stringify({ messages: [{ id: "BLOCKME-123" }] }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const { guard, cleanup } = await withFilter(impl, sentinelFilterHook("BLOCKME"));
    const res = await guard.forwardConnection(RUN, readReq);
    expect(res.ok).toBe(false);
    expect(res.refusal?.detail).toMatch(/Blocked ingress/i);
    expect(JSON.stringify(res)).not.toContain("BLOCKME-123"); // the blocked data never reaches the sandbox
    await cleanup();
  });

  it("a sentinel hook passes a non-matching payload through unchanged (AC1/AC2)", async () => {
    const { impl, calls } = captureGmailFetch();
    const { guard, cleanup } = await withFilter(impl, sentinelFilterHook("BLOCKME"));
    const res = await guard.forwardConnection(RUN, { ...readReq, params: { note: "nothing to see" } });
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    await cleanup();
  });
});

describe("guard cost metering + kill-on-breach (4.5)", () => {
  const modelReq = { v: 5 as const, runId: RUN, model: "openai/gpt-4o", messages: [{ role: "user" as const, content: "hi" }] };

  function costFetch(status: number, message?: string, cost = "0.0041") {
    const calls: { auth: string | undefined }[] = [];
    const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ auth: headers.authorization });
      const body = status === 200 ? { choices: [{ message: { content: "hi" } }], usage: { total_tokens: 10 } } : { error: { message } };
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-litellm-response-cost": cost } });
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  async function withCostKey(fetchImpl: typeof fetch, costKey = "sk-run-costkey") {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-"));
    const events: { runId: string; event: { type: string; costMicros?: number; scope?: string } }[] = [];
    const guard = createGuard({ socketDir: dir, litellmBaseUrl: "http://x", litellmMasterKey: "sk-master", fetchImpl, emitRunEvent: (runId, event) => { events.push({ runId, event }); } });
    await guard.register(RUN, { connections: [], grants: [], costKey });
    return { guard, events, cleanup: async () => { await guard.teardown(RUN); fs.rmSync(dir, { recursive: true, force: true }); } };
  }

  it("attaches the per-run cost key (not the master) and reports cost metrics out-of-band", async () => {
    const { impl, calls } = costFetch(200);
    const { guard, events, cleanup } = await withCostKey(impl);
    const res = await guard.proxyModel(RUN, modelReq);
    expect(res.ok).toBe(true);
    expect(calls[0].auth).toBe("Bearer sk-run-costkey"); // the per-run key, not sk-master
    const metrics = events.find((e) => e.event.type === "metrics");
    expect(metrics?.event.costMicros).toBe(4100); // $0.0041 → 4100 micro-USD
    expect(events.some((e) => e.event.type === "kill")).toBe(false);
    await cleanup();
  });

  it("detects a 400 budget block as a breach and emits a kill event (per-run scope)", async () => {
    const { impl } = costFetch(400, "Budget has been exceeded! Current cost: 0.6, Max budget: 0.5");
    const { guard, events, cleanup } = await withCostKey(impl);
    const res = await guard.proxyModel(RUN, modelReq);
    expect(res.ok).toBe(false);
    const kill = events.find((e) => e.event.type === "kill");
    expect(kill?.event.scope).toBe("run");
    await cleanup();
  });

  it("classifies a team budget message as the daily (day) breach", async () => {
    const { impl } = costFetch(400, "ExceededBudget: Crossed spend within team");
    const { guard, events, cleanup } = await withCostKey(impl);
    await guard.proxyModel(RUN, modelReq);
    expect(events.find((e) => e.event.type === "kill")?.event.scope).toBe("day");
    await cleanup();
  });

  it("a non-budget error (e.g. 401) is NOT a breach — no kill event", async () => {
    const { impl } = costFetch(401, "no key configured");
    const { guard, events, cleanup } = await withCostKey(impl);
    const res = await guard.proxyModel(RUN, modelReq);
    expect(res.ok).toBe(false);
    expect(events.some((e) => e.event.type === "kill")).toBe(false);
    expect(events.some((e) => e.event.type === "metrics")).toBe(true); // metrics still reported
    await cleanup();
  });

  it("fail-closed: a REGISTERED run with no cost key refuses the model call (never borrows the master key)", async () => {
    const { impl, calls } = costFetch(200);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-"));
    const guard = createGuard({ socketDir: dir, litellmBaseUrl: "http://x", litellmMasterKey: "sk-master", fetchImpl: impl });
    await guard.register(RUN, { connections: [], grants: [] }); // registered but NO costKey (misconfig)
    const res = await guard.proxyModel(RUN, modelReq);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no cost key/i);
    expect(calls).toHaveLength(0); // never called LiteLLM (no unmetered master-key run)
    await guard.teardown(RUN);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("guard tool broker (Story 6.4)", () => {
  const tool: ProvisionTool = { toolId: "t1", url: "https://mcp.example/mcp", credential: "sk-tool-secret", operations: ["get_time"] };
  const toolReq = (over: Partial<ToolCallRequest> = {}): ToolCallRequest => ({ v: 5, runId: RUN, toolId: "t1", operation: "get_time", arguments: {}, ...over });

  async function withTool(mcpCall: ReturnType<typeof fakeMcpToolCaller>, provisionTools: ProvisionTool[] = [tool]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-"));
    const guard = createGuard({ socketDir: dir, litellmBaseUrl: "http://x", litellmMasterKey: "sk", fetchImpl: okFetch, mcpCall });
    await guard.register(RUN, { connections: [], grants: [], tools: provisionTools });
    return { guard, cleanup: async () => { await guard.teardown(RUN); fs.rmSync(dir, { recursive: true, force: true }); } };
  }

  it("a granted op → the Guard performs the MCP call with the HELD credential + operation + arguments; the credential never returns (AC1, AD-10)", async () => {
    const mcp = fakeMcpToolCaller({ content: [{ type: "text", text: "2026-01-01T00:00:00Z" }] });
    const { guard, cleanup } = await withTool(mcp);
    const res = await guard.forwardTool(RUN, toolReq({ arguments: { tz: "UTC" } }));
    expect(res.ok).toBe(true);
    expect(res.isError).toBe(false);
    expect(res.content).toEqual([{ type: "text", text: "2026-01-01T00:00:00Z" }]);
    // The Guard attached the held credential + operation + arguments (Guard-side custody).
    expect(mcp.calls).toHaveLength(1);
    expect(mcp.calls[0]).toMatchObject({ url: "https://mcp.example/mcp", credential: "sk-tool-secret", operation: "get_time", arguments: { tz: "UTC" } });
    // AD-10: the credential is NEVER in the response the sandbox receives.
    expect(JSON.stringify(res)).not.toContain("sk-tool-secret");
    await cleanup();
  });

  it("an UNGRANTED operation → a permission refusal, and the MCP call is NOT made (default-deny, AC2)", async () => {
    const mcp = fakeMcpToolCaller();
    const { guard, cleanup } = await withTool(mcp);
    const res = await guard.forwardTool(RUN, toolReq({ operation: "delete_everything" }));
    expect(res.ok).toBe(false);
    expect(res.refusal?.kind).toBe("permission");
    expect(mcp.calls).toHaveLength(0); // fail-closed — nothing egressed
    await cleanup();
  });

  it("an unprovisioned/unknown tool → a permission refusal (fail-closed)", async () => {
    const mcp = fakeMcpToolCaller();
    const { guard, cleanup } = await withTool(mcp);
    const res = await guard.forwardTool(RUN, toolReq({ toolId: "nope" }));
    expect(res.ok).toBe(false);
    expect(res.refusal?.kind).toBe("permission");
    expect(mcp.calls).toHaveLength(0);
    await cleanup();
  });

  it("a tool whose endpoint host isn't on the allowlist → an egress refusal", async () => {
    // Provision the grant but with a url whose host was NOT added (simulate by a tool the register
    // step couldn't parse → host absent from the allowlist).
    const mcp = fakeMcpToolCaller();
    const bad: ProvisionTool = { toolId: "t1", url: "not-a-url", credential: "", operations: ["get_time"] };
    const { guard, cleanup } = await withTool(mcp, [bad]);
    const res = await guard.forwardTool(RUN, toolReq());
    expect(res.ok).toBe(false);
    expect(res.refusal?.kind).toBe("egress");
    expect(mcp.calls).toHaveLength(0);
    await cleanup();
  });

  it("a tool-EXECUTION error (isError) passes through as ok:true, isError:true — NOT a Guard refusal", async () => {
    const mcp = fakeMcpToolCaller({ isError: true, content: [{ type: "text", text: "boom" }] });
    const { guard, cleanup } = await withTool(mcp);
    const res = await guard.forwardTool(RUN, toolReq());
    expect(res.ok).toBe(true);
    expect(res.isError).toBe(true);
    expect(res.refusal).toBeUndefined();
    await cleanup();
  });

  it("a transport failure from the caller → an error response, never a permitted call", async () => {
    const mcp = fakeMcpToolCaller({ ok: false, error: "Couldn't reach the tool endpoint." });
    const { guard, cleanup } = await withTool(mcp);
    const res = await guard.forwardTool(RUN, toolReq());
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/couldn't reach/i);
    await cleanup();
  });

  it("teardown clears the held tool credential (AD-10) — after teardown the tool is gone (permission refusal)", async () => {
    const mcp = fakeMcpToolCaller();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-"));
    const guard = createGuard({ socketDir: dir, litellmBaseUrl: "http://x", litellmMasterKey: "sk", fetchImpl: okFetch, mcpCall: mcp });
    await guard.register(RUN, { connections: [], grants: [], tools: [tool] });
    expect((await guard.forwardTool(RUN, toolReq())).ok).toBe(true);
    await guard.teardown(RUN);
    const after = await guard.forwardTool(RUN, toolReq());
    expect(after.ok).toBe(false);
    expect(after.refusal?.kind).toBe("permission"); // state (incl. the held credential) is gone
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("dispatch routes a ToolCallRequest to forwardTool over the UDS (not the model/connection path)", async () => {
    const mcp = fakeMcpToolCaller({ content: [{ type: "text", text: "ok" }] });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-"));
    const guard = createGuard({ socketDir: dir, litellmBaseUrl: "http://x", litellmMasterKey: "sk", fetchImpl: okFetch, mcpCall: mcp });
    const { socketPath } = await guard.register(RUN, { connections: [], grants: [], tools: [tool] });
    const body = JSON.stringify(toolReq());
    const out = await new Promise<{ ok: boolean; content?: unknown[] }>((resolve) => {
      const req = http.request({ socketPath, path: "/", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => resolve(JSON.parse(raw)));
      });
      req.end(body);
    });
    expect(out.ok).toBe(true);
    expect(mcp.calls).toHaveLength(1); // reached forwardTool
    await guard.teardown(RUN);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
