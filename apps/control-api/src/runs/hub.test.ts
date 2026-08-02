import { describe, it, expect } from "vitest";
import type { ControlChannelMessage } from "@turanga/contracts";
import { createRunHub } from "./hub.js";

const turn = (text: string): ControlChannelMessage => ({ type: "turn", v: 3, role: "agent", text });

describe("RunHub", () => {
  it("subscribe replays from the given index, then delivers live messages", () => {
    const hub = createRunHub();
    hub.open("r1");
    hub.publish("r1", turn("a"));
    hub.publish("r1", turn("b"));

    const seen: string[] = [];
    const unsub = hub.subscribe("r1", 1, (m) => seen.push((m as { text: string }).text), () => {});
    expect(unsub).not.toBeNull();
    expect(seen).toEqual(["b"]); // replayed from index 1 (skips "a")

    hub.publish("r1", turn("c"));
    expect(seen).toEqual(["b", "c"]); // live delivery after replay
  });

  it("unsubscribe stops further delivery", () => {
    const hub = createRunHub();
    hub.open("r1");
    const seen: string[] = [];
    const unsub = hub.subscribe("r1", 0, (m) => seen.push((m as { text: string }).text), () => {})!;
    hub.publish("r1", turn("a"));
    unsub();
    hub.publish("r1", turn("b"));
    expect(seen).toEqual(["a"]);
  });

  it("complete fires onDone with the terminal status", () => {
    const hub = createRunHub();
    hub.open("r1");
    let status = "";
    hub.subscribe("r1", 0, () => {}, (s) => (status = s));
    hub.complete("r1", "failed");
    expect(status).toBe("failed");
  });

  it("a subscriber that connects after completion (within TTL) still gets the buffer + done", () => {
    const hub = createRunHub();
    hub.open("r1");
    hub.publish("r1", turn("a"));
    hub.complete("r1", "succeeded");

    const seen: string[] = [];
    let status = "";
    const unsub = hub.subscribe("r1", 0, (m) => seen.push((m as { text: string }).text), (s) => (status = s));
    expect(unsub).not.toBeNull(); // still retained
    expect(seen).toEqual(["a"]);
    expect(status).toBe("succeeded");
  });

  it("complete is idempotent — a second complete doesn't overwrite the terminal status", () => {
    const hub = createRunHub();
    hub.open("r1");
    hub.complete("r1", "succeeded");
    hub.complete("r1", "failed"); // ignored — a run completes exactly once
    let late = "";
    hub.subscribe("r1", 0, () => {}, (s) => (late = s));
    expect(late).toBe("succeeded");
  });

  it("subscribe returns null for a run the hub never saw (caller falls back to the repo)", () => {
    const hub = createRunHub();
    expect(hub.subscribe("nope", 0, () => {}, () => {})).toBeNull();
  });

  it("evicts a completed run after the retention window", async () => {
    const hub = createRunHub(10); // 10ms TTL
    hub.open("r1");
    hub.complete("r1", "succeeded");
    await new Promise((r) => setTimeout(r, 30));
    expect(hub.subscribe("r1", 0, () => {}, () => {})).toBeNull(); // evicted → repo fallback
  });
});
