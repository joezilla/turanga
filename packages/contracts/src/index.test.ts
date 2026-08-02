import { describe, it, expect } from "vitest";
import { JobSpecSchema, ControlChannelMessageSchema, GuardConnectionRequestSchema, GuardConnectionResponseSchema, CONTRACT_VERSION } from "./index.js";

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

  it("connection request: a logical read op (no URL/token)", () => {
    const req = GuardConnectionRequestSchema.parse({ v: CONTRACT_VERSION, runId: "r1", connectionId: "gmail", op: "gmail.list", params: { maxResults: 5 } });
    expect(req.op).toBe("gmail.list");
    // an unknown op is rejected (the harness can only name the vocabulary)
    expect(GuardConnectionRequestSchema.safeParse({ v: CONTRACT_VERSION, runId: "r1", connectionId: "gmail", op: "gmail.send" }).success).toBe(false);
  });

  it("connection response: carries data on ok, a refusal on deny", () => {
    expect(GuardConnectionResponseSchema.parse({ v: CONTRACT_VERSION, ok: true, data: { count: 3 } }).ok).toBe(true);
    const refused = GuardConnectionResponseSchema.parse({ v: CONTRACT_VERSION, ok: false, refusal: { destination: "gmail.googleapis.com", detail: "Blocked egress to gmail.googleapis.com — not on this agent's allowlist." } });
    expect(refused.refusal?.destination).toBe("gmail.googleapis.com");
  });
});
