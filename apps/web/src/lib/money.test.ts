import { describe, it, expect } from "vitest";
import { parseDollarsToMinor, formatMinor } from "./money";

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
