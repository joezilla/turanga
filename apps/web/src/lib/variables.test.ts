import { describe, it, expect } from "vitest";
import { referencedVariables, undefinedVariables } from "./variables";

describe("referencedVariables", () => {
  it("extracts distinct names in first-seen order", () => {
    expect(referencedVariables("Hi {portfolio}, watch {ticker} and {portfolio}.")).toEqual(["portfolio", "ticker"]);
  });
  it("ignores malformed braces and non-identifier names", () => {
    expect(referencedVariables("{ } {1bad} {bad-dash} { spaced } plain {}")).toEqual([]);
  });
  it("returns [] for text with no references", () => {
    expect(referencedVariables("no variables here")).toEqual([]);
  });
  it("allows underscores and digits after the first letter", () => {
    expect(referencedVariables("{portfolio_size} {a1_b2}")).toEqual(["portfolio_size", "a1_b2"]);
  });
});

describe("undefinedVariables", () => {
  it("returns referenced names not in the defined set", () => {
    expect(undefinedVariables("{a} {b} {c}", ["b"])).toEqual(["a", "c"]);
  });
  it("returns [] when all referenced names are defined", () => {
    expect(undefinedVariables("{a} {b}", ["a", "b", "unused"])).toEqual([]);
  });
});
