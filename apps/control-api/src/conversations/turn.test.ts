import { describe, it, expect, vi } from "vitest";
import { CONTRACT_VERSION, type ControlChannelMessage } from "@turanga/contracts";
import { runOrchestrator } from "../runs/orchestrator.js";
import { memoryRunsRepo } from "../runs/repo.js";
import { fakeSandboxRuntime } from "../runs/runtime.js";
import { fakeRunGuard } from "../runs/guardClient.js";
import { createRunHub } from "../runs/hub.js";
import { fakeModelGateway } from "../litellm/gateway.js";
import { memoryConversationsRepo } from "./repo.js";
import type { AgentSnapshot, AgentVersionRow } from "../agents/repo.js";
import type { Money } from "@turanga/domain";

// A chat turn (Story 9.2) is a normal run built from the conversation's PINNED published snapshot, with
// the thread so far injected as history and the run linked to the conversation. These tests assert what
// reached the sandbox (jobSpecJson) + the link, using the fake runtime.
const nd = (m: ControlChannelMessage) => JSON.stringify(m);
const now = "2026-08-05T00:00:00.000Z";

const snapshot = (over: Partial<AgentSnapshot> = {}): AgentSnapshot => ({
  name: "Chatty",
  description: "",
  model: "openai/gpt-4o",
  instructions: "you are helpful",
  variables: [],
  skills: [],
  attachedTools: [],
  costCap: { perRun: null, perDay: null },
  ...over,
});
const version = (v: number, snap: AgentSnapshot): AgentVersionRow => ({ version: v, publishedAt: now, publishedBy: null, snapshot: snap });

// A fake AgentsReader: `get` returns the DRAFT (never read on the chat path — proves we don't fall back
// to it), `listVersions` returns the published snapshots (newest first, mirroring the real repo).
function agentsRepo(versions: AgentVersionRow[]) {
  return {
    get: async () => ({ id: "a1", model: "openai/DRAFT-model", instructions: "DRAFT-INSTRUCTIONS", state: "draft" as const }),
    listVersions: async () => versions,
  };
}

function chatOrch(opts: { versions: AgentVersionRow[]; lines?: string[] }) {
  const runsRepo = memoryRunsRepo();
  const conversationsRepo = memoryConversationsRepo();
  const runtime = fakeSandboxRuntime({
    lines: opts.lines ?? [nd({ type: "turn", v: CONTRACT_VERSION, role: "user", text: "USER-MSG" }), nd({ type: "turn", v: CONTRACT_VERSION, role: "agent", text: "AGENT-REPLY" }), nd({ type: "done", v: CONTRACT_VERSION, status: "succeeded" })],
  });
  const gateway = fakeModelGateway();
  const o = runOrchestrator({ runsRepo, agentsRepo: agentsRepo(opts.versions), conversationsRepo, runtime, guard: fakeRunGuard(), hub: createRunHub(), modelGateway: gateway, image: "img", sandboxVolume: "vol" });
  return { o, runsRepo, conversationsRepo, runtime, gateway };
}

describe("chat turn — build from the published snapshot (Story 9.2)", () => {
  it("builds the run from the PINNED snapshot (not the draft), links it, injects no history on turn 0", async () => {
    const { o, conversationsRepo, runtime, gateway } = chatOrch({
      versions: [version(1, snapshot({ model: "openai/snapshot-model", instructions: "SNAPSHOT-INSTRUCTIONS", costCap: { perRun: { minor: 50, currency: "USD" } as Money, perDay: null } }))],
    });
    await conversationsRepo.create({ id: "conv-1", agentId: "a1", publishedVersion: 1, title: "", createdAt: now });

    const r = await o.startChatTurn("conv-1", "what's the weather?");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The run is linked to the conversation as turn 0.
    expect(r.run).toMatchObject({ conversationId: "conv-1", turnIndex: 0 });

    await vi.waitFor(() => expect(runtime.established).toHaveLength(1));
    const spec = JSON.parse(runtime.established[0].jobSpecJson);
    expect(spec.model).toBe("openai/snapshot-model"); // the snapshot, NOT the draft's openai/DRAFT-model
    expect(spec.instructions).toBe("SNAPSHOT-INSTRUCTIONS");
    expect(spec.history).toEqual([]); // turn 0 — nothing prior
    expect(spec.taskInput).toBe("what's the weather?");
    // The published version's cost cap flows to the per-run cost key (kill-on-breach unchanged).
    await vi.waitFor(() => expect(gateway.mintedKeys).toHaveLength(1));
    expect(gateway.mintedKeys[0].perRunCap).toEqual({ minor: 50, currency: "USD" });
  });

  it("turn 1 injects turn 0's thread into history (the reply is in the context)", async () => {
    const { o, runsRepo, conversationsRepo, runtime } = chatOrch({ versions: [version(1, snapshot())] });
    await conversationsRepo.create({ id: "conv-1", agentId: "a1", publishedVersion: 1, title: "", createdAt: now });

    // Turn 0 — let it fully complete + persist its transcript.
    const r0 = await o.startChatTurn("conv-1", "hi");
    expect(r0.ok).toBe(true);
    if (!r0.ok) return;
    await vi.waitFor(async () => expect((await runsRepo.get(r0.run.id))?.status).toBe("succeeded"));

    // Turn 1 — its jobSpec carries turn 0's user + agent turns as history, in order.
    const r1 = await o.startChatTurn("conv-1", "and tomorrow?");
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.run.turnIndex).toBe(1);
    await vi.waitFor(() => expect(runtime.established).toHaveLength(2));
    const spec1 = JSON.parse(runtime.established[1].jobSpecJson);
    expect(spec1.history).toEqual([
      { role: "user", content: "USER-MSG" },
      { role: "agent", content: "AGENT-REPLY" },
    ]);
  });

  it("uses the conversation's PINNED version even after the agent is republished (AC #3)", async () => {
    // listVersions returns newest-first (v2 then v1); the conversation is pinned to v1.
    const { o, conversationsRepo, runtime } = chatOrch({
      versions: [
        version(2, snapshot({ instructions: "V2-INSTRUCTIONS" })),
        version(1, snapshot({ instructions: "V1-INSTRUCTIONS" })),
      ],
    });
    await conversationsRepo.create({ id: "conv-1", agentId: "a1", publishedVersion: 1, title: "", createdAt: now });

    const r = await o.startChatTurn("conv-1", "hi");
    expect(r.ok).toBe(true);
    await vi.waitFor(() => expect(runtime.established).toHaveLength(1));
    expect(JSON.parse(runtime.established[0].jobSpecJson).instructions).toBe("V1-INSTRUCTIONS"); // pinned v1, not the newer v2
  });

  it("refuses cleanly for an unknown conversation (404) and a gone pinned version (404)", async () => {
    const { o, conversationsRepo } = chatOrch({ versions: [] }); // no versions ⇒ the pin can't resolve
    const miss = await o.startChatTurn("nope", "hi");
    expect(miss.ok).toBe(false);
    if (miss.ok) return;
    expect(miss.status).toBe(404);

    await conversationsRepo.create({ id: "conv-1", agentId: "a1", publishedVersion: 1, title: "", createdAt: now });
    const goneVersion = await o.startChatTurn("conv-1", "hi"); // pinned v1 but listVersions() is empty
    expect(goneVersion.ok).toBe(false);
    if (goneVersion.ok) return;
    expect(goneVersion.status).toBe(404);
  });

  it("bounds the injected history to the last 20 exchanges; turnIndex stays the true position (Story 9.4)", async () => {
    const { o, runsRepo, conversationsRepo, runtime } = chatOrch({ versions: [version(1, snapshot())] });
    await conversationsRepo.create({ id: "conv-1", agentId: "a1", publishedVersion: 1, title: "", createdAt: now });
    // Seed 25 prior turns (each a distinct user+agent exchange). MAX_HISTORY_RUNS = 20.
    for (let i = 0; i < 25; i++) {
      await runsRepo.create({
        id: `t${i}`,
        agentId: "a1",
        conversationId: "conv-1",
        turnIndex: i,
        status: "succeeded",
        taskInput: `USER-${i}`,
        transcript: [
          { type: "turn", v: CONTRACT_VERSION, role: "user", text: `USER-${i}` },
          { type: "turn", v: CONTRACT_VERSION, role: "agent", text: `AGENT-${i}` },
        ],
        reason: null,
        createdAt: now,
        endedAt: null,
      });
    }

    const r = await o.startChatTurn("conv-1", "next");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.run.turnIndex).toBe(25); // the TRUE position — not windowed

    await vi.waitFor(() => expect(runtime.established).toHaveLength(1));
    const history = JSON.parse(runtime.established[0].jobSpecJson).history as { role: string; content: string }[];
    // Only the last 20 runs (2 turns each) → 40 history entries; the oldest 5 exchanges are dropped.
    expect(history).toHaveLength(40);
    expect(history.some((h) => h.content === "USER-4")).toBe(false); // exchange 4 (of 0..24) is outside the last 20 → dropped
    expect(history[0]).toEqual({ role: "user", content: "USER-5" }); // the window starts at exchange 5
    expect(history.at(-1)).toEqual({ role: "agent", content: "AGENT-24" }); // …ends at the newest
  });

  it("excludes a FAILED/killed prior turn from history — no orphaned user turn (code-review fix)", async () => {
    const { o, runsRepo, conversationsRepo, runtime } = chatOrch({ versions: [version(1, snapshot())] });
    await conversationsRepo.create({ id: "conv-1", agentId: "a1", publishedVersion: 1, title: "", createdAt: now });
    // Turn 0 succeeded (a clean user+agent exchange).
    await runsRepo.create({ id: "t0", agentId: "a1", conversationId: "conv-1", turnIndex: 0, status: "succeeded", taskInput: "USER-0", transcript: [{ type: "turn", v: CONTRACT_VERSION, role: "user", text: "USER-0" }, { type: "turn", v: CONTRACT_VERSION, role: "agent", text: "AGENT-0" }], reason: null, createdAt: now, endedAt: null });
    // Turn 1 was KILLED after emitting its user turn but BEFORE any agent reply (an orphaned user turn).
    await runsRepo.create({ id: "t1", agentId: "a1", conversationId: "conv-1", turnIndex: 1, status: "killed", taskInput: "USER-1", transcript: [{ type: "turn", v: CONTRACT_VERSION, role: "user", text: "USER-1" }], reason: "Killed — per-run cost cap reached ($0.50).", createdAt: now, endedAt: null });

    const r = await o.startChatTurn("conv-1", "next");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.run.turnIndex).toBe(2); // BOTH prior turns count toward the position

    await vi.waitFor(() => expect(runtime.established).toHaveLength(1));
    const history = JSON.parse(runtime.established[0].jobSpecJson).history as { role: string; content: string }[];
    // Only turn 0's clean exchange is injected — the killed turn's orphaned user turn is dropped, so the
    // model never sees consecutive user messages (which some providers reject).
    expect(history).toEqual([
      { role: "user", content: "USER-0" },
      { role: "agent", content: "AGENT-0" },
    ]);
  });
});
