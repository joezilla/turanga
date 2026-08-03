import { describe, it, expect } from "vitest";
import { parseDollarsToMinor, formatMinor, formatMicros, meterTone } from "./money";

describe("parseDollarsToMinor", () => {
  it("parses whole and fractional dollars to minor units", () => {
    expect(parseDollarsToMinor("5")).toEqual({ ok: true, minor: 500 });
    expect(parseDollarsToMinor("5.00")).toEqual({ ok: true, minor: 500 });
    expect(parseDollarsToMinor("0.05")).toEqual({ ok: true, minor: 5 });
    expect(parseDollarsToMinor("0.5")).toEqual({ ok: true, minor: 50 });
    expect(parseDollarsToMinor("1,234.56")).toEqual({ ok: true, minor: 123456 });
  });
  it("rejects negatives, non-numbers, and >2 decimal places", () => {
    expect(parseDollarsToMinor("-1").ok).toBe(false);
    expect(parseDollarsToMinor("abc").ok).toBe(false);
    expect(parseDollarsToMinor("1.234").ok).toBe(false);
    expect(parseDollarsToMinor("").ok).toBe(false);
  });
  it("rejects amounts above the maximum cap", () => {
    expect(parseDollarsToMinor("100001").ok).toBe(false);
  });
});

describe("formatMinor", () => {
  it("formats minor units to 2-dp dollars with thousands separators", () => {
    expect(formatMinor(500)).toBe("5.00");
    expect(formatMinor(5)).toBe("0.05");
    expect(formatMinor(123456)).toBe("1,234.56");
    expect(formatMinor(0)).toBe("0.00");
  });
});

describe("meterTone (Story 5.2 agents-list daily meter)", () => {
  // Per-day cap $5.00 = 500 minor (cents). Spend is micro-USD; ÷10,000 → cents. 80% of $5 = $4.00.
  const cap = 500;
  it("neutral below 80% of the per-day cap, warn at/above", () => {
    expect(meterTone(0, cap)).toBe("neutral"); // $0.00
    expect(meterTone(3_990_000, cap)).toBe("neutral"); // $3.99 (just under 80%)
    expect(meterTone(4_000_000, cap)).toBe("warn"); // $4.00 = exactly 80%
    expect(meterTone(5_000_000, cap)).toBe("warn"); // $5.00 = at the cap
    expect(meterTone(6_000_000, cap)).toBe("warn"); // over the cap
  });
  it("no per-day cap ⇒ always neutral (nothing to approach)", () => {
    expect(meterTone(9_999_999, null)).toBe("neutral");
    expect(meterTone(0, null)).toBe("neutral");
  });
  it("does not confuse the 10,000× micros↔cents unit gap", () => {
    // $2 spend (2,000,000 micros) against a $5 cap (500 cents) is 40% → neutral, NOT warn.
    expect(meterTone(2_000_000, 500)).toBe("neutral");
  });
});

describe("formatMicros", () => {
  it("renders micro-USD at ≥4dp with a $ sign", () => {
    expect(formatMicros(0)).toBe("$0.0000");
    expect(formatMicros(4100)).toBe("$0.0041");
    expect(formatMicros(5_000_000)).toBe("$5.0000");
  });
});
