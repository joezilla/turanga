import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import type { ControlChannelMessage } from "@turanga/contracts";
import { runOrchestrator } from "./orchestrator.js";
import { memoryRunsRepo } from "./repo.js";
import { fakeSandboxRuntime, resolveSandboxRuntimeKind } from "./runtime.js";
import { fakeRunGuard } from "./guardClient.js";
import { createRunHub } from "./hub.js";
import { encryptSecret } from "../secrets/crypto.js";
import { fakeGoogleOAuth } from "../oauth/google.js";
import { fakeModelGateway } from "../litellm/gateway.js";
import type { AttachedSkill, CostCap } from "@turanga/domain";

type Agent = { id: string; model: string | null; instructions: string; state: "draft" | "active"; skills?: AttachedSkill[]; costCap?: CostCap };
const agent = (over: Partial<Agent> = {}): Agent => ({ id: "a1", model: "openai/gpt-4o", instructions: "be nice", state: "draft", ...over });
const agentsRepo = (a: Agent | null) => ({ get: async (id: string) => (a && a.id === id ? a : null) });

const nd = (m: ControlChannelMessage) => JSON.stringify(m);

function orch(opts: { agent?: Agent; runtime?: ReturnType<typeof fakeSandboxRuntime>; maxConcurrent?: number; runTimeoutMs?: number } = {}) {
  const runsRepo = memoryRunsRepo();
  const guard = fakeRunGuard();
  const hub = createRunHub();
  const runtime =
    opts.runtime ??
    fakeSandboxRuntime({ lines: [nd({ type: "turn", v: 5, role: "agent", text: "hi" }), nd({ type: "done", v: 5, status: "succeeded" })] });
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
    const { o } = orch({ runtime: fakeSandboxRuntime({ lines: ["not json", "{}", nd({ type: "done", v: 5, status: "succeeded" }), nd({ type: "done", v: 5, status: "failed" })] }) });
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
    const runtime = fakeSandboxRuntime({ lines: [nd({ type: "done", v: 5, status: "succeeded" })] });
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
    const runtime = fakeSandboxRuntime({ lines: [nd({ type: "done", v: 5, status: "succeeded" })] });
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

describe("run orchestrator — cost keys + kill-on-breach (4.5)", () => {
  const cap: CostCap = { perRun: { minor: 50, currency: "USD" }, perDay: null }; // $0.50 per-run

  function costOrch(opts: { hang?: boolean } = {}) {
    const runsRepo = memoryRunsRepo();
    const guard = fakeRunGuard();
    const modelGateway = fakeModelGateway();
    const runtime = opts.hang
      ? fakeSandboxRuntime({ hang: true })
      : fakeSandboxRuntime({ lines: [nd({ type: "done", v: 5, status: "succeeded" })] });
    const o = runOrchestrator({ runsRepo, agentsRepo: agentsRepo(agent({ costCap: cap })), runtime, guard, hub: createRunHub(), modelGateway, image: "img", sandboxVolume: "vol" });
    return { o, runsRepo, guard, runtime, modelGateway };
  }

  it("mints the per-run cost key into the provision (never the jobSpec) and deletes it on teardown (AD-10)", async () => {
    const { o, guard, runtime, modelGateway } = costOrch();
    const r = await o.launch("a1", "x");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The key is minted under the agent's team with the per-run cap and passed to the Guard…
    expect(modelGateway.mintedKeys).toHaveLength(1);
    expect(modelGateway.mintedKeys[0].perRunCap).toEqual(cap.perRun);
    const key = guard.registered[0].provision.costKey;
    expect(key).toBeTruthy();
    // …but NEVER into the sandbox jobSpec…
    expect(runtime.established[0].jobSpecJson).not.toContain(key!);
    // …and it's deleted on teardown (no leaked LiteLLM keys).
    expect(modelGateway.deletedKeys).toContain(key);
  });

  it("a Guard kill event reaps a live run → killed with a cap reason; a metrics event sets the cost summary (no drift)", async () => {
    const { o, runsRepo } = costOrch({ hang: true });
    const r = await o.start("a1", "x");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await vi.waitFor(async () => expect((await runsRepo.get(r.run.id))?.status).toBe("running")); // controller registered
    await o.handleGuardEvent(r.run.id, { type: "metrics", v: 5, latencyMs: 12, tokens: 100, costMicros: 4100 });
    await o.handleGuardEvent(r.run.id, { type: "kill", v: 5, scope: "run" });
    await vi.waitFor(async () => expect((await runsRepo.get(r.run.id))?.status).toBe("killed"));
    const run = await runsRepo.get(r.run.id);
    expect(run?.reason).toMatch(/per-run cost cap reached \(\$0\.50\)/);
    expect(run?.costMicros).toBe(4100); // persisted summary = the summed metrics event (AC3)
    expect(run?.transcript.some((m) => m.type === "metrics" && m.costMicros === 4100)).toBe(true);
  });

  it("sumTodayMicros aggregates the agent's run costs since UTC midnight", async () => {
    const repo = memoryRunsRepo();
    const now = new Date().toISOString();
    await repo.create({ id: "r1", agentId: "a1", status: "succeeded", taskInput: "", transcript: [], reason: null, costMicros: 4100, createdAt: now, endedAt: now });
    await repo.create({ id: "r2", agentId: "a1", status: "succeeded", taskInput: "", transcript: [], reason: null, costMicros: 900, createdAt: now, endedAt: now });
    await repo.create({ id: "r3", agentId: "other", status: "succeeded", taskInput: "", transcript: [], reason: null, costMicros: 5000, createdAt: now, endedAt: now });
    expect(await repo.sumTodayMicros("a1")).toBe(5000);
  });
});

describe("Story 5.2 — operate active agents (live status + spend)", () => {
  const yesterday = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();

  it("sumTodayMicrosByAgent groups today's run costs per agent and excludes prior days (agents-list meter)", async () => {
    const repo = memoryRunsRepo();
    const now = new Date().toISOString();
    await repo.create({ id: "r1", agentId: "a1", status: "succeeded", taskInput: "", transcript: [], reason: null, costMicros: 4100, createdAt: now, endedAt: now });
    await repo.create({ id: "r2", agentId: "a1", status: "killed", taskInput: "", transcript: [], reason: null, costMicros: 900, createdAt: now, endedAt: now });
    await repo.create({ id: "r3", agentId: "a2", status: "succeeded", taskInput: "", transcript: [], reason: null, costMicros: 5000, createdAt: now, endedAt: now });
    await repo.create({ id: "r4", agentId: "a1", status: "succeeded", taskInput: "", transcript: [], reason: null, costMicros: 7777, createdAt: yesterday, endedAt: yesterday }); // excluded (prior day)
    const byAgent = await repo.sumTodayMicrosByAgent();
    expect(byAgent).toEqual({ a1: 5000, a2: 5000 }); // a1 today = 4100+900; yesterday's 7777 excluded; agents with no runs today absent
    // The batch map agrees with the per-agent query for each agent (single source, no split-brain).
    expect(byAgent.a1).toBe(await repo.sumTodayMicros("a1"));
    expect(byAgent.a2).toBe(await repo.sumTodayMicros("a2"));
    expect(byAgent.a3).toBeUndefined(); // caller defaults an absent agent to 0
  });

  it("an Active agent runs under the same Sandbox + Guard as Test, with refusals recorded (AC2, NFR-1/4)", async () => {
    // The run establishment (validateAndCreate/execute) does NOT branch on agent.state — an Active
    // agent gets the identical Sandbox + Guard registration as a Draft. Prove it: run an Active agent
    // whose harness emits a refusal, and assert the Guard was registered, the sandbox established, and
    // the refusal is persisted on the Run (observability).
    const runtime = fakeSandboxRuntime({
      lines: [
        nd({ type: "turn", v: 5, role: "agent", text: "trying to reach the internet" }),
        nd({ type: "refusal", v: 5, kind: "egress", detail: "blocked evil.example.com" }),
        nd({ type: "done", v: 5, status: "succeeded" }),
      ],
    });
    const { o, guard } = orch({ agent: agent({ state: "active" }), runtime });
    const r = await o.launch("a1", "phone home");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(guard.registered).toHaveLength(1); // same Guard boundary as a Test run
    expect(guard.toreDown).toHaveLength(1);
    expect(runtime.established).toHaveLength(1); // same Sandbox — no unsandboxed fast-path for Active
    expect(r.run.transcript.some((m) => m.type === "refusal" && m.kind === "egress")).toBe(true); // refusal recorded (NFR-4)
  });

  it("an Active agent's metrics + cost are recorded and roll into the daily meter (AC2→AC1 loop, same caps as Test)", async () => {
    // Active agent with a per-run cap; the Guard reports a metrics event and a breach kill — identical
    // cost-cap enforcement to a Test run. The summed cost persists on the Run and therefore appears in
    // the agents-list daily aggregate (sumTodayMicros / sumTodayMicrosByAgent).
    const cap: CostCap = { perRun: { minor: 50, currency: "USD" }, perDay: { minor: 500, currency: "USD" } };
    const runsRepo = memoryRunsRepo();
    const o = runOrchestrator({
      runsRepo,
      agentsRepo: agentsRepo(agent({ state: "active", costCap: cap })),
      runtime: fakeSandboxRuntime({ hang: true }),
      guard: fakeRunGuard(),
      hub: createRunHub(),
      modelGateway: fakeModelGateway(),
      image: "img",
      sandboxVolume: "vol",
    });
    const r = await o.start("a1", "x");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await vi.waitFor(async () => expect((await runsRepo.get(r.run.id))?.status).toBe("running"));
    await o.handleGuardEvent(r.run.id, { type: "metrics", v: 5, latencyMs: 12, tokens: 100, costMicros: 4100 });
    await o.handleGuardEvent(r.run.id, { type: "kill", v: 5, scope: "run" });
    await vi.waitFor(async () => expect((await runsRepo.get(r.run.id))?.status).toBe("killed"));
    const run = await runsRepo.get(r.run.id);
    expect(run?.costMicros).toBe(4100); // metrics recorded on the Run (NFR-4)
    expect(await runsRepo.sumTodayMicros("a1")).toBe(4100); // rolls into the daily meter
    expect((await runsRepo.sumTodayMicrosByAgent()).a1).toBe(4100); // …and the batch agents-list read
  });
});

describe("RunsRepo (memory)", () => {
  it("create/get/setStatus/appendMessage/list", async () => {
    const repo = memoryRunsRepo();
    await repo.create({ id: "r1", agentId: "a1", status: "created", taskInput: "x", transcript: [], reason: null, createdAt: new Date().toISOString(), endedAt: null });
    await repo.appendMessage("r1", { type: "turn", v: 5, role: "user", text: "hi" });
    await repo.setStatus("r1", "succeeded", { endedAt: new Date().toISOString() });
    const got = await repo.get("r1");
    expect(got?.status).toBe("succeeded");
    expect(got?.transcript).toHaveLength(1);
    expect((await repo.list("a1")).map((r) => r.id)).toEqual(["r1"]);
    expect(await repo.list("other")).toEqual([]);
  });

  it("listSummary returns newest-first, agent-scoped, WITHOUT the transcript (run history, Story 5.3)", async () => {
    const repo = memoryRunsRepo();
    const t0 = "2026-08-01T00:00:00.000Z";
    const t1 = "2026-08-02T00:00:00.000Z";
    await repo.create({ id: "r1", agentId: "a1", status: "succeeded", taskInput: "first", transcript: [{ type: "turn", v: 5, role: "user", text: "hi" }], reason: null, costMicros: 4100, createdAt: t0, endedAt: t0 });
    await repo.create({ id: "r2", agentId: "a1", status: "killed", taskInput: "second", transcript: [{ type: "turn", v: 5, role: "agent", text: "bye" }], reason: "Killed — per-run cost cap reached ($0.50).", costMicros: 900, createdAt: t1, endedAt: t1 });
    await repo.create({ id: "r3", agentId: "other", status: "failed", taskInput: "x", transcript: [], reason: "boom", costMicros: 0, createdAt: t1, endedAt: t1 });

    const hist = await repo.listSummary("a1");
    expect(hist.map((r) => r.id)).toEqual(["r2", "r1"]); // newest first (create unshifts)
    expect(hist.every((r) => !("transcript" in r))).toBe(true); // no transcript in the projection
    // The summary carries the outcome + cause + cost + task for the list row.
    expect(hist[0]).toMatchObject({ id: "r2", status: "killed", reason: "Killed — per-run cost cap reached ($0.50).", costMicros: 900, taskInput: "second" });
    expect(await repo.listSummary("other")).toHaveLength(1);
    expect((await repo.listSummary()).map((r) => r.id)).toEqual(["r3", "r2", "r1"]); // all agents when unscoped
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
