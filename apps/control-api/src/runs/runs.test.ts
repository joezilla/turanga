import { describe, it, expect } from "vitest";
import type { ControlChannelMessage } from "@turanga/contracts";
import { runOrchestrator } from "./orchestrator.js";
import { memoryRunsRepo } from "./repo.js";
import { fakeSandboxRuntime, resolveSandboxRuntimeKind } from "./runtime.js";
import { fakeRunGuard } from "./guardClient.js";

type Agent = { id: string; model: string | null; instructions: string; state: "draft" | "active" };
const agent = (over: Partial<Agent> = {}): Agent => ({ id: "a1", model: "openai/gpt-4o", instructions: "be nice", state: "draft", ...over });
const agentsRepo = (a: Agent | null) => ({ get: async (id: string) => (a && a.id === id ? a : null) });

const nd = (m: ControlChannelMessage) => JSON.stringify(m);

function orch(opts: { agent?: Agent; runtime?: ReturnType<typeof fakeSandboxRuntime> } = {}) {
  const runsRepo = memoryRunsRepo();
  const guard = fakeRunGuard();
  const runtime =
    opts.runtime ??
    fakeSandboxRuntime({ lines: [nd({ type: "turn", v: 1, role: "agent", text: "hi" }), nd({ type: "done", v: 1, status: "succeeded" })] });
  const o = runOrchestrator({ runsRepo, agentsRepo: agentsRepo(opts.agent ?? agent()), runtime, guard, image: "img", sandboxVolume: "vol" });
  return { o, runsRepo, guard, runtime };
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
    expect(runtime.established[0].guardSocketDir).toBe("vol"); // the sandbox binds the shared volume
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

  it("ignores malformed control lines", async () => {
    const { o } = orch({ runtime: fakeSandboxRuntime({ lines: ["not json", "{}", nd({ type: "done", v: 1, status: "succeeded" })] }) });
    const r = await o.launch("a1", "x");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.run.status).toBe("succeeded");
    expect(r.run.transcript).toHaveLength(1); // only the valid done survived
  });
});

describe("RunsRepo (memory)", () => {
  it("create/get/setStatus/appendMessage/list", async () => {
    const repo = memoryRunsRepo();
    await repo.create({ id: "r1", agentId: "a1", status: "created", taskInput: "x", transcript: [], reason: null, createdAt: new Date().toISOString(), endedAt: null });
    await repo.appendMessage("r1", { type: "turn", v: 1, role: "user", text: "hi" });
    await repo.setStatus("r1", "succeeded", { endedAt: new Date().toISOString() });
    const got = await repo.get("r1");
    expect(got?.status).toBe("succeeded");
    expect(got?.transcript).toHaveLength(1);
    expect((await repo.list("a1")).map((r) => r.id)).toEqual(["r1"]);
    expect(await repo.list("other")).toEqual([]);
  });
});

describe("resolveSandboxRuntimeKind", () => {
  it("defaults to dev-insecure, honors gvisor, refuses dev-insecure in production, rejects garbage", () => {
    expect(resolveSandboxRuntimeKind({})).toBe("dev-insecure");
    expect(resolveSandboxRuntimeKind({ SANDBOX_RUNTIME: "gvisor" })).toBe("gvisor");
    expect(() => resolveSandboxRuntimeKind({ SANDBOX_RUNTIME: "dev-insecure", NODE_ENV: "production" })).toThrow(/refused in production/);
    expect(() => resolveSandboxRuntimeKind({ SANDBOX_RUNTIME: "bogus" })).toThrow();
  });
});
