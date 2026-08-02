// In-memory run event hub (Epic 4, Story 4.2): the live relay between the orchestrator (which
// publishes each control-channel message as a run progresses) and the SSE endpoint (which streams
// them to the web test pane). MVP: single control-api process. The repo remains the persisted
// truth; the hub is a short-lived tail so a subscriber that connects mid-run (or a few seconds
// after a fast run completes) gets the full ordered buffer + the terminal status.
import type { ControlChannelMessage } from "@turanga/contracts";
import type { RunStatus } from "./repo.js";

interface Subscriber {
  from: number;
  onMsg: (msg: ControlChannelMessage, index: number) => void;
  onDone: (status: RunStatus) => void;
}
interface RunState {
  messages: ControlChannelMessage[];
  status: RunStatus;
  done: boolean;
  subs: Set<Subscriber>;
  evictTimer?: ReturnType<typeof setTimeout>;
}

export interface RunHub {
  /** Register a run so it has hub state the instant it's created — before its first publish. This
   *  closes the race where a subscriber connects between `start()` returning and the first message
   *  (subscribe would otherwise see an unknown run and fall back to the not-yet-written repo). */
  open(runId: string): void;
  publish(runId: string, msg: ControlChannelMessage): void;
  complete(runId: string, status: RunStatus): void;
  /** Replays buffered messages from `from`, then delivers live ones. Returns an unsubscribe fn.
   *  Returns null if the run is unknown to the hub (caller falls back to the persisted repo). */
  subscribe(runId: string, from: number, onMsg: Subscriber["onMsg"], onDone: Subscriber["onDone"]): (() => void) | null;
}

export function createRunHub(retainMs = 30_000): RunHub {
  const runs = new Map<string, RunState>();

  function ensure(runId: string): RunState {
    let s = runs.get(runId);
    if (!s) {
      s = { messages: [], status: "running", done: false, subs: new Set() };
      runs.set(runId, s);
    }
    return s;
  }

  return {
    open(runId) {
      ensure(runId);
    },
    publish(runId, msg) {
      const s = ensure(runId);
      const index = s.messages.length;
      s.messages.push(msg);
      for (const sub of s.subs) sub.onMsg(msg, index);
    },
    complete(runId, status) {
      const s = ensure(runId);
      s.status = status;
      s.done = true;
      for (const sub of s.subs) sub.onDone(status);
      s.subs.clear();
      // Retain briefly so a late subscriber still catches a fast run, then evict.
      s.evictTimer = setTimeout(() => runs.delete(runId), retainMs);
      s.evictTimer.unref?.();
    },
    subscribe(runId, from, onMsg, onDone) {
      const s = runs.get(runId);
      if (!s) return null; // unknown to the hub → caller reads the repo
      // Replay the buffer from `from` (catch-up), then live.
      for (let i = Math.max(0, from); i < s.messages.length; i++) onMsg(s.messages[i], i);
      if (s.done) {
        onDone(s.status);
        return () => {};
      }
      const sub: Subscriber = { from, onMsg, onDone };
      s.subs.add(sub);
      return () => s.subs.delete(sub);
    },
  };
}
