import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { CONTRACT_VERSION, GuardModelRequestSchema, type JobSpec, type ControlChannelMessage } from "@turanga/contracts";
import { runToolLoop } from "./toolLoop.js";

// A fake Guard on a real per-run Unix socket. It plays the Guard's role over the SAME HTTP-over-UDS
// protocol the real Guard uses (POST / with a JSON body; discriminate by shape): a MODEL call (has
// `messages`) returns a GuardModelResponse; a TOOL call (has `toolId`) returns a ToolCallResponse.
// This proves the whole seam — AI SDK loop → makeGuardFetch → the socket → results folded back — with
// ZERO stack and ZERO network, deterministically.
function fakeGuard(handlers: {
  onModel: (call: number, body: any) => unknown;
  onTool: (body: any) => unknown;
}): Promise<{ socketPath: string; modelCalls: () => number; close: () => Promise<void> }> {
  let modelCalls = 0;
  const socketPath = path.join(os.tmpdir(), `guard-test-${process.pid}-${Math.floor(Math.random() * 1e9)}.sock`);
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      const reply = body.toolId !== undefined ? handlers.onTool(body) : handlers.onModel(++modelCalls, body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply));
    });
  });
  return new Promise((resolve) => {
    server.listen(socketPath, () =>
      resolve({
        socketPath,
        modelCalls: () => modelCalls,
        close: () =>
          new Promise((r) =>
            server.close(() => {
              try { fs.unlinkSync(socketPath); } catch { /* already gone */ }
              r();
            }),
          ),
      }),
    );
  });
}

const spec = (over: Partial<JobSpec> = {}): JobSpec => ({
  v: CONTRACT_VERSION,
  runId: "run-1",
  agentId: "a1",
  model: "gpt-oss-20b",
  instructions: "You are Mortimer. Use your tools to answer.",
  skills: [],
  connections: [],
  tools: [{ id: "tool-bits", name: "BitsBy8", operations: [{ name: "list_drives" }] }],
  memories: [],
  history: [],
  taskInput: "How many drives do I have?",
  ...over,
});

let guard: Awaited<ReturnType<typeof fakeGuard>> | undefined;
afterEach(async () => { await guard?.close(); guard = undefined; });

describe("tool loop (Story 12.4) — model-driven reason→act→observe over the Guard socket", () => {
  it("calls a tool, folds the result back, and produces a final answer in a second step", async () => {
    guard = await fakeGuard({
      // Step 1: the model chooses to call list_drives. Step 2: given the result, it answers.
      onModel: (call) =>
        call === 1
          ? { v: CONTRACT_VERSION, ok: true, text: "", toolCalls: [{ id: "call_1", type: "function", function: { name: "list_drives", arguments: "{}" } }], finishReason: "tool_calls", tokens: 5, latencyMs: 1 }
          : { v: CONTRACT_VERSION, ok: true, text: "You have 2 drives: A and B.", finishReason: "stop", tokens: 8, latencyMs: 1 },
      onTool: () => ({ v: CONTRACT_VERSION, ok: true, content: [{ type: "text", text: "Drive A\nDrive B" }], latencyMs: 1 }),
    });

    const emitted: ControlChannelMessage[] = [];
    const result = await runToolLoop(spec(), guard.socketPath, (m) => emitted.push(m));

    // The loop ran two model round-trips (reason → act → observe → answer).
    expect(guard.modelCalls()).toBe(2);
    expect(result.steps).toBe(2);
    expect(result.stopReason).toBe("final");
    expect(result.text).toContain("2 drives");

    // The tool call was brokered through the Guard and RECORDED (Story 6.5 observability), outcome ok.
    const toolEvents = emitted.filter((m) => m.type === "tool");
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0]).toMatchObject({ type: "tool", toolId: "tool-bits", operation: "list_drives", outcome: "ok" });
  });

  it("passes the model's chosen tools to the Guard (the manifest the old stub never sent)", async () => {
    let sawTools: unknown[] | undefined;
    guard = await fakeGuard({
      onModel: (call, body) => {
        if (call === 1) sawTools = body.tools;
        return { v: CONTRACT_VERSION, ok: true, text: "No tool needed.", finishReason: "stop", tokens: 3, latencyMs: 1 };
      },
      onTool: () => ({ v: CONTRACT_VERSION, ok: true, content: [], latencyMs: 1 }),
    });

    await runToolLoop(spec(), guard.socketPath, () => {});

    // The core fix: the model is TOLD its tools (a function-calling manifest reaches the Guard), unlike
    // the deterministic stub which sent only messages and blindly fired operations[0].
    expect(Array.isArray(sawTools)).toBe(true);
    expect(sawTools).toEqual([expect.objectContaining({ type: "function", function: expect.objectContaining({ name: "list_drives" }) })]);
  });

  // review HIGH: two tools that grant the SAME op name must never misroute — each exposed name routes
  // to its OWN toolId (the collision fix keys the ToolSet uniquely; the executor closes over the real id).
  it("routes a shared op name to the correct tool — no cross-tool collision (review HIGH)", async () => {
    const brokered: { toolId: string; operation: string }[] = [];
    guard = await fakeGuard({
      onModel: (call, body) =>
        call === 1
          ? {
              v: CONTRACT_VERSION,
              ok: true,
              text: "",
              // call BOTH tools by their EXPOSED function names (as the manifest presented them)
              toolCalls: (body.tools as { function: { name: string } }[]).map((t, i) => ({ id: `c${i}`, type: "function", function: { name: t.function.name, arguments: "{}" } })),
              finishReason: "tool_calls",
              tokens: 5,
              latencyMs: 1,
            }
          : { v: CONTRACT_VERSION, ok: true, text: "done", finishReason: "stop", tokens: 3, latencyMs: 1 },
      onTool: (body) => {
        brokered.push({ toolId: body.toolId, operation: body.operation });
        return { v: CONTRACT_VERSION, ok: true, content: [], latencyMs: 1 };
      },
    });

    const s = spec({
      tools: [
        { id: "tool-A", name: "Alpha", operations: [{ name: "search" }] },
        { id: "tool-B", name: "Beta", operations: [{ name: "search" }] },
      ],
    });
    await runToolLoop(s, guard.socketPath, () => {});

    // both tools were reachable AND each "search" brokered against its OWN id (buggy code would show one id twice)
    expect(brokered).toHaveLength(2);
    expect(brokered.every((b) => b.operation === "search")).toBe(true);
    expect(new Set(brokered.map((b) => b.toolId))).toEqual(new Set(["tool-A", "tool-B"]));
  });

  // review HIGH: a mid-loop model failure / cost-cap kill must NOT reject — the loop ends gracefully
  // with the last text that stood + stopReason "error" (never a bare crash — NFR-2).
  it("ends gracefully with the last text on a mid-loop failure — never rejects (review HIGH)", async () => {
    guard = await fakeGuard({
      onModel: (call) =>
        call === 1
          ? { v: CONTRACT_VERSION, ok: true, text: "Checking your drives…", toolCalls: [{ id: "c1", type: "function", function: { name: "list_drives", arguments: "{}" } }], finishReason: "tool_calls", tokens: 5, latencyMs: 1 }
          : { v: CONTRACT_VERSION, ok: false, error: "Killed — per-run cost cap reached ($0.50)." }, // the kill → 502 → SDK throws
      onTool: () => ({ v: CONTRACT_VERSION, ok: true, content: [{ type: "text", text: "A, B" }], latencyMs: 1 }),
    });

    const result = await runToolLoop(spec(), guard.socketPath, () => {}); // must RESOLVE, not reject
    expect(result.stopReason).toBe("error");
    expect(result.text).toContain("Checking your drives"); // the last assistant text that stood
  });

  // an agent with NO tools degenerates cleanly to a single model call (no tool_choice forwarded).
  it("degenerates to a single model call when the agent has no tools", async () => {
    let sawToolChoice = false;
    guard = await fakeGuard({
      onModel: (_call, body) => {
        if ("tool_choice" in body) sawToolChoice = true;
        return { v: CONTRACT_VERSION, ok: true, text: "Hello.", finishReason: "stop", tokens: 2, latencyMs: 1 };
      },
      onTool: () => ({ v: CONTRACT_VERSION, ok: true, content: [], latencyMs: 1 }),
    });

    const result = await runToolLoop(spec({ tools: [] }), guard.socketPath, () => {});
    expect(result.stopReason).toBe("final");
    expect(result.text).toBe("Hello.");
    expect(guard.modelCalls()).toBe(1);
    expect(sawToolChoice).toBe(false); // empty tools ⇒ no tool_choice forwarded
  });

  // Review (wire-compat): the fakeGuard receives the ACTUAL GuardModelRequest that guardModelCall sent
  // over the socket. Validate every model-call body across a MULTI-STEP loop (assistant tool_calls +
  // tool-result folded back — the shapes most likely to serialize as content-parts) against the REAL
  // GuardModelRequestSchema, so the AI SDK ↔ Guard wire form can't silently drift (content is string|null).
  it("the SDK-emitted request body validates against the real GuardModelRequestSchema across a multi-step loop", async () => {
    const bodies: unknown[] = [];
    guard = await fakeGuard({
      onModel: (call, body) => {
        bodies.push(body);
        return call === 1
          ? { v: CONTRACT_VERSION, ok: true, text: "", toolCalls: [{ id: "c1", type: "function", function: { name: "list_drives", arguments: "{}" } }], finishReason: "tool_calls", tokens: 5, latencyMs: 1 }
          : { v: CONTRACT_VERSION, ok: true, text: "2 drives", finishReason: "stop", tokens: 3, latencyMs: 1 };
      },
      onTool: () => ({ v: CONTRACT_VERSION, ok: true, content: [{ type: "text", text: "Drive A\nDrive B" }], latencyMs: 1 }),
    });

    await runToolLoop(spec(), guard.socketPath, () => {});
    expect(bodies.length).toBeGreaterThanOrEqual(2); // reason → act → observe → answer
    for (const b of bodies) {
      const parsed = GuardModelRequestSchema.safeParse(b);
      expect(parsed.success, `body did not match GuardModelRequestSchema: ${JSON.stringify(b)}`).toBe(true);
    }
  });

  // Story 12.5: a MALFORMED tool call (args miss a required field → InvalidToolInputError) is REPAIRED
  // (structured regenerate via generateObject) and then runs — the run finishes instead of dying.
  it("repairs a malformed tool call (invalid args) then completes (Story 12.5)", async () => {
    guard = await fakeGuard({
      onModel: (_call, body) => {
        const msgs = JSON.stringify(body.messages ?? []);
        if (msgs.includes("Produce corrected arguments")) return { v: CONTRACT_VERSION, ok: true, text: '{"path":"/"}', finishReason: "stop", tokens: 2, latencyMs: 1 }; // the generateObject repair re-ask → valid args
        if (msgs.includes("OK-DRIVES")) return { v: CONTRACT_VERSION, ok: true, text: "You have 2 drives.", finishReason: "stop", tokens: 3, latencyMs: 1 }; // after the repaired call ran
        return { v: CONTRACT_VERSION, ok: true, text: "", toolCalls: [{ id: "c1", type: "function", function: { name: "list_drives", arguments: "{not valid json" } }], finishReason: "tool_calls", tokens: 5, latencyMs: 1 }; // UNPARSEABLE args → InvalidToolInputError
      },
      onTool: () => ({ v: CONTRACT_VERSION, ok: true, content: [{ type: "text", text: "OK-DRIVES" }], latencyMs: 1 }),
    });

    const emitted: ControlChannelMessage[] = [];
    const s = spec({ tools: [{ id: "tool-bits", name: "BitsBy8", operations: [{ name: "list_drives", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }] }] });
    const result = await runToolLoop(s, guard.socketPath, (m) => emitted.push(m));

    const toolEvents = emitted.filter((m) => m.type === "tool");
    // the repair attempt is recorded (outcome error + repair detail), and the retried call then succeeds
    expect(toolEvents.some((e) => e.type === "tool" && e.outcome === "error" && /repair/i.test(e.detail ?? ""))).toBe(true);
    expect(toolEvents.some((e) => e.type === "tool" && e.outcome === "ok")).toBe(true);
    expect(result.stopReason).toBe("final");
  });

  // Story 12.5: a call to a tool that doesn't exist (NoSuchToolError) is recorded + gives up gracefully.
  it("records a no-such-tool repair attempt then ends gracefully (Story 12.5)", async () => {
    guard = await fakeGuard({
      onModel: () => ({ v: CONTRACT_VERSION, ok: true, text: "", toolCalls: [{ id: "c1", type: "function", function: { name: "does_not_exist", arguments: "{}" } }], finishReason: "tool_calls", tokens: 5, latencyMs: 1 }),
      onTool: () => ({ v: CONTRACT_VERSION, ok: true, content: [], latencyMs: 1 }),
    });

    const emitted: ControlChannelMessage[] = [];
    const result = await runToolLoop(spec(), guard.socketPath, (m) => emitted.push(m));

    expect(emitted.some((m) => m.type === "tool" && m.outcome === "error" && /no such tool/i.test(m.detail ?? ""))).toBe(true);
    // gave up (null); the model keeps re-emitting the bad call → the loop ends cleanly at the ceiling
    // (either a step-limit or an error stop — both graceful, never a crash).
    expect(["step-limit", "error"]).toContain(result.stopReason);
  });

  // Story 12.4 AC3(e): a Guard REFUSAL is surfaced to the model distinctly from a tool execution error,
  // and recorded as a `refused` tool event (Story 6.5) — so a permanently-denied op isn't retried blindly.
  it("surfaces a Guard refusal distinctly and records it as a refused tool event (Story 12.4 AC3e)", async () => {
    guard = await fakeGuard({
      onModel: (call) =>
        call === 1
          ? { v: CONTRACT_VERSION, ok: true, text: "", toolCalls: [{ id: "c1", type: "function", function: { name: "list_drives", arguments: "{}" } }], finishReason: "tool_calls", tokens: 5, latencyMs: 1 }
          : { v: CONTRACT_VERSION, ok: true, text: "I can't — that operation isn't permitted.", finishReason: "stop", tokens: 4, latencyMs: 1 },
      onTool: () => ({ v: CONTRACT_VERSION, ok: false, refusal: { kind: "permission", detail: "operation not granted" }, latencyMs: 1 }),
    });

    const emitted: ControlChannelMessage[] = [];
    const result = await runToolLoop(spec(), guard.socketPath, (m) => emitted.push(m));

    // recorded as a `refused` tool event (distinct from an `error`) — the Guard's decision, made legible
    expect(emitted.some((m) => m.type === "tool" && m.outcome === "refused")).toBe(true);
    // the loop ends cleanly (the model saw the "Not permitted" result and answered) — no crash, no retry storm
    expect(result.stopReason).toBe("final");
  });

  // Story 12.6 AC1: a multi-step run emits its per-step `tool` events IN ORDER (the reason→act→observe
  // trail is legible). Two tool-calling steps → two tool events, in call order.
  it("emits per-step tool events in order across a multi-step loop (Story 12.6)", async () => {
    let step = 0;
    guard = await fakeGuard({
      onModel: (call) => {
        if (call <= 2) return { v: CONTRACT_VERSION, ok: true, text: "", toolCalls: [{ id: `c${call}`, type: "function", function: { name: "list_drives", arguments: "{}" } }], finishReason: "tool_calls", tokens: 3, latencyMs: 1 };
        return { v: CONTRACT_VERSION, ok: true, text: "done", finishReason: "stop", tokens: 2, latencyMs: 1 };
      },
      onTool: () => ({ v: CONTRACT_VERSION, ok: true, content: [{ type: "text", text: `step-${++step}` }], latencyMs: step }),
    });

    const emitted: ControlChannelMessage[] = [];
    await runToolLoop(spec(), guard.socketPath, (m) => emitted.push(m));

    const toolEvents = emitted.filter((m) => m.type === "tool");
    expect(toolEvents).toHaveLength(2);
    // recorded in emission order (step 1 before step 2) — the trail is legible, not reordered
    expect(toolEvents.map((e) => (e.type === "tool" ? e.latencyMs : -1))).toEqual([1, 2]);
  });

  // review LOW: a non-object-typed inputSchema (a valid object, but not type:"object") must not crash
  // the loop — it falls back to a permissive object schema.
  it("falls back to a permissive schema for a non-object-typed inputSchema (review LOW)", async () => {
    guard = await fakeGuard({
      onModel: (call) =>
        call === 1
          ? { v: CONTRACT_VERSION, ok: true, text: "", toolCalls: [{ id: "c1", type: "function", function: { name: "list_drives", arguments: "{}" } }], finishReason: "tool_calls", tokens: 5, latencyMs: 1 }
          : { v: CONTRACT_VERSION, ok: true, text: "ok", finishReason: "stop", tokens: 2, latencyMs: 1 },
      onTool: () => ({ v: CONTRACT_VERSION, ok: true, content: [], latencyMs: 1 }),
    });

    const s = spec({ tools: [{ id: "tool-bits", name: "BitsBy8", operations: [{ name: "list_drives", inputSchema: { type: "array" } }] }] });
    const result = await runToolLoop(s, guard.socketPath, () => {}); // no throw at buildTools
    expect(result.stopReason).toBe("final");
  });
});
