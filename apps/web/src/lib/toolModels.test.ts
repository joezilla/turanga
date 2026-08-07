import { describe, it, expect } from "vitest";
import { isToolVerified, VERIFIED_TOOL_MODELS_LABEL } from "./toolModels";

describe("toolModels — the verified-models capability signal (Story 12.7)", () => {
  it("verified frontier models are recognized (provider-prefixed ids, case-insensitive)", () => {
    expect(isToolVerified("openai/gpt-4o")).toBe(true);
    expect(isToolVerified("openai/GPT-4O-mini")).toBe(true); // case-insensitive
    expect(isToolVerified("anthropic/claude-3-5-sonnet-20241022")).toBe(true);
    expect(isToolVerified("anthropic/claude-sonnet-4")).toBe(true);
    expect(isToolVerified("google/gemini-2.0-flash")).toBe(true);
  });

  it("an unverified model shows the signal — gpt-oss-20b is tool-trained but NOT yet verified live", () => {
    // the exact model that opened the epic (Mortimer) — not on the reference until the live demo proves it
    expect(isToolVerified("openai-compatible//models/gpt-oss-20b-MXFP4.gguf")).toBe(false);
    expect(isToolVerified("some-random/local-model")).toBe(false);
  });

  it("a null/empty model is treated as unverified (never throws)", () => {
    expect(isToolVerified(null)).toBe(false);
    expect(isToolVerified(undefined)).toBe(false);
    expect(isToolVerified("")).toBe(false);
  });

  it("exposes a non-empty human label of the verified set for the signal copy", () => {
    expect(VERIFIED_TOOL_MODELS_LABEL.length).toBeGreaterThan(0);
  });
});
