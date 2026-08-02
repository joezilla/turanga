import { describe, it, expect } from "vitest";
import { readJobSpec, readOutcome } from "./main.js";
import { CONTRACT_VERSION, type JobConnection, type GuardConnectionResponse } from "@turanga/contracts";

const gmail: JobConnection = { id: "gmail", provider: "gmail" };

describe("agent-harness", () => {
  it("parses a valid job spec (connections default to [])", () => {
    const spec = { v: CONTRACT_VERSION, runId: "r", agentId: "a", model: "m", instructions: "", skills: [], taskInput: "" };
    const parsed = readJobSpec(spec);
    expect(parsed.runId).toBe("r");
    expect(parsed.connections).toEqual([]);
  });

  it("readOutcome: a successful read folds a summary into the model context", () => {
    const res: GuardConnectionResponse = { v: CONTRACT_VERSION, ok: true, data: { messageCount: 3 } };
    const out = readOutcome(gmail, res);
    expect(out.refusal).toBeUndefined();
    expect(out.system).toMatch(/3 message/);
  });

  it("readOutcome: a refusal maps to an egress refusal control message (relayed from the Guard)", () => {
    const res: GuardConnectionResponse = { v: CONTRACT_VERSION, ok: false, refusal: { destination: "gmail.googleapis.com", detail: "Blocked egress to gmail.googleapis.com — not on this agent's allowlist." } };
    const out = readOutcome(gmail, res);
    expect(out.system).toBeUndefined();
    expect(out.refusal).toEqual({ type: "refusal", v: CONTRACT_VERSION, kind: "egress", detail: res.refusal!.detail });
  });

  it("readOutcome: a plain (non-refusal) error is non-fatal — nothing emitted, run proceeds", () => {
    const res: GuardConnectionResponse = { v: CONTRACT_VERSION, ok: false, error: "Can't reach the guard." };
    expect(readOutcome(gmail, res)).toEqual({});
  });
});
