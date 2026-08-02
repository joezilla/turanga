import { describe, it, expect } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGuard, type ProvisionConnection, type SkillGrant } from "./guard.js";
import type { GuardModelResponse } from "@turanga/contracts";

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
    const res = await guard.proxyModel({ v: 3, runId: "r", model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }] });
    expect(res.ok).toBe(true);
    expect(res.text).toBe("hello from the model");
    expect(res.tokens).toBe(12);
  });

  it("surfaces a provider error (no fallback)", async () => {
    const guard = createGuard({ socketDir: "/tmp", litellmBaseUrl: "http://litellm:4000", litellmMasterKey: "sk", fetchImpl: errFetch });
    const res = await guard.proxyModel({ v: 3, runId: "r", model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }] });
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
    const { socketPath } = await guard.register(RUN);
    expect(fs.existsSync(socketPath)).toBe(true);
    expect(socketPath).toContain(`${RUN}/run.sock`); // per-run subdir (isolation)
    expect(guard.activeRuns()).toEqual([RUN]);

    // A harness-style HTTP-over-UDS call resolves through the socket.
    const body = JSON.stringify({ v: 3, runId: RUN, model: "m", messages: [{ role: "user", content: "hi" }] });
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
const readReq = { v: 3 as const, runId: RUN, connectionId: "gmail", op: "read" as const, params: { maxResults: 5 } };

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
  const op = (o: "read" | "label" | "send") => ({ v: 3 as const, runId: RUN, connectionId: "gmail", op: o });

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
