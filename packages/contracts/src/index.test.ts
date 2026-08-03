import { describe, it, expect } from "vitest";
import { JobSpecSchema, JobToolSchema, ToolCallRequestSchema, ToolCallResponseSchema, ControlChannelMessageSchema, GuardConnectionRequestSchema, GuardConnectionResponseSchema, GuardRunEventSchema, authorizes, SKILL_OPS, OP_REQUIREMENTS, CONTRACT_VERSION } from "./index.js";

describe("contracts", () => {
  it("contract version is 5 (Story 6.1 — tools)", () => {
    expect(CONTRACT_VERSION).toBe(5);
  });

  it("job spec round-trips (with logical connection + tool handles)", () => {
    const spec = {
      v: CONTRACT_VERSION,
      runId: "r1",
      agentId: "a1",
      model: "openai/gpt-4o",
      instructions: "hi",
      skills: ["read-search"],
      connections: [{ id: "gmail", provider: "gmail" as const }],
      tools: [{ id: "t1", name: "weather", operations: ["get_weather"] }],
      taskInput: "go",
    };
    expect(JobSpecSchema.parse(spec)).toEqual(spec);
  });

  it("defaults connections + tools to [] when omitted (older construction stays valid)", () => {
    const spec = { v: CONTRACT_VERSION, runId: "r1", agentId: "a1", model: "m", instructions: "", skills: [], taskInput: "" };
    const parsed = JobSpecSchema.parse(spec);
    expect(parsed.connections).toEqual([]);
    expect(parsed.tools).toEqual([]);
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
