import { describe, it, expect } from "vitest";
import { readJobSpec, opOutcome } from "./main.js";
import { CONTRACT_VERSION, type GuardConnectionResponse } from "@turanga/contracts";

describe("agent-harness", () => {
  it("parses a valid job spec (connections default to [])", () => {
    const spec = { v: CONTRACT_VERSION, runId: "r", agentId: "a", model: "m", instructions: "", skills: [], taskInput: "" };
    const parsed = readJobSpec(spec);
    expect(parsed.runId).toBe("r");
    expect(parsed.connections).toEqual([]);
  });

  it("opOutcome: a successful read folds a summary into the model context", () => {
    const res: GuardConnectionResponse = { v: CONTRACT_VERSION, ok: true, data: { messageCount: 3 } };
    const out = opOutcome("read", res);
    expect(out.refusal).toBeUndefined();
    expect(out.system).toMatch(/3 message/);
  });

  it("opOutcome: a refusal relays the Guard's kind (permission vs egress)", () => {
    const permission: GuardConnectionResponse = { v: CONTRACT_VERSION, ok: false, refusal: { destination: "", detail: "Blocked send — … Allow send …", kind: "permission" } };
    expect(opOutcome("send", permission).refusal).toEqual({ type: "refusal", v: CONTRACT_VERSION, kind: "permission", detail: permission.refusal!.detail });

    const egress: GuardConnectionResponse = { v: CONTRACT_VERSION, ok: false, refusal: { destination: "gmail.googleapis.com", detail: "Blocked egress …", kind: "egress" } };
    expect(opOutcome("read", egress).refusal).toEqual({ type: "refusal", v: CONTRACT_VERSION, kind: "egress", detail: egress.refusal!.detail });
  });

  it("opOutcome: a plain (non-refusal) error is non-fatal — nothing emitted, run proceeds", () => {
    const res: GuardConnectionResponse = { v: CONTRACT_VERSION, ok: false, error: "Can't reach the guard." };
    expect(opOutcome("read", res)).toEqual({});
  });
});
