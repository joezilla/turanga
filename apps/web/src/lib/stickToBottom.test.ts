import { describe, it, expect } from "vitest";
import { pinnedAfterScroll, STICK_THRESHOLD_PX } from "./stickToBottom";

const T = STICK_THRESHOLD_PX;

// Only the latch decision is unit-testable in the node env; the observers/scrolling are DOM.
describe("pinnedAfterScroll", () => {
  it("stays pinned while the view sits at the bottom", () => {
    expect(pinnedAfterScroll({ pinned: true, distanceFromBottom: 0, scrollTop: 900, selfScrollTop: 900, threshold: T })).toBe(true);
  });

  it("re-pins when the reader scrolls back down to the tail", () => {
    expect(pinnedAfterScroll({ pinned: false, distanceFromBottom: 4, scrollTop: 900, selfScrollTop: -1, threshold: T })).toBe(true);
  });

  it("counts within-threshold as the bottom", () => {
    expect(pinnedAfterScroll({ pinned: false, distanceFromBottom: T, scrollTop: 860, selfScrollTop: -1, threshold: T })).toBe(true);
    expect(pinnedAfterScroll({ pinned: false, distanceFromBottom: T + 1, scrollTop: 859, selfScrollTop: -1, threshold: T })).toBe(false);
  });

  it("unpins when the reader scrolls away from the tail", () => {
    expect(pinnedAfterScroll({ pinned: true, distanceFromBottom: 400, scrollTop: 300, selfScrollTop: 900, threshold: T })).toBe(false);
  });

  it("stays pinned when content grows under our own scroll (scrollTop unmoved)", () => {
    // The frame arrived after we scrolled: distance is large but nothing moved — this is the case a
    // live distance check would get wrong, unpinning exactly when it should follow.
    expect(pinnedAfterScroll({ pinned: true, distanceFromBottom: 220, scrollTop: 900, selfScrollTop: 900, threshold: T })).toBe(true);
  });

  it("keeps an unpinned view unpinned when growth echoes a stale self-scroll", () => {
    expect(pinnedAfterScroll({ pinned: false, distanceFromBottom: 220, scrollTop: 900, selfScrollTop: 900, threshold: T })).toBe(false);
  });
});
