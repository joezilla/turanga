import { describe, it, expect } from "vitest";
import { ulid, type Agent } from "./index.js";

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
      costCap: { perRun: { minor: 50, currency: "USD" }, perDay: { minor: 500, currency: "USD" } },
      state: "draft",
      createdAt: "2026-07-31T00:00:00.000Z",
    };
    expect(a.costCap.perDay?.minor).toBe(500);
  });
});
