import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import type { ControlChannelMessage } from "@turanga/contracts";
import { runOrchestrator } from "./orchestrator.js";
import { memoryRunsRepo } from "./repo.js";
import { fakeSandboxRuntime, resolveSandboxRuntimeKind } from "./runtime.js";
import { fakeRunGuard } from "./guardClient.js";
import { createRunHub } from "./hub.js";
import { encryptSecret } from "../secrets/crypto.js";
import { fakeGoogleOAuth } from "../oauth/google.js";
import type { AttachedSkill } from "@turanga/domain";

type Agent = { id: string; model: string | null; instructions: string; state: "draft" | "active"; skills?: AttachedSkill[] };
const agent = (over: Partial<Agent> = {}): Agent => ({ id: "a1", model: "openai/gpt-4o", instructions: "be nice", state: "draft", ...over });
const agentsRepo = (a: Agent | null) => ({ get: async (id: string) => (a && a.id === id ? a : null) });

const nd = (m: ControlChannelMessage) => JSON.stringify(m);

function orch(opts: { agent?: Agent; runtime?: ReturnType<typeof fakeSandboxRuntime>; maxConcurrent?: number; runTimeoutMs?: number } = {}) {
  const runsRepo = memoryRunsRepo();
  const guard = fakeRunGuard();
  const hub = createRunHub();
  const runtime =
    opts.runtime ??
    fakeSandboxRuntime({ lines: [nd({ type: "turn", v: 3, role: "agent", text: "hi" }), nd({ type: "done", v: 3, status: "succeeded" })] });
  const o = runOrchestrator({ runsRepo, agentsRepo: agentsRepo(opts.agent ?? agent()), runtime, guard, hub, image: "img", sandboxVolume: "vol", maxConcurrent: opts.maxConcurrent, runTimeoutMs: opts.runTimeoutMs });
  return { o, runsRepo, guard, runtime, hub };
}

describe("run orchestrator", () => {
  it("launches a sandbox, streams the transcript, reaps, succeeds", async () => {
    const { o, guard, runtime } = orch();
    const r = await o.launch("a1", "do it");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.run.status).toBe("succeeded");
    expect(r.run.transcript.map((m) => m.type)).toEqual(["turn", "done"]);
    expect(runtime.established).toHaveLength(1);
    expect(runtime.established[0].guardVolume).toBe("vol"); // the sandbox mounts its own subpath of this volume
    expect(runtime.established[0].jobSpecJson).toContain('"taskInput":"do it"');
    expect(guard.registered).toHaveLength(1);
    expect(guard.toreDown).toHaveLength(1); // registered + torn down exactly once
    expect(r.run.endedAt).toBeTruthy();
  });

  it("fails closed when the sandbox can't be established — no unsandboxed fallback", async () => {
    const { o, guard } = orch({ runtime: fakeSandboxRuntime({ failEstablish: "unknown runtime specified runsc" }) });
    const r = await o.launch("a1", "x");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.run.status).toBe("failed");
    expect(r.run.reason).toMatch(/couldn't be established/i);
    expect(guard.toreDown).toHaveLength(1); // guard torn down even on failure (no leak)
  });

  it("404 for a missing agent; 400 for an agent with no model", async () => {
    const miss = await orch({ agent: agent({ id: "other" }) }).o.launch("a1", "x");
    expect(miss.ok).toBe(false);
    if (miss.ok) return;
    expect(miss.status).toBe(404);

    const noModel = await orch({ agent: agent({ model: null }) }).o.launch("a1", "x");
    expect(noModel.ok).toBe(false);
    if (noModel.ok) return;
    expect(noModel.status).toBe(400);
  });

  it("derives failed from a nonzero exit code when no done message arrives", async () => {
    const { o } = orch({ runtime: fakeSandboxRuntime({ lines: [], exitCode: 3 }) });
    const r = await o.launch("a1", "x");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.run.status).toBe("failed");
    expect(r.run.reason).toMatch(/exited 3/);
  });

  it("ignores malformed control lines and stops at the first done", async () => {
    const { o } = orch({ runtime: fakeSandboxRuntime({ lines: ["not json", "{}", nd({ type: "done", v: 3, status: "succeeded" }), nd({ type: "done", v: 3, status: "failed" })] }) });
    const r = await o.launch("a1", "x");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.run.status).toBe("succeeded"); // first terminal wins; the trailing done is ignored
    expect(r.run.transcript).toHaveLength(1);
  });

  it("kills a hung run at the wall-clock deadline (Run=killed, reason set)", async () => {
    const runtime = fakeSandboxRuntime({ hang: true });
    const { o } = orch({ runtime, runTimeoutMs: 40 });
    const r = await o.launch("a1", "x");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.run.status).toBe("killed");
    expect(r.run.reason).toMatch(/time limit/i);
    expect(runtime.killed).toBeGreaterThanOrEqual(1); // force-killed
  });

  it("rejects over the concurrency cap with a stated reason (429)", async () => {
    const r = await orch({ maxConcurrent: 0 }).o.launch("a1", "x");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(429);
  });

  it("start() returns a running run immediately, then completes in the background", async () => {
    const { o, runsRepo } = orch();
    const r = await o.start("a1", "do it");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.run.status).toBe("running"); // returned before the sandbox finishes
    await vi.waitFor(async () => expect((await runsRepo.get(r.run.id))?.status).toBe("succeeded"));
    const done = await runsRepo.get(r.run.id);
    expect(done?.transcript.map((m) => m.type)).toEqual(["turn", "done"]);
    expect(done?.endedAt).toBeTruthy();
  });

  it("publishes each control message to the hub and completes it exactly once", async () => {
    const { o, hub } = orch();
    const r = await o.start("a1", "x");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const types: string[] = [];
    let doneCount = 0;
    let terminal = "";
    hub.subscribe(
      r.run.id,
      0,
      (m) => types.push(m.type),
      (s) => {
        doneCount++;
        terminal = s;
      },
    );
    await vi.waitFor(() => expect(doneCount).toBe(1));
    expect(types).toEqual(["turn", "done"]);
    expect(terminal).toBe("succeeded");
  });

  it("releases the concurrency slot when run creation fails — no permanent capacity loss", async () => {
    const base = memoryRunsRepo();
    let failNext = true;
    const flaky = { ...base, create: async (row: Parameters<typeof base.create>[0]) => {
      if (failNext) { failNext = false; throw new Error("db blip"); }
      return base.create(row);
    } };
    const runtime = fakeSandboxRuntime({ lines: [nd({ type: "done", v: 3, status: "succeeded" })] });
    const o = runOrchestrator({ runsRepo: flaky, agentsRepo: agentsRepo(agent()), runtime, guard: fakeRunGuard(), hub: createRunHub(), image: "img", sandboxVolume: "vol", maxConcurrent: 1 });
    await expect(o.launch("a1", "x")).rejects.toThrow("db blip"); // create() threw before execute()
    const r = await o.launch("a1", "x"); // slot was released → not stuck at the cap
    expect(r.ok).toBe(true);
  });

  it("start() enforces the concurrency cap up front (429, no run created)", async () => {
    const { o, runsRepo } = orch({ maxConcurrent: 0 });
    const r = await o.start("a1", "x");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(429);
    expect(await runsRepo.list()).toHaveLength(0);
  });
});

describe("run orchestrator — connections + credentialed provisioning (4.3)", () => {
  const OLD_KEY = process.env.TOKEN_ENC_KEY;
  beforeAll(() => {
    process.env.TOKEN_ENC_KEY = "test-token-enc-key";
  });
  afterAll(() => {
    if (OLD_KEY === undefined) delete process.env.TOKEN_ENC_KEY;
    else process.env.TOKEN_ENC_KEY = OLD_KEY;
  });

  type Conn = { id: string; provider: string; status: string; destinations: string[]; encRefreshToken: string | null };
  function connOrch(opts: { skills?: AttachedSkill[]; connections?: Conn[] }) {
    const runsRepo = memoryRunsRepo();
    const guard = fakeRunGuard();
    const runtime = fakeSandboxRuntime({ lines: [nd({ type: "done", v: 3, status: "succeeded" })] });
    const googleOAuth = fakeGoogleOAuth();
    const dataConnectionsRepo = { list: async () => opts.connections ?? [] };
    const o = runOrchestrator({
      runsRepo,
      agentsRepo: agentsRepo(agent({ skills: opts.skills })),
      runtime,
      guard,
      hub: createRunHub(),
      dataConnectionsRepo,
      googleOAuth,
      image: "img",
      sandboxVolume: "vol",
    });
    return { o, guard, runtime };
  }

  it("provisions the allowlist + minted credential + skill grants for a scoped-skill agent with a connected Gmail — token/grant NEVER authoritative in the jobSpec (AC1, AD-10)", async () => {
    const enc = encryptSecret("refresh-xyz");
    const { o, guard, runtime } = connOrch({
      skills: [{ skill: "read-search", scope: "read", send: false }],
      connections: [{ id: "c1", provider: "gmail", status: "connected", destinations: ["gmail.googleapis.com", "oauth2.googleapis.com"], encRefreshToken: enc }],
    });
    const r = await o.launch("a1", "read my mail");
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // The Guard is provisioned with the allowlist + the minted access token + the skill grants…
    const prov = guard.registered[0].provision;
    expect(prov.connections).toHaveLength(1);
    expect(prov.connections[0].destinations).toContain("gmail.googleapis.com");
    expect(prov.connections[0].accessToken).toBe("access-for-refresh-xyz");
    expect(prov.grants).toEqual([{ scope: "read", send: false }]);
    // …and the jobSpec carries the skill ID + LOGICAL handle — no token, no refresh token (AD-10).
    const jobSpecJson = runtime.established[0].jobSpecJson;
    expect(jobSpecJson).toContain('"id":"c1"');
    expect(jobSpecJson).toContain('"read-search"'); // skill IDs are sandbox-visible
    expect(jobSpecJson).not.toContain("access-for-refresh-xyz");
    expect(jobSpecJson).not.toContain("refresh-xyz");
  });

  it("empty provision + no skills when the agent has no scoped skill (default-deny per-agent)", async () => {
    const { o, guard, runtime } = connOrch({
      skills: [{ skill: "read-search", scope: "none", send: false }],
      connections: [{ id: "c1", provider: "gmail", status: "connected", destinations: ["gmail.googleapis.com"], encRefreshToken: encryptSecret("r") }],
    });
    const r = await o.launch("a1", "x");
    expect(r.ok).toBe(true);
    expect(guard.registered[0].provision.connections).toHaveLength(0);
    expect(guard.registered[0].provision.grants).toHaveLength(0);
    expect(runtime.established[0].jobSpecJson).toContain('"skills":[]');
    expect(runtime.established[0].jobSpecJson).toContain('"connections":[]');
  });

  it("grants reflect scope + send for enforcement; a send-off draft-reply provisions send:false (AC3 setup)", async () => {
    const { o, guard, runtime } = connOrch({
      skills: [{ skill: "draft-reply", scope: "read-write", send: false }],
      connections: [{ id: "c1", provider: "gmail", status: "error", destinations: ["gmail.googleapis.com"], encRefreshToken: null }],
    });
    const r = await o.launch("a1", "reply to mail");
    expect(r.ok).toBe(true);
    expect(guard.registered[0].provision.grants).toEqual([{ scope: "read-write", send: false }]);
    // The connection is always provisioned (metadata for the refusal destination) but with an EMPTY
    // token when not connected → the Guard refuses on egress, never grants without a credential.
    expect(guard.registered[0].provision.connections).toHaveLength(1);
    expect(guard.registered[0].provision.connections[0].accessToken).toBe("");
    expect(runtime.established[0].jobSpecJson).toContain('"draft-reply"');
    expect(runtime.established[0].jobSpecJson).not.toContain('accessToken'); // never in the jobSpec (AD-10)
  });
});

describe("RunsRepo (memory)", () => {
  it("create/get/setStatus/appendMessage/list", async () => {
    const repo = memoryRunsRepo();
    await repo.create({ id: "r1", agentId: "a1", status: "created", taskInput: "x", transcript: [], reason: null, createdAt: new Date().toISOString(), endedAt: null });
    await repo.appendMessage("r1", { type: "turn", v: 3, role: "user", text: "hi" });
    await repo.setStatus("r1", "succeeded", { endedAt: new Date().toISOString() });
    const got = await repo.get("r1");
    expect(got?.status).toBe("succeeded");
    expect(got?.transcript).toHaveLength(1);
    expect((await repo.list("a1")).map((r) => r.id)).toEqual(["r1"]);
    expect(await repo.list("other")).toEqual([]);
  });
});

describe("resolveSandboxRuntimeKind", () => {
  it("requires an explicit value (fail-closed), honors gvisor/dev-insecure, refuses dev-insecure in production", () => {
    expect(() => resolveSandboxRuntimeKind({})).toThrow(/must be set/); // no silent default
    expect(resolveSandboxRuntimeKind({ SANDBOX_RUNTIME: "gvisor" })).toBe("gvisor");
    expect(resolveSandboxRuntimeKind({ SANDBOX_RUNTIME: "dev-insecure" })).toBe("dev-insecure");
    expect(() => resolveSandboxRuntimeKind({ SANDBOX_RUNTIME: "dev-insecure", NODE_ENV: "production" })).toThrow(/refused in production/);
    expect(() => resolveSandboxRuntimeKind({ SANDBOX_RUNTIME: "bogus" })).toThrow();
  });
});
