import { describe, it, expect } from "vitest";
import { runCause } from "./runs";

describe("runCause (Story 5.3 AC2 — cause legibility)", () => {
  it("returns the persisted reason for a killed/failed run when present", () => {
    expect(runCause("killed", "Killed — per-day cost cap reached ($5.00).")).toBe("Killed — per-day cost cap reached ($5.00).");
    expect(runCause("failed", "Sandbox couldn't be established: boom")).toBe("Sandbox couldn't be established: boom");
  });
  it("falls back to an honest cause when a killed/failed run has no reason (never blank)", () => {
    // A harness `done:failed` persists reason=null — AC2's "error" case must still be legible.
    expect(runCause("failed", null)).toBe("The run failed — no cause was recorded. See the transcript.");
    expect(runCause("killed", null)).toBe("The run was killed.");
  });
  it("returns null (no cause line) for non-terminal / succeeded runs", () => {
    expect(runCause("succeeded", null)).toBeNull();
    expect(runCause("succeeded", "ignored")).toBeNull();
    expect(runCause("running", null)).toBeNull();
    expect(runCause("created", null)).toBeNull();
  });
});
