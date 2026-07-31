import { describe, it, expect } from "vitest";
import { JobSpecSchema, ControlChannelMessageSchema, CONTRACT_VERSION } from "./index.js";

describe("contracts", () => {
  it("job spec round-trips", () => {
    const spec = { v: CONTRACT_VERSION, runId: "r1", agentId: "a1", model: "openai/gpt-4o", instructions: "hi", skills: ["read-search"], taskInput: "go" };
    expect(JobSpecSchema.parse(spec)).toEqual(spec);
  });

  it("rejects a wrong contract version", () => {
    const bad = { v: 999, runId: "r1", agentId: "a1", model: "m", instructions: "", skills: [], taskInput: "" };
    expect(JobSpecSchema.safeParse(bad).success).toBe(false);
  });

  it("parses a control-channel done message", () => {
    const msg = ControlChannelMessageSchema.parse({ type: "done", v: CONTRACT_VERSION, status: "succeeded" });
    expect(msg.type).toBe("done");
  });
});
