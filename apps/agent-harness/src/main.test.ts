import { describe, it, expect } from "vitest";
import { readJobSpec, opOutcome, toolRecord } from "./main.js";
import { CONTRACT_VERSION, type GuardConnectionResponse, type ToolCallResponse } from "@turanga/contracts";

describe("agent-harness", () => {
  it("parses a valid job spec (connections + memories default to [])", () => {
    const spec = { v: CONTRACT_VERSION, runId: "r", agentId: "a", model: "m", instructions: "", skills: [], taskInput: "" };
    const parsed = readJobSpec(spec);
    expect(parsed.runId).toBe("r");
    expect(parsed.connections).toEqual([]);
    expect(parsed.memories).toEqual([]); // Story 8.3 — a spec without recall carries no memories
  });

  it("reads recalled memories from the spec (Story 8.3 — folded into system context at run time)", () => {
    const spec = { v: CONTRACT_VERSION, runId: "r", agentId: "a", model: "m", instructions: "", skills: [], taskInput: "", memories: [{ id: "m1", kind: "semantic", summary: "the user prefers concise replies" }] };
    const parsed = readJobSpec(spec);
    expect(parsed.memories).toEqual([{ id: "m1", kind: "semantic", summary: "the user prefers concise replies" }]);
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

  it("parses a job spec with granted tools (Story 6.4)", () => {
    const spec = { v: CONTRACT_VERSION, runId: "r", agentId: "a", model: "m", instructions: "", skills: [], tools: [{ id: "t1", name: "Weather", operations: ["get_time"] }], taskInput: "" };
    expect(readJobSpec(spec).tools).toEqual([{ id: "t1", name: "Weather", operations: ["get_time"] }]);
  });

  it("toolRecord: a successful call emits a `tool` record (outcome ok) + a context note (Story 6.5)", () => {
    const ok: ToolCallResponse = { v: CONTRACT_VERSION, ok: true, content: [{ type: "text", text: "ok" }], isError: false, latencyMs: 12 };
    const rec = toolRecord("t1", "Weather", "get_time", ok);
    expect(rec.message).toEqual({ type: "tool", v: CONTRACT_VERSION, toolId: "t1", toolName: "Weather", operation: "get_time", outcome: "ok", latencyMs: 12 });
    expect(rec.system).toBe("Called get_time.");
  });

  it("toolRecord: a tool-execution error → outcome error, still a context note (Story 6.5)", () => {
    const errored: ToolCallResponse = { v: CONTRACT_VERSION, ok: true, content: [], isError: true, latencyMs: 5 };
    const rec = toolRecord("t1", "Weather", "get_time", errored);
    expect(rec.message).toMatchObject({ type: "tool", outcome: "error", latencyMs: 5 });
    expect(rec.system).toMatch(/the tool reported an error/);
  });

  it("toolRecord: a refusal → outcome refused with the detail, NO context note (Story 6.5, AC1)", () => {
    const refused: ToolCallResponse = { v: CONTRACT_VERSION, ok: false, refusal: { kind: "permission", detail: "Blocked — operation isn't granted." }, latencyMs: 1 };
    const rec = toolRecord("t1", "Weather", "get_time", refused);
    expect(rec.message).toEqual({ type: "tool", v: CONTRACT_VERSION, toolId: "t1", toolName: "Weather", operation: "get_time", outcome: "refused", latencyMs: 1, detail: "Blocked — operation isn't granted." });
    expect(rec.system).toBeUndefined();
  });

  it("toolRecord: a transport error → outcome error with the detail; latency defaults to 0 (Story 6.5)", () => {
    const res: ToolCallResponse = { v: CONTRACT_VERSION, ok: false, error: "Can't reach the guard." };
    const rec = toolRecord("t1", "Weather", "get_time", res);
    expect(rec.message).toMatchObject({ type: "tool", outcome: "error", latencyMs: 0, detail: "Can't reach the guard." });
    expect(rec.system).toBeUndefined();
  });
});
