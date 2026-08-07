// Keeps a scrollable log pinned to its newest content while it streams.
//
// The rule readers expect from a chat: follow the tail by default, but the moment the reader scrolls
// up to re-read something, stop yanking them back — and resume following as soon as they return to
// the bottom. So "pinned" is latched state, not a per-frame reading of the scroll position: once
// content grows under a pinned view the distance-from-bottom is momentarily large, and reading it
// live would unpin exactly when we should be scrolling.
//
// Growth is detected with a MutationObserver (childList for new turns, characterData for text
// streamed into an existing node) plus a ResizeObserver for viewport/layout changes. Both funnel
// into one rAF-coalesced scroll so a burst of SSE frames costs a single scroll per frame.

export const STICK_THRESHOLD_PX = 48;

export interface StickToBottomParams {
  /** Distance from the bottom, in px, still counted as "at the bottom". */
  threshold?: number;
  /** Changing this re-pins and jumps to the bottom — e.g. switching conversations. */
  key?: unknown;
}

/**
 * Decides whether the view should keep following the tail after a scroll event.
 *
 * `scrollTop === selfScrollTop` means nothing moved since our own programmatic scroll: the event is
 * the echo of that scroll (or of content growing beneath it), not the reader scrolling away.
 */
export function pinnedAfterScroll(state: {
  pinned: boolean;
  distanceFromBottom: number;
  scrollTop: number;
  selfScrollTop: number;
  threshold: number;
}): boolean {
  if (state.distanceFromBottom <= state.threshold) return true;
  if (state.scrollTop === state.selfScrollTop) return state.pinned;
  return false;
}

export function stickToBottom(node: HTMLElement, params: StickToBottomParams = {}) {
  let threshold = params.threshold ?? STICK_THRESHOLD_PX;
  let key = params.key;
  let pinned = true;
  let selfScrollTop = -1; // the scrollTop we last set ourselves (-1 = none)
  let frame = 0;

  const distanceFromBottom = () => node.scrollHeight - node.scrollTop - node.clientHeight;

  function toBottom() {
    node.scrollTop = node.scrollHeight;
    selfScrollTop = node.scrollTop;
  }

  function schedule() {
    if (!pinned || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (pinned) toBottom();
    });
  }

  function onScroll() {
    pinned = pinnedAfterScroll({
      pinned,
      distanceFromBottom: distanceFromBottom(),
      scrollTop: node.scrollTop,
      selfScrollTop,
      threshold,
    });
  }

  node.addEventListener("scroll", onScroll, { passive: true });
  const mutations = new MutationObserver(schedule);
  mutations.observe(node, { childList: true, subtree: true, characterData: true });
  const resizes = new ResizeObserver(schedule);
  resizes.observe(node);

  toBottom(); // open on the latest turn, not the top of the history

  return {
    update(next: StickToBottomParams = {}) {
      threshold = next.threshold ?? STICK_THRESHOLD_PX;
      if (next.key !== key) {
        key = next.key;
        pinned = true; // a new thread starts at its latest turn
        schedule();
      }
    },
    destroy() {
      if (frame) cancelAnimationFrame(frame);
      node.removeEventListener("scroll", onScroll);
      mutations.disconnect();
      resizes.disconnect();
    },
  };
}
