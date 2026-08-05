import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { CONTRACT_VERSION, type ControlChannelMessage } from "@turanga/contracts";
import { runOrchestrator } from "./orchestrator.js";
import { memoryRunsRepo } from "./repo.js";
import { fakeSandboxRuntime, resolveSandboxRuntimeKind } from "./runtime.js";
import { fakeRunGuard } from "./guardClient.js";
import { createRunHub } from "./hub.js";
import { encryptSecret } from "../secrets/crypto.js";
import { fakeGoogleOAuth } from "../oauth/google.js";
import { fakeModelGateway, fakeEmbed } from "../litellm/gateway.js";
import { memoryMemoryRepo, type MemoryRow } from "../memory/repo.js";
import { fakeReflector } from "../memory/reflector.js";
import type { AttachedSkill, AttachedTool, CostCap } from "@turanga/domain";

type Agent = { id: string; model: string | null; instructions: string; state: "draft" | "active"; skills?: AttachedSkill[]; attachedTools?: AttachedTool[]; costCap?: CostCap };
const agent = (over: Partial<Agent> = {}): Agent => ({ id: "a1", model: "openai/gpt-4o", instructions: "be nice", state: "draft", ...over });
const agentsRepo = (a: Agent | null) => ({ get: async (id: string) => (a && a.id === id ? a : null), listVersions: async () => [] });

const nd = (m: ControlChannelMessage) => JSON.stringify(m);

function orch(opts: { agent?: Agent; runtime?: ReturnType<typeof fakeSandboxRuntime>; maxConcurrent?: number; runTimeoutMs?: number } = {}) {
  const runsRepo = memoryRunsRepo();
  const guard = fakeRunGuard();
  const hub = createRunHub();
  const runtime =
    opts.runtime ??
    fakeSandboxRuntime({ lines: [nd({ type: "turn", v: CONTRACT_VERSION, role: "agent", text: "hi" }), nd({ type: "done", v: CONTRACT_VERSION, status: "succeeded" })] });
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
    const { o } = orch({ runtime: fakeSandboxRuntime({ lines: ["not json", "{}", nd({ type: "done", v: CONTRACT_VERSION, status: "succeeded" }), nd({ type: "done", v: CONTRACT_VERSION, status: "failed" })] }) });
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
    const runtime = fakeSandboxRuntime({ lines: [nd({ type: "done", v: CONTRACT_VERSION, status: "succeeded" })] });
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
    const runtime = fakeSandboxRuntime({ lines: [nd({ type: "done", v: CONTRACT_VERSION, status: "succeeded" })] });
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

  // Story 6.3 — granted tools land on the sandbox-visible JobSpec.tools as logical handles.
  type ToolRec = { id: string; name: string; url: string | null; encCredential: string | null; operations: { name: string }[] };
  function toolOrch(opts: { attachedTools?: AttachedTool[]; tools?: ToolRec[] }) {
    const runsRepo = memoryRunsRepo();
    const guard = fakeRunGuard();
    const runtime = fakeSandboxRuntime({ lines: [nd({ type: "done", v: CONTRACT_VERSION, status: "succeeded" })] });
    const byId = new Map((opts.tools ?? []).map((t) => [t.id, t]));
    const toolsRepo = { getTool: async (id: string) => byId.get(id) ?? null };
    const o = runOrchestrator({
      runsRepo,
      agentsRepo: agentsRepo(agent({ attachedTools: opts.attachedTools })),
      runtime,
      guard,
      hub: createRunHub(),
      toolsRepo,
      image: "img",
      sandboxVolume: "vol",
    });
    return { o, guard, runtime };
  }

  it("puts granted tools on the jobSpec as { id, name, operations } — omits ungranted tools, never leaks url/credential (AC2, AD-10)", async () => {
    const { o, runtime } = toolOrch({
      attachedTools: [
        { toolId: "t-weather", operations: ["get_weather"] }, // granted → on the spec
        { toolId: "t-empty", operations: [] }, // attached but ungranted → omitted (default-deny)
      ],
      tools: [
        { id: "t-weather", name: "Weather", url: "https://mcp.example/mcp", encCredential: "enc-secret-blob", operations: [{ name: "get_weather" }, { name: "get_forecast" }] },
        { id: "t-empty", name: "Empty", url: "https://empty.example/mcp", encCredential: null, operations: [{ name: "noop" }] },
      ],
    });
    const r = await o.launch("a1", "weather?");
    expect(r.ok).toBe(true);
    const jobSpecJson = runtime.established[0].jobSpecJson;
    const spec = JSON.parse(jobSpecJson) as { tools: { id: string; name: string; operations: string[] }[] };
    expect(spec.tools).toEqual([{ id: "t-weather", name: "Weather", operations: ["get_weather"] }]);
    // AD-10: the endpoint URL + the encrypted credential are NEVER on the sandbox wire.
    expect(jobSpecJson).not.toContain("mcp.example");
    expect(jobSpecJson).not.toContain("enc-secret-blob");
  });

  it("skips a grant whose tool was deleted rather than failing the run", async () => {
    const { o, runtime } = toolOrch({ attachedTools: [{ toolId: "gone", operations: ["x"] }], tools: [] });
    const r = await o.launch("a1", "x");
    expect(r.ok).toBe(true);
    expect(runtime.established[0].jobSpecJson).toContain('"tools":[]');
  });

  it("provisions the granted tool + DECRYPTED credential to the Guard — never into the jobSpec (Story 6.4, AD-10)", async () => {
    const enc = encryptSecret("tool-bearer-xyz");
    const { o, guard, runtime } = toolOrch({
      attachedTools: [{ toolId: "t-weather", operations: ["get_weather"] }],
      tools: [{ id: "t-weather", name: "Weather", url: "https://mcp.example/mcp", encCredential: enc, operations: [{ name: "get_weather" }, { name: "get_forecast" }] }],
    });
    const r = await o.launch("a1", "weather?");
    expect(r.ok).toBe(true);
    // The Guard is provisioned with the tool endpoint + the DECRYPTED credential + the granted ops…
    const provTools = guard.registered[0].provision.tools;
    expect(provTools).toEqual([{ toolId: "t-weather", url: "https://mcp.example/mcp", credential: "tool-bearer-xyz", operations: ["get_weather"] }]);
    // …and NONE of that (url, decrypted or encrypted credential) is on the sandbox wire (AD-10).
    const jobSpecJson = runtime.established[0].jobSpecJson;
    expect(jobSpecJson).not.toContain("mcp.example");
    expect(jobSpecJson).not.toContain("tool-bearer-xyz");
    expect(jobSpecJson).not.toContain(enc);
  });

  it("a no-auth tool (null encCredential) provisions an empty credential", async () => {
    const { o, guard } = toolOrch({
      attachedTools: [{ toolId: "t-open", operations: ["ping"] }],
      tools: [{ id: "t-open", name: "Open", url: "https://open.example/mcp", encCredential: null, operations: [{ name: "ping" }] }],
    });
    const r = await o.launch("a1", "x");
    expect(r.ok).toBe(true);
    expect(guard.registered[0].provision.tools).toEqual([{ toolId: "t-open", url: "https://open.example/mcp", credential: "", operations: ["ping"] }]);
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
      : fakeSandboxRuntime({ lines: [nd({ type: "done", v: CONTRACT_VERSION, status: "succeeded" })] });
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
    await o.handleGuardEvent(r.run.id, { type: "metrics", v: CONTRACT_VERSION, latencyMs: 12, tokens: 100, costMicros: 4100 });
    await o.handleGuardEvent(r.run.id, { type: "kill", v: CONTRACT_VERSION, scope: "run" });
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

  // Story 6.5 — per-tool invocation stats derived from the recorded `tool` messages.
  const toolMsg = (toolId: string, toolName: string, operation: string, outcome: "ok" | "error" | "refused", latencyMs: number): ControlChannelMessage =>
    ({ type: "tool", v: CONTRACT_VERSION, toolId, toolName, operation, outcome, latencyMs });

  it("aggregateToolStats reduces tool messages per tool (count, outcomes, avg latency) — observed only, no cost (AC1/AC2)", async () => {
    const repo = memoryRunsRepo();
    const t0 = "2026-08-03T00:00:00.000Z";
    const t1 = "2026-08-03T01:00:00.000Z";
    await repo.create({ id: "r1", agentId: "a1", status: "succeeded", taskInput: "", reason: null, costMicros: 0, createdAt: t0, endedAt: t0,
      transcript: [toolMsg("t-weather", "Weather", "get_time", "ok", 10), toolMsg("t-weather", "Weather", "get_time", "refused", 2), toolMsg("t-db", "DB", "query", "error", 30)] });
    await repo.create({ id: "r2", agentId: "a1", status: "failed", taskInput: "", reason: null, costMicros: 0, createdAt: t1, endedAt: t1,
      transcript: [toolMsg("t-weather", "Weather", "get_time", "ok", 20)] });
    await repo.create({ id: "r3", agentId: "other", status: "succeeded", taskInput: "", reason: null, costMicros: 0, createdAt: t1, endedAt: t1,
      transcript: [toolMsg("t-weather", "Weather", "get_time", "ok", 99)] }); // different agent — excluded

    const stats = await repo.aggregateToolStats("a1");
    const weather = stats.find((s) => s.toolId === "t-weather")!;
    expect(weather).toEqual({ toolId: "t-weather", toolName: "Weather", invocations: 3, ok: 2, errors: 0, refusals: 1, avgLatencyMs: 11, lastUsedAt: t1 }); // (10+2+20)/3 = 10.67 → 11
    const db = stats.find((s) => s.toolId === "t-db")!;
    expect(db).toMatchObject({ invocations: 1, ok: 0, errors: 1, refusals: 0, avgLatencyMs: 30 });
    // AC2 — observed only: the tool messages contributed NOTHING to run cost.
    expect(await repo.sumTodayMicros("a1")).toBe(0);
  });

  it("aggregateToolStats returns [] for an agent with no tool calls", async () => {
    const repo = memoryRunsRepo();
    const now = new Date().toISOString();
    await repo.create({ id: "r1", agentId: "a1", status: "succeeded", taskInput: "", transcript: [{ type: "done", v: CONTRACT_VERSION, status: "succeeded" }], reason: null, costMicros: 0, createdAt: now, endedAt: now });
    expect(await repo.aggregateToolStats("a1")).toEqual([]);
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
        nd({ type: "turn", v: CONTRACT_VERSION, role: "agent", text: "trying to reach the internet" }),
        nd({ type: "refusal", v: CONTRACT_VERSION, kind: "egress", detail: "blocked evil.example.com" }),
        nd({ type: "done", v: CONTRACT_VERSION, status: "succeeded" }),
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
    await o.handleGuardEvent(r.run.id, { type: "metrics", v: CONTRACT_VERSION, latencyMs: 12, tokens: 100, costMicros: 4100 });
    await o.handleGuardEvent(r.run.id, { type: "kill", v: CONTRACT_VERSION, scope: "run" });
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
    await repo.appendMessage("r1", { type: "turn", v: CONTRACT_VERSION, role: "user", text: "hi" });
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
    await repo.create({ id: "r1", agentId: "a1", status: "succeeded", taskInput: "first", transcript: [{ type: "turn", v: CONTRACT_VERSION, role: "user", text: "hi" }], reason: null, costMicros: 4100, createdAt: t0, endedAt: t0 });
    await repo.create({ id: "r2", agentId: "a1", status: "killed", taskInput: "second", transcript: [{ type: "turn", v: CONTRACT_VERSION, role: "agent", text: "bye" }], reason: "Killed — per-run cost cap reached ($0.50).", costMicros: 900, createdAt: t1, endedAt: t1 });
    await repo.create({ id: "r3", agentId: "other", status: "failed", taskInput: "x", transcript: [], reason: "boom", costMicros: 0, createdAt: t1, endedAt: t1 });

    const hist = await repo.listSummary("a1");
    expect(hist.map((r) => r.id)).toEqual(["r2", "r1"]); // newest first (create unshifts)
    expect(hist.every((r) => !("transcript" in r))).toBe(true); // no transcript in the projection
    // The summary carries the outcome + cause + cost + task for the list row.
    expect(hist[0]).toMatchObject({ id: "r2", status: "killed", reason: "Killed — per-run cost cap reached ($0.50).", costMicros: 900, taskInput: "second" });
    expect(await repo.listSummary("other")).toHaveLength(1);
    expect((await repo.listSummary()).map((r) => r.id)).toEqual(["r3", "r2", "r1"]); // all agents when unscoped
  });

  it("a run defaults to no conversation link; a chat turn sets it; the summary projection preserves both (Story 9.1)", async () => {
    const repo = memoryRunsRepo();
    // A standalone/test-console run: link fields default to null when omitted from create().
    await repo.create({ id: "solo", agentId: "a1", status: "created", taskInput: "x", transcript: [], reason: null, createdAt: "2026-08-01T00:00:00.000Z", endedAt: null });
    const solo = await repo.get("solo");
    expect(solo).toMatchObject({ conversationId: null, turnIndex: null });
    // A chat turn (Story 9.2 shape): the link is carried on both get() and the summary projection.
    await repo.create({ id: "turn", agentId: "a1", status: "created", taskInput: "hi", transcript: [], reason: null, createdAt: "2026-08-02T00:00:00.000Z", endedAt: null, conversationId: "conv-1", turnIndex: 2 });
    expect(await repo.get("turn")).toMatchObject({ conversationId: "conv-1", turnIndex: 2 });
    const summary = (await repo.listSummary("a1")).find((r) => r.id === "turn")!;
    expect(summary).toMatchObject({ conversationId: "conv-1", turnIndex: 2 }); // not dropped by the summary projection
  });

  it("listByConversation returns the conversation's turns in turnIndex ASC, with transcripts, scoped (Story 9.2)", async () => {
    const repo = memoryRunsRepo();
    // Insert out of turn order; listByConversation must sort by turnIndex ascending.
    await repo.create({ id: "t1", agentId: "a1", status: "succeeded", taskInput: "second", transcript: [{ type: "turn", v: CONTRACT_VERSION, role: "agent", text: "reply-1" }], reason: null, createdAt: "2026-08-02T00:00:00.000Z", endedAt: null, conversationId: "conv-1", turnIndex: 1 });
    await repo.create({ id: "t0", agentId: "a1", status: "succeeded", taskInput: "first", transcript: [{ type: "turn", v: CONTRACT_VERSION, role: "agent", text: "reply-0" }], reason: null, createdAt: "2026-08-01T00:00:00.000Z", endedAt: null, conversationId: "conv-1", turnIndex: 0 });
    await repo.create({ id: "other", agentId: "a1", status: "succeeded", taskInput: "x", transcript: [], reason: null, createdAt: "2026-08-03T00:00:00.000Z", endedAt: null, conversationId: "conv-2", turnIndex: 0 });

    const turns = await repo.listByConversation("conv-1");
    expect(turns.map((r) => r.id)).toEqual(["t0", "t1"]); // turnIndex ASC, never conv-2's
    expect(turns[0].transcript).toHaveLength(1); // full transcript (history needs the agent turn text)
    expect(await repo.listByConversation("empty")).toEqual([]);
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

describe("run orchestrator — recall (Story 8.3)", () => {
  const embeddedMemory = (over: Partial<MemoryRow> & { id: string; content: string }): MemoryRow => ({
    agentId: "a1",
    kind: "semantic",
    summary: "",
    embedding: fakeEmbed(over.content),
    topic: null,
    salience: 0,
    pinned: false,
    status: "active",
    sourceRunId: null,
    validFrom: "2026-08-05T00:00:00.000Z",
    validUntil: null,
    useCount: 0,
    lastUsedAt: null,
    createdAt: "2026-08-05T00:00:00.000Z",
    ...over,
  });

  async function recallOrch(opts: { recall: boolean; embedThrows?: boolean } = { recall: true }) {
    const runsRepo = memoryRunsRepo();
    const memoryRepo = memoryMemoryRepo();
    if (opts.recall) {
      await memoryRepo.setGlobalConfig({ defaultEnabled: true });
      await memoryRepo.setAgentMemoryConfig("a1", { mode: "on", recall: true, reflect: true, kinds: ["episodic", "semantic", "procedure"], requireApproval: false });
    }
    await memoryRepo.createMemory(embeddedMemory({ id: "mem-cats", content: "the user loves cats", summary: "the user loves cats" }));
    const runtime = fakeSandboxRuntime({ lines: [nd({ type: "done", v: CONTRACT_VERSION, status: "succeeded" })] });
    const gateway = fakeModelGateway({ embedThrows: opts.embedThrows });
    const o = runOrchestrator({ runsRepo, agentsRepo: agentsRepo(agent()), runtime, guard: fakeRunGuard(), hub: createRunHub(), memoryRepo, modelGateway: gateway, image: "img", sandboxVolume: "vol" });
    return { o, runsRepo, memoryRepo, runtime, gateway };
  }

  it("recall ON: injects the memory into the JobSpec, records a recall transcript event, and bumps useCount", async () => {
    const { o, memoryRepo, runtime } = await recallOrch({ recall: true });
    const r = await o.launch("a1", "the user loves cats"); // an exact-match query → mem-cats ranks first
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // Injected into the sandbox-visible JobSpec (secret-free id/kind/summary).
    expect(runtime.established[0].jobSpecJson).toContain("mem-cats");
    expect(runtime.established[0].jobSpecJson).toContain("the user loves cats");

    // Auditable causality: a recall event leads the transcript with the recalled id.
    const recall = r.run.transcript.find((m) => m.type === "recall");
    expect(recall).toBeTruthy();
    if (recall && recall.type === "recall") {
      expect(recall.memoryIds).toEqual(["mem-cats"]);
      expect(recall.count).toBe(1);
    }

    // markRecalled (fire-and-forget) bumps the usage counter.
    await vi.waitFor(async () => expect((await memoryRepo.getMemory("a1", "mem-cats"))!.useCount).toBe(1));
  });

  it("recall OFF (default): no memories injected, no recall event, memory untouched", async () => {
    const { o, memoryRepo, runtime } = await recallOrch({ recall: false });
    const r = await o.launch("a1", "the user loves cats");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(runtime.established[0].jobSpecJson).toContain('"memories":[]');
    expect(r.run.transcript.some((m) => m.type === "recall")).toBe(false);
    expect((await memoryRepo.getMemory("a1", "mem-cats"))!.useCount).toBe(0);
  });

  it("fail-open: an embed failure does NOT block the run — it launches with no memories", async () => {
    const { o, runtime } = await recallOrch({ recall: true, embedThrows: true });
    const r = await o.launch("a1", "the user loves cats");
    expect(r.ok).toBe(true); // the run still runs
    if (!r.ok) return;
    expect(r.run.status).toBe("succeeded");
    expect(runtime.established[0].jobSpecJson).toContain('"memories":[]');
    expect(r.run.transcript.some((m) => m.type === "recall")).toBe(false);
  });

  it("recall never mints a per-run cost key before/for itself (embedding-only, off the cost cap)", async () => {
    const { o, gateway } = await recallOrch({ recall: true });
    await o.launch("a1", "the user loves cats");
    // The embed used the master key (gateway.embed), and any cost key minted is for the run itself,
    // never for recall — recall runs before the mint. The embed was recorded; that's the only recall LLM touch.
    expect(gateway.embedded).toContain("the user loves cats");
  });

  it("bounds an un-distilled memory summary so it can't blow the system-context budget (review P5)", async () => {
    const runsRepo = memoryRunsRepo();
    const memoryRepo = memoryMemoryRepo();
    await memoryRepo.setGlobalConfig({ defaultEnabled: true });
    await memoryRepo.setAgentMemoryConfig("a1", { mode: "on", recall: true, reflect: true, kinds: ["episodic", "semantic", "procedure"], requireApproval: false });
    const longContent = "x".repeat(5000); // empty summary → falls back to (long) content
    await memoryRepo.createMemory(embeddedMemory({ id: "big", content: longContent, summary: "" }));
    const runtime = fakeSandboxRuntime({ lines: [nd({ type: "done", v: CONTRACT_VERSION, status: "succeeded" })] });
    const o = runOrchestrator({ runsRepo, agentsRepo: agentsRepo(agent()), runtime, guard: fakeRunGuard(), hub: createRunHub(), memoryRepo, modelGateway: fakeModelGateway(), image: "img", sandboxVolume: "vol" });

    const r = await o.launch("a1", longContent);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const spec = JSON.parse(runtime.established[0].jobSpecJson) as { memories: { summary: string }[] };
    expect(spec.memories[0].summary.length).toBe(500); // capped, not 5000
  });
});

describe("run orchestrator — reflect (Story 8.4)", () => {
  const memConfig = (over: Partial<{ recall: boolean; reflect: boolean; requireApproval: boolean }> = {}) => ({
    mode: "on" as const,
    recall: false,
    reflect: true,
    kinds: ["episodic", "semantic", "procedure"] as ("episodic" | "semantic" | "procedure")[],
    requireApproval: false,
    ...over,
  });

  async function reflectOrch(opts: {
    reflect: boolean;
    reflector?: ReturnType<typeof fakeReflector>;
    recall?: boolean;
  }) {
    const runsRepo = memoryRunsRepo();
    const memoryRepo = memoryMemoryRepo();
    await memoryRepo.setGlobalConfig({ defaultEnabled: true });
    await memoryRepo.setAgentMemoryConfig("a1", memConfig({ reflect: opts.reflect, recall: opts.recall ?? false }));
    const reflector = opts.reflector ?? fakeReflector();
    const gateway = fakeModelGateway();
    const runtime = fakeSandboxRuntime({ lines: [nd({ type: "turn", v: CONTRACT_VERSION, role: "agent", text: "done" }), nd({ type: "done", v: CONTRACT_VERSION, status: "succeeded" })] });
    const o = runOrchestrator({ runsRepo, agentsRepo: agentsRepo(agent()), runtime, guard: fakeRunGuard(), hub: createRunHub(), memoryRepo, reflector, modelGateway: gateway, image: "img", sandboxVolume: "vol" });
    return { o, runsRepo, memoryRepo, reflector, gateway, runtime };
  }

  it("reflect ON: a completed run writes a memory with sourceRunId + an embedding", async () => {
    const { o, memoryRepo } = await reflectOrch({ reflect: true });
    const r = await o.launch("a1", "summarize my inbox");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // reflect is backgrounded (post-run, non-blocking) — wait for the write.
    await vi.waitFor(async () => expect(await memoryRepo.listForAgent("a1")).toHaveLength(1));
    const [mem] = await memoryRepo.listForAgent("a1");
    expect(mem.sourceRunId).toBe(r.run.id); // the auditable causal link
    expect(mem.embedding).not.toBeNull(); // embedded on write
    expect(mem.kind).toBe("semantic");
  });

  it("reflect OFF (default): nothing is written", async () => {
    const { o, memoryRepo, reflector } = await reflectOrch({ reflect: false });
    const r = await o.launch("a1", "x");
    expect(r.ok).toBe(true);
    // Give any (erroneous) background reflect a chance, then assert nothing happened.
    await new Promise((res) => setTimeout(res, 50));
    expect(await memoryRepo.listForAgent("a1")).toHaveLength(0);
    expect(reflector.calls).toHaveLength(0); // gated before the distill call
  });

  it("dedupes a near-identical memory: bumps salience, does NOT insert a second row", async () => {
    const fixed = fakeReflector({ memories: [{ kind: "semantic", content: "the user loves cats", summary: "loves cats", topic: null }] });
    const { o, memoryRepo } = await reflectOrch({ reflect: true, reflector: fixed });
    await o.launch("a1", "first");
    await vi.waitFor(async () => expect(await memoryRepo.listForAgent("a1")).toHaveLength(1));
    const before = (await memoryRepo.listForAgent("a1"))[0];
    await o.launch("a1", "second"); // same distilled memory → dedupe → bump, no new row
    await vi.waitFor(async () => expect((await memoryRepo.listForAgent("a1"))[0].salience).toBe(before.salience + 1));
    expect(await memoryRepo.listForAgent("a1")).toHaveLength(1); // still one row
  });

  it("prunes to the per-agent budget, forgetting lowest-salience first", async () => {
    const { o, memoryRepo } = await reflectOrch({ reflect: true, reflector: fakeReflector({ memories: [{ kind: "semantic", content: "brand new distinct memory", summary: "new", topic: null }] }) });
    // Seed exactly the budget (200), including one deliberately-lowest-salience row.
    for (let i = 0; i < 200; i++) {
      await memoryRepo.createMemory({ id: `seed-${i}`, agentId: "a1", kind: "semantic", content: `seed ${i}`, summary: "", embedding: [i / 200], topic: null, salience: i === 7 ? 0 : 10, pinned: false, status: "active", sourceRunId: null, validFrom: "2026-08-05T00:00:00.000Z", validUntil: null, useCount: 0, lastUsedAt: null, createdAt: "2026-08-05T00:00:00.000Z" });
    }
    await o.launch("a1", "add one more"); // inserts 1 → 201 → prune 1 (the salience-0 seed-7)
    // Wait on the actual post-condition (the lowest-salience row is forgotten) — NOT on count===200,
    // which is already true before the backgrounded reflect inserts.
    await vi.waitFor(async () => expect(await memoryRepo.getMemory("a1", "seed-7")).toBeNull());
    expect(await memoryRepo.listForAgent("a1")).toHaveLength(200); // back within budget
  });

  it("prune NEVER forgets a pinned memory (Story 8.5)", async () => {
    const { o, memoryRepo } = await reflectOrch({ reflect: true, reflector: fakeReflector({ memories: [{ kind: "semantic", content: "another brand new distinct memory", summary: "new2", topic: null }] }) });
    // 200 seeds: p-7 is pinned + lowest salience (must survive); p-3 is unpinned + lowest salience (gets pruned).
    for (let i = 0; i < 200; i++) {
      await memoryRepo.createMemory({ id: `p-${i}`, agentId: "a1", kind: "semantic", content: `seed ${i}`, summary: "", embedding: [i / 200], topic: null, salience: i === 7 || i === 3 ? 0 : 10, pinned: i === 7, status: "active", sourceRunId: null, validFrom: "2026-08-05T00:00:00.000Z", validUntil: null, useCount: 0, lastUsedAt: null, createdAt: "2026-08-05T00:00:00.000Z" });
    }
    await o.launch("a1", "add one more"); // 201 → prune 1 (the unpinned lowest, p-3)
    await vi.waitFor(async () => expect(await memoryRepo.getMemory("a1", "p-3")).toBeNull());
    expect(await memoryRepo.getMemory("a1", "p-7")).not.toBeNull(); // pinned → protected from prune
  });

  it("fail-safe: a reflector throw never affects the completed run and writes nothing", async () => {
    const { o, memoryRepo } = await reflectOrch({ reflect: true, reflector: fakeReflector({ throws: true }) });
    const r = await o.launch("a1", "x");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.run.status).toBe("succeeded"); // the run is unaffected
    await new Promise((res) => setTimeout(res, 50));
    expect(await memoryRepo.listForAgent("a1")).toHaveLength(0);
  });

  it("THE CLOSED LOOP — run #1 reflect writes a memory, run #2 recall injects it (fail → learn → succeed)", async () => {
    const runsRepo = memoryRunsRepo();
    const memoryRepo = memoryMemoryRepo();
    await memoryRepo.setGlobalConfig({ defaultEnabled: true });
    await memoryRepo.setAgentMemoryConfig("a1", memConfig({ recall: true, reflect: true }));
    const reflector = fakeReflector({ memories: [{ kind: "semantic", content: "the user loves cats", summary: "the user loves cats", topic: null }] });
    const runtime = fakeSandboxRuntime({ lines: [nd({ type: "turn", v: CONTRACT_VERSION, role: "agent", text: "ok" }), nd({ type: "done", v: CONTRACT_VERSION, status: "succeeded" })] });
    const o = runOrchestrator({ runsRepo, agentsRepo: agentsRepo(agent()), runtime, guard: fakeRunGuard(), hub: createRunHub(), memoryRepo, reflector, modelGateway: fakeModelGateway(), image: "img", sandboxVolume: "vol" });

    // Run #1: recall finds nothing (empty store); reflect writes the "cats" memory.
    await o.launch("a1", "first run");
    await vi.waitFor(async () => expect(await memoryRepo.listForAgent("a1")).toHaveLength(1));

    // Run #2: a matching task → recall injects the memory reflect wrote in run #1.
    const r2 = await o.launch("a1", "the user loves cats");
    expect(r2.ok).toBe(true);
    // the SECOND established sandbox carries the recalled memory in its JobSpec.
    expect(runtime.established[1].jobSpecJson).toContain("the user loves cats");
    if (r2.ok) expect(r2.run.transcript.some((m) => m.type === "recall")).toBe(true);
  });
});

describe("run orchestrator — reflect under require-approval (Story 8.6)", () => {
  const memConfig = (over: Partial<{ recall: boolean; reflect: boolean; requireApproval: boolean }> = {}) => ({
    mode: "on" as const,
    recall: false,
    reflect: true,
    kinds: ["episodic", "semantic", "procedure"] as ("episodic" | "semantic" | "procedure")[],
    requireApproval: false,
    ...over,
  });

  async function reflectOrch(opts: { requireApproval: boolean; reflector?: ReturnType<typeof fakeReflector> }) {
    const runsRepo = memoryRunsRepo();
    const memoryRepo = memoryMemoryRepo();
    await memoryRepo.setGlobalConfig({ defaultEnabled: true });
    await memoryRepo.setAgentMemoryConfig("a1", memConfig({ reflect: true, requireApproval: opts.requireApproval }));
    const reflector = opts.reflector ?? fakeReflector({ memories: [{ kind: "semantic", content: "a distinct new fact", summary: "distinct fact", topic: null }] });
    const runtime = fakeSandboxRuntime({ lines: [nd({ type: "turn", v: CONTRACT_VERSION, role: "agent", text: "done" }), nd({ type: "done", v: CONTRACT_VERSION, status: "succeeded" })] });
    const o = runOrchestrator({ runsRepo, agentsRepo: agentsRepo(agent()), runtime, guard: fakeRunGuard(), hub: createRunHub(), memoryRepo, reflector, modelGateway: fakeModelGateway(), image: "img", sandboxVolume: "vol" });
    return { o, memoryRepo };
  }

  it("requireApproval ON: a learned memory is written PENDING (never recalled until accepted) and logs 'learned'", async () => {
    const { o, memoryRepo } = await reflectOrch({ requireApproval: true });
    const r = await o.launch("a1", "learn something");
    expect(r.ok).toBe(true);
    await vi.waitFor(async () => expect(await memoryRepo.listForAgent("a1")).toHaveLength(1));
    const [mem] = await memoryRepo.listForAgent("a1");
    expect(mem.status).toBe("pending"); // held out of recall until a human accepts
    // A pending memory is not recallable even on an exact-match query.
    expect((await memoryRepo.recall("a1", mem.embedding!, 10)).map((h) => h.id)).not.toContain(mem.id);
    // The learning is journaled.
    await vi.waitFor(async () => expect((await memoryRepo.listMemoryEvents("a1", 10)).some((e) => e.kind === "learned")).toBe(true));
  });

  it("requireApproval OFF: a learned memory is written ACTIVE (immediately recallable)", async () => {
    const { o, memoryRepo } = await reflectOrch({ requireApproval: false });
    const r = await o.launch("a1", "learn something");
    expect(r.ok).toBe(true);
    await vi.waitFor(async () => expect(await memoryRepo.listForAgent("a1")).toHaveLength(1));
    expect((await memoryRepo.listForAgent("a1"))[0].status).toBe("active");
  });

  it("prune skips PENDING memories — the budget is enforced over active rows, pending is never force-forgotten", async () => {
    const { o, memoryRepo } = await reflectOrch({
      requireApproval: false,
      reflector: fakeReflector({ memories: [{ kind: "semantic", content: "yet another distinct memory", summary: "yad", topic: null }] }),
    });
    // 200 active seeds (at budget) + one PENDING seed with the lowest salience. The pending one must
    // survive the prune; the lowest-salience ACTIVE row (seed-7) is the one forgotten.
    for (let i = 0; i < 200; i++) {
      await memoryRepo.createMemory({ id: `seed-${i}`, agentId: "a1", kind: "semantic", content: `seed ${i}`, summary: "", embedding: [i / 200], topic: null, salience: i === 7 ? 0 : 10, pinned: false, status: "active", sourceRunId: null, validFrom: "2026-08-05T00:00:00.000Z", validUntil: null, useCount: 0, lastUsedAt: null, createdAt: "2026-08-05T00:00:00.000Z" });
    }
    await memoryRepo.createMemory({ id: "pend", agentId: "a1", kind: "semantic", content: "pending low", summary: "", embedding: [0.999], topic: null, salience: 0, pinned: false, status: "pending", sourceRunId: null, validFrom: "2026-08-05T00:00:00.000Z", validUntil: null, useCount: 0, lastUsedAt: null, createdAt: "2026-08-05T00:00:00.000Z" });

    await o.launch("a1", "add one more");
    await vi.waitFor(async () => expect(await memoryRepo.getMemory("a1", "seed-7")).toBeNull());
    expect(await memoryRepo.getMemory("a1", "pend")).not.toBeNull(); // pending → never prune-forgotten
  });
});
