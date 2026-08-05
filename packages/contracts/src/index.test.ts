import { describe, it, expect } from "vitest";
import { JobSpecSchema, JobToolSchema, JobMemorySchema, JobHistoryTurnSchema, ToolCallRequestSchema, ToolCallResponseSchema, ControlChannelMessageSchema, GuardConnectionRequestSchema, GuardConnectionResponseSchema, GuardRunEventSchema, authorizes, SKILL_OPS, OP_REQUIREMENTS, CONTRACT_VERSION } from "./index.js";

describe("contracts", () => {
  it("contract version is 8 (Story 9.1 — chat / JobSpec.history)", () => {
    expect(CONTRACT_VERSION).toBe(8);
  });

  it("job spec round-trips (with logical connection + tool handles + recalled memories + chat history)", () => {
    const spec = {
      v: CONTRACT_VERSION,
      runId: "r1",
      agentId: "a1",
      model: "openai/gpt-4o",
      instructions: "hi",
      skills: ["read-search"],
      connections: [{ id: "gmail", provider: "gmail" as const }],
      tools: [{ id: "t1", name: "weather", operations: ["get_weather"] }],
      memories: [{ id: "m1", kind: "semantic" as const, summary: "the user prefers concise replies" }],
      history: [
        { role: "user" as const, content: "what's the weather?" },
        { role: "agent" as const, content: "clear skies" },
      ],
      taskInput: "go",
    };
    expect(JobSpecSchema.parse(spec)).toEqual(spec);
  });

  it("defaults connections + tools + memories + history to [] when omitted (older construction stays valid)", () => {
    const spec = { v: CONTRACT_VERSION, runId: "r1", agentId: "a1", model: "m", instructions: "", skills: [], taskInput: "" };
    const parsed = JobSpecSchema.parse(spec);
    expect(parsed.connections).toEqual([]);
    expect(parsed.tools).toEqual([]);
    expect(parsed.memories).toEqual([]);
    expect(parsed.history).toEqual([]);
  });

  it("JobMemory is secret-free — id/kind/summary only; extra keys stripped (AD-10)", () => {
    const m = JobMemorySchema.parse({ id: "m1", kind: "semantic", summary: "learned X" });
    expect(Object.keys(m).sort()).toEqual(["id", "kind", "summary"]);
    const stripped = JobMemorySchema.parse({ id: "m1", kind: "semantic", summary: "s", embedding: [0.1], token: "secret" } as unknown as { id: string; kind: "semantic"; summary: string });
    expect(JSON.stringify(stripped)).not.toContain("secret");
    expect(JSON.stringify(stripped)).not.toContain("embedding");
    // an unknown kind is rejected
    expect(JobMemorySchema.safeParse({ id: "m", kind: "made-up", summary: "s" }).success).toBe(false);
  });

  it("JobHistoryTurn is secret-free — role/content only; extra keys stripped (Story 9.1, AD-10)", () => {
    const t = JobHistoryTurnSchema.parse({ role: "user", content: "hi" });
    expect(Object.keys(t).sort()).toEqual(["content", "role"]);
    // an extra key (a leaked secret) is stripped — never reaches the sandbox
    const stripped = JobHistoryTurnSchema.parse({ role: "agent", content: "reply", token: "secret" } as unknown as { role: "agent"; content: string });
    expect(JSON.stringify(stripped)).not.toContain("secret");
    // an unknown role is rejected (the thread only carries user/agent turns)
    expect(JobHistoryTurnSchema.safeParse({ role: "system", content: "x" }).success).toBe(false);
  });

  it("parses a `recall` transcript event (Story 8.3) — memory ids + count, no cost", () => {
    const msg = ControlChannelMessageSchema.parse({ type: "recall", v: CONTRACT_VERSION, memoryIds: ["m1", "m2"], count: 2 });
    expect(msg.type).toBe("recall");
    if (msg.type === "recall") {
      expect(msg.memoryIds).toEqual(["m1", "m2"]);
      expect(msg.count).toBe(2);
      expect(msg).not.toHaveProperty("costMicros");
    }
  });

  it("JobTool: a logical handle carries only id/name/operations — no endpoint URL or credential (AD-10)", () => {
    const t = JobToolSchema.parse({ id: "t1", name: "weather", operations: ["get_weather"] });
    expect(Object.keys(t).sort()).toEqual(["id", "name", "operations"]);
    // extra endpoint/secret keys are stripped by the schema (never reach the sandbox)
    const stripped = JobToolSchema.parse({ id: "t1", name: "w", operations: [], url: "https://x", token: "secret" } as unknown as { id: string; name: string; operations: string[] });
    expect(JSON.stringify(stripped)).not.toContain("secret");
    expect(JSON.stringify(stripped)).not.toContain("https://x");
  });

  it("tool call request/response round-trip (maps to MCP tools/call; refusal + isError distinct)", () => {
    const req = ToolCallRequestSchema.parse({ v: CONTRACT_VERSION, runId: "r1", toolId: "t1", operation: "get_weather", arguments: { location: "NYC" } });
    expect(req.operation).toBe("get_weather");
    // a successful call with a tool-execution error (MCP isError inside a 200)
    const ok = ToolCallResponseSchema.parse({ v: CONTRACT_VERSION, ok: true, content: [{ type: "text", text: "boom" }], isError: true });
    expect(ok.isError).toBe(true);
    // a Guard denial is a refusal (distinct from isError)
    const refused = ToolCallResponseSchema.parse({ v: CONTRACT_VERSION, ok: false, refusal: { kind: "permission", detail: "operation not granted" } });
    expect(refused.refusal?.kind).toBe("permission");
  });

  it("rejects a wrong contract version", () => {
    const bad = { v: 999, runId: "r1", agentId: "a1", model: "m", instructions: "", skills: [], taskInput: "" };
    expect(JobSpecSchema.safeParse(bad).success).toBe(false);
  });

  it("parses a control-channel done message", () => {
    const msg = ControlChannelMessageSchema.parse({ type: "done", v: CONTRACT_VERSION, status: "succeeded" });
    expect(msg.type).toBe("done");
  });

  it("parses a structured `tool` invocation record (Story 6.5) — all three outcomes, no cost field", () => {
    for (const outcome of ["ok", "error", "refused"] as const) {
      const msg = ControlChannelMessageSchema.parse({ type: "tool", v: CONTRACT_VERSION, toolId: "t1", toolName: "Weather", operation: "get_time", outcome, latencyMs: 12, detail: outcome === "ok" ? undefined : "why" });
      expect(msg.type).toBe("tool");
      if (msg.type === "tool") {
        expect(msg.outcome).toBe(outcome);
        expect(msg.latencyMs).toBe(12);
        // observed only (AC2): a tool record carries no cost.
        expect(msg).not.toHaveProperty("costMicros");
      }
    }
    // a v5 tool message is rejected by the current (v7) schema — mixed-version guard.
    expect(ControlChannelMessageSchema.safeParse({ type: "tool", v: 5, toolId: "t1", toolName: "W", operation: "x", outcome: "ok", latencyMs: 1 }).success).toBe(false);
  });

  it("connection request: a provider-agnostic op (no URL/token)", () => {
    const req = GuardConnectionRequestSchema.parse({ v: CONTRACT_VERSION, runId: "r1", connectionId: "gmail", op: "read", params: { maxResults: 5 } });
    expect(req.op).toBe("read");
    // an unknown op is rejected (the harness can only name the vocabulary)
    expect(GuardConnectionRequestSchema.safeParse({ v: CONTRACT_VERSION, runId: "r1", connectionId: "gmail", op: "delete" }).success).toBe(false);
  });

  it("connection response: carries data on ok, a kinded refusal on deny", () => {
    expect(GuardConnectionResponseSchema.parse({ v: CONTRACT_VERSION, ok: true, data: { count: 3 } }).ok).toBe(true);
    const refused = GuardConnectionResponseSchema.parse({ v: CONTRACT_VERSION, ok: false, refusal: { destination: "gmail.googleapis.com", detail: "Blocked send — …", kind: "permission" } });
    expect(refused.refusal?.kind).toBe("permission");
  });

  it("authorizes: the skill-scope + send-gate truth table (FR-3/FR-18)", () => {
    // read needs ≥read; label needs read-write; send needs read-write AND the send grant.
    expect(authorizes([{ scope: "read", send: false }], "read")).toBe(true);
    expect(authorizes([{ scope: "none", send: false }], "read")).toBe(false);
    expect(authorizes([{ scope: "read", send: false }], "label")).toBe(false); // read < read-write
    expect(authorizes([{ scope: "read-write", send: false }], "label")).toBe(true);
    expect(authorizes([{ scope: "read-write", send: false }], "send")).toBe(false); // no send grant
    expect(authorizes([{ scope: "read-write", send: true }], "send")).toBe(true);
    // a send-capable but read-scoped grant can't authorize send (needs read-write too)
    expect(authorizes([{ scope: "read", send: true }], "send")).toBe(false);
    // default-deny: no grants authorizes nothing
    expect(authorizes([], "read")).toBe(false);
  });

  it("policy tables: each built-in skill maps to ops with defined requirements", () => {
    expect(SKILL_OPS["read-search"]).toEqual(["read"]);
    expect(SKILL_OPS["draft-reply"]).toEqual(["send"]);
    for (const ops of Object.values(SKILL_OPS)) for (const op of ops) expect(OP_REQUIREMENTS[op]).toBeTruthy();
  });

  it("metrics carries costMicros; the Guard→orchestrator event channel parses metrics + kill", () => {
    const m = ControlChannelMessageSchema.parse({ type: "metrics", v: CONTRACT_VERSION, latencyMs: 428, tokens: 1284, costMicros: 4100 });
    expect(m.type === "metrics" && m.costMicros).toBe(4100);
    expect(GuardRunEventSchema.parse({ type: "metrics", v: CONTRACT_VERSION, latencyMs: 1, tokens: 2, costMicros: 3 }).type).toBe("metrics");
    const kill = GuardRunEventSchema.parse({ type: "kill", v: CONTRACT_VERSION, scope: "run" });
    expect(kill.type === "kill" && kill.scope).toBe("run");
    expect(GuardRunEventSchema.safeParse({ type: "kill", v: CONTRACT_VERSION, scope: "week" }).success).toBe(false);
  });
});
