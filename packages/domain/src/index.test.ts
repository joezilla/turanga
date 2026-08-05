import { describe, it, expect } from "vitest";
import { ulid, activationBlockers, effectiveMemoryConfig, DEFAULT_MEMORY_CONFIG, DEFAULT_MEMORY_GLOBAL_CONFIG, type Agent, type MemoryConfig } from "./index.js";

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
      memoryConfig: DEFAULT_MEMORY_CONFIG,
      state: "draft",
      createdAt: "2026-07-31T00:00:00.000Z",
    };
    expect(a.costCap.perDay?.minor).toBe(500);
  });

  it("effectiveMemoryConfig: memory is OFF by default and the toggle resolves correctly (Story 8.1)", () => {
    const global = DEFAULT_MEMORY_GLOBAL_CONFIG; // defaultEnabled false, killSwitch false
    // A brand-new agent (inherit) with the default-off global → effectively OFF.
    expect(effectiveMemoryConfig(global, DEFAULT_MEMORY_CONFIG)).toEqual({ enabled: false, recall: false, reflect: false, kinds: [] });
    // inherit follows the global default when it's ON.
    expect(effectiveMemoryConfig({ ...global, defaultEnabled: true }, DEFAULT_MEMORY_CONFIG).enabled).toBe(true);
    // mode:"on" enables regardless of the global default.
    const on: MemoryConfig = { mode: "on", recall: true, reflect: true, kinds: ["semantic"] };
    expect(effectiveMemoryConfig(global, on)).toEqual({ enabled: true, recall: true, reflect: true, kinds: ["semantic"] });
    // mode:"off" disables even when the global default is on.
    expect(effectiveMemoryConfig({ ...global, defaultEnabled: true }, { ...on, mode: "off" }).enabled).toBe(false);
    // recall/reflect are gated by BOTH enabled and the per-agent flag.
    expect(effectiveMemoryConfig(global, { mode: "on", recall: false, reflect: true, kinds: [...DEFAULT_MEMORY_CONFIG.kinds] })).toMatchObject({ enabled: true, recall: false, reflect: true });
    // killSwitch overrides everything — even an explicitly-on agent.
    expect(effectiveMemoryConfig({ ...global, killSwitch: true }, on)).toEqual({ enabled: false, recall: false, reflect: false, kinds: [] });
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
