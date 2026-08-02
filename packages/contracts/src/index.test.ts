import { describe, it, expect } from "vitest";
import { JobSpecSchema, ControlChannelMessageSchema, GuardConnectionRequestSchema, GuardConnectionResponseSchema, GuardRunEventSchema, authorizes, SKILL_OPS, OP_REQUIREMENTS, CONTRACT_VERSION } from "./index.js";

describe("contracts", () => {
  it("job spec round-trips (with logical connection handles)", () => {
    const spec = {
      v: CONTRACT_VERSION,
      runId: "r1",
      agentId: "a1",
      model: "openai/gpt-4o",
      instructions: "hi",
      skills: ["read-search"],
      connections: [{ id: "gmail", provider: "gmail" as const }],
      taskInput: "go",
    };
    expect(JobSpecSchema.parse(spec)).toEqual(spec);
  });

  it("defaults connections to [] when omitted (older construction stays valid)", () => {
    const spec = { v: CONTRACT_VERSION, runId: "r1", agentId: "a1", model: "m", instructions: "", skills: [], taskInput: "" };
    expect(JobSpecSchema.parse(spec).connections).toEqual([]);
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
