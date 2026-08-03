import { describe, it, expect } from "vitest";
import { formatTimestamp } from "./datetime";

describe("formatTimestamp", () => {
  it("formats a UTC ISO-8601 string into a readable local absolute time", () => {
    const out = formatTimestamp("2026-08-03T14:16:00.000Z");
    // Locale/tz-dependent exact string, but it must include the year + a time, and never "Invalid Date".
    expect(out).toContain("2026");
    expect(out).toMatch(/\d{1,2}:\d{2}/);
    expect(out).not.toContain("Invalid");
  });
  it("returns '' for empty / null / undefined / unparseable input", () => {
    expect(formatTimestamp("")).toBe("");
    expect(formatTimestamp(null)).toBe("");
    expect(formatTimestamp(undefined)).toBe("");
    expect(formatTimestamp("not-a-date")).toBe("");
  });
});
