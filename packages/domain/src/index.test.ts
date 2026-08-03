import { describe, it, expect } from "vitest";
import { ulid, activationBlockers, type Agent } from "./index.js";

describe("domain", () => {
  it("ulid is 26 Crockford-base32 chars", () => {
    const id = ulid(1_700_000_000_000, () => 0.5);
    expect(id).toHaveLength(26);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("agent shape compiles with money as minor units", () => {
    const a: Agent = {
      id: ulid(1_700_000_000_000),
      name: "inbox",
      instructions: "",
      skills: [{ skill: "read-search", scope: "read", send: false }],
      attachedTools: [],
      costCap: { perRun: { minor: 50, currency: "USD" }, perDay: { minor: 500, currency: "USD" } },
      state: "draft",
      createdAt: "2026-07-31T00:00:00.000Z",
    };
    expect(a.costCap.perDay?.minor).toBe(500);
  });

  it("activationBlockers: the Activate gate truth table (Story 5.1)", () => {
    const usd = (minor: number) => ({ minor, currency: "USD" });
    const full = { model: "openai/gpt-4o", costCap: { perRun: usd(50), perDay: usd(500) } };
    // Fully configured + provider connected → activatable.
    expect(activationBlockers(full, true)).toEqual([]);
    // No model → the model reason (and no provider reason).
    expect(activationBlockers({ model: null, costCap: full.costCap }, false)).toEqual(["Select a model."]);
    // Model set but provider not connected.
    expect(activationBlockers(full, false)).toEqual(["The selected model's provider isn't connected — reconnect it in Settings."]);
    // Missing each cap (with a connected provider).
    expect(activationBlockers({ model: "openai/gpt-4o", costCap: { perRun: null, perDay: usd(500) } }, true)).toEqual(["Set a per-run cost cap."]);
    expect(activationBlockers({ model: "openai/gpt-4o", costCap: { perRun: usd(50), perDay: null } }, true)).toEqual(["Set a per-day cost cap."]);
    // Everything missing → model reason first, then both caps (stable order).
    expect(activationBlockers({ model: null, costCap: { perRun: null, perDay: null } }, false)).toEqual(["Select a model.", "Set a per-run cost cap.", "Set a per-day cost cap."]);
  });
});
