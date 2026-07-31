import { describe, it, expect } from "vitest";
import { readJobSpec } from "./main.js";
import { CONTRACT_VERSION } from "@turanga/contracts";

describe("agent-harness", () => {
  it("parses a valid job spec", () => {
    const spec = { v: CONTRACT_VERSION, runId: "r", agentId: "a", model: "m", instructions: "", skills: [], taskInput: "" };
    expect(readJobSpec(spec).runId).toBe("r");
  });
});
