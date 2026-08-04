<script lang="ts">
  // Test console — the design's 420px docked drawer. This is the Story 4.2 test pane relocated,
  // not rewritten: the run lifecycle, the SSE stream handling, the `runGen` generation guard that
  // discards a superseded start, and the `doneReceived` distinction between a clean close and a
  // mid-stream drop all move across unchanged. Only the chrome around them is new.
  //
  // The run executes the LAST SAVED DRAFT, not the in-memory edits — the control-api resolves the
  // agent row when the run starts. The footer says so rather than implying otherwise; saving is
  // the user's move, and running a hidden auto-save behind a test button would be a silent write.
  import { onDestroy } from "svelte";
  import { X, Circle } from "@lucide/svelte";
  import RunTranscript from "$lib/components/RunTranscript.svelte";
  import RunStatusDot from "$lib/components/RunStatusDot.svelte";
  import { startRun, runEventsUrl, getAgentCost, getRun, type RunMessage } from "$lib/runs";
  import { formatMinor, formatMicros } from "$lib/money";
  import type { CostCap } from "$lib/agents";

  let { agentId, costCap, dirty, onClose }: { agentId: string; costCap: CostCap; dirty: boolean; onClose: () => void } = $props();

  type RunUiState = "empty" | "running" | "succeeded" | "failed" | "killed" | "error";
  let runState = $state<RunUiState>("empty");
  let taskInput = $state("");
  let transcript = $state<RunMessage[]>([]);
  let runError = $state("");
  let es: EventSource | null = null; // the live SSE stream (not reactive)
  let doneReceived = false;
  // Bumped on every runTest/clearTest/agent change so a start-run that resolves after the pane
  // moved on is discarded instead of streaming into the wrong context.
  let runGen = 0;

  const metricsMsgs = $derived(transcript.filter((m): m is Extract<RunMessage, { type: "metrics" }> => m.type === "metrics"));
  const lastMetrics = $derived(metricsMsgs.at(-1));
  const runCostMicros = $derived(metricsMsgs.reduce((s, m) => s + m.costMicros, 0)); // = the persisted summary (no drift, AC3)
  let todayMicros = $state<number | null>(null); // the agent's cumulative spend today (daily meter)
  let runReason = $state(""); // the killed/failed reason
  const fmtNum = (n: number) => n.toLocaleString("en-US");

  function closeStream() {
    if (es) {
      es.close();
      es = null;
    }
  }

  export function runTest() {
    if (runState === "running") return; // one test at a time
    closeStream();
    transcript = [];
    runError = "";
    doneReceived = false;
    runState = "running";
    const task = taskInput;
    const myGen = ++runGen;
    void (async () => {
      const started = await startRun(agentId, task);
      if (myGen !== runGen) return; // Clear/navigate happened during the POST — discard this start
      if (!started.ok) {
        // Couldn't even start — cause→consequence→recovery inline (no run executed).
        runState = "error";
        runError = started.error;
        return;
      }
      const source = new EventSource(runEventsUrl(started.value.id), { withCredentials: true });
      es = source;
      source.addEventListener("message", (e) => {
        if (myGen !== runGen) return; // a superseded stream must not write into the current pane
        try {
          transcript = [...transcript, JSON.parse((e as MessageEvent).data) as RunMessage];
        } catch {
          /* skip an unreadable frame rather than break the stream */
        }
      });
      source.addEventListener("done", (e) => {
        if (myGen !== runGen) return;
        doneReceived = true;
        try {
          const { status } = JSON.parse((e as MessageEvent).data) as { status: "succeeded" | "failed" | "killed" };
          runState = status;
        } catch {
          runState = "failed";
        }
        closeStream(); // we own the close so the browser doesn't auto-reconnect
        // Pull the daily spend (for the meter) + the persisted run reason (the killed/failed cause).
        void getAgentCost(agentId).then((c) => { if (myGen === runGen && c) todayMicros = c.todayMicros; });
        void getRun(started.value.id).then((r) => { if (myGen === runGen && r.ok && r.value) runReason = r.value.reason ?? ""; });
      });
      source.onerror = () => {
        if (myGen !== runGen) return;
        // EventSource also fires error when the server closes normally — only surface it if we
        // never received the terminal `done` (a genuine mid-stream drop).
        if (!doneReceived) {
          runState = "error";
          runError = "The test stream dropped before finishing. Check the control plane, then run the test again.";
        }
        closeStream();
      };
    })();
  }

  export function clearTest() {
    runGen++; // discard any in-flight start that resolves after this reset
    closeStream();
    transcript = [];
    runError = "";
    runReason = "";
    runState = "empty";
  }

  // A different agent starts with a fresh console.
  $effect(() => {
    void agentId;
    clearTest();
  });

  onDestroy(closeStream);
</script>

<aside class="console" aria-label="Test console">
  <header>
    <span class="micro">Test console</span>
    <div class="head-actions">
      <button type="button" class="ghost small" onclick={clearTest} disabled={transcript.length === 0 && runState === "empty"}>
        Clear
      </button>
      <button type="button" class="icon" onclick={onClose} aria-label="Close test console">
        <X size={13} color="currentColor" />
      </button>
    </div>
  </header>

  <div class="transcript" role="log" aria-live="polite">
    {#if transcript.length === 0 && runState === "empty"}
      <p class="muted">No test runs.</p>
    {:else}
      <RunTranscript {transcript} />

      {#if runState !== "empty" && runState !== "error"}
        <div class="resolution">
          <RunStatusDot status={runState} />
          {#if lastMetrics}
            <!-- Live: streams as the Guard reports each call's cost; resolves with the terminal dot. -->
            <span class="metrics mono-num">{fmtNum(lastMetrics.latencyMs)} ms · {fmtNum(lastMetrics.tokens)} tokens · {formatMicros(lastMetrics.costMicros)}</span>
          {/if}
        </div>
        {#if runReason && (runState === "killed" || runState === "failed")}
          <p class="run-reason">{runReason}</p>
        {/if}
        {#if costCap.perRun || costCap.perDay}
          <p class="cost-meter mono-num">
            {#if costCap.perRun}run {formatMicros(runCostMicros)} / ${formatMinor(costCap.perRun.minor)}{/if}
            {#if costCap.perRun && costCap.perDay} · {/if}
            {#if costCap.perDay}today {formatMicros(todayMicros ?? 0)} / ${formatMinor(costCap.perDay.minor)}{/if}
          </p>
        {/if}
      {/if}
    {/if}

    {#if runState === "error"}
      <p class="run-error">
        <Circle size={7} fill="var(--state-failed)" color="var(--state-failed)" aria-hidden="true" />
        <span>{runError}</span>
      </p>
    {/if}
  </div>

  <div class="composer">
    <label class="visually-hidden" for="task-input">Task for this test run</label>
    <textarea id="task-input" rows="3" placeholder="What should it do?" bind:value={taskInput}></textarea>
    <div class="composer-actions">
      <span class="foot" class:caution={dirty}>
        {dirty ? "unsaved edits are not included" : "runs the saved draft"}
      </span>
      <button type="button" class="primary" onclick={runTest} disabled={runState === "running"}>Run test</button>
    </div>
  </div>
</aside>

<style>
  /* Docked, not in flow (as in the design). Keeping it as a flex sibling would let it squeeze
     the editor pane to nothing on a narrow window — a full-height drawer that overlays the right
     edge costs nothing but the space it covers, and only while it's open. */
  .console {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    z-index: 40;
    width: 420px;
    max-width: 100%;
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-left: 1px solid var(--border-subtle);
    background: var(--bg-sunken);
    box-shadow: var(--shadow-lg);
  }
  header {
    flex: none;
    height: 40px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    padding: 0 var(--space-2-5) 0 var(--space-4);
    border-bottom: 1px solid var(--border-hairline);
  }
  .micro {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: var(--tracking-micro);
    text-transform: uppercase;
    color: var(--text-tertiary);
  }
  .head-actions {
    display: flex;
    align-items: center;
    gap: var(--space-1);
  }
  .transcript {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-4);
  }
  .resolution {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }
  .run-reason {
    margin: var(--space-1) 0 0;
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }
  .cost-meter {
    margin: var(--space-1) 0 0;
    font-size: var(--text-sm); /* ≥ 12px, mono/tabular */
    color: var(--text-tertiary); /* neutral until near a cap */
  }
  .metrics {
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }
  .run-error {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    margin: 0;
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }
  .muted {
    margin: 0;
    color: var(--text-tertiary);
    font-size: var(--text-sm);
  }
  .composer {
    flex: none;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3);
    border-top: 1px solid var(--border-hairline);
  }
  .composer textarea {
    width: 100%;
    box-sizing: border-box;
    resize: none;
    padding: var(--space-2) var(--space-2-5);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    line-height: var(--lh-xs);
    color: var(--text-primary);
    background: var(--surface-card);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
  }
  .composer textarea:focus-visible {
    outline: none;
    border-color: var(--border-focus);
    box-shadow: var(--focus-ring);
  }
  .composer-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2-5);
  }
  .foot {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-tertiary);
  }
  .foot.caution {
    color: var(--caution-600);
  }
  .primary,
  .ghost,
  .icon {
    font-size: var(--text-xs);
    font-weight: var(--weight-medium);
    border-radius: var(--radius-md);
    cursor: pointer;
    transition: var(--transition-control);
  }
  .primary {
    height: 28px;
    padding: 0 var(--space-3);
    color: var(--action-primary-fg);
    background: var(--action-primary-bg);
    border: 1px solid transparent;
  }
  .primary:hover:not(:disabled) {
    background: var(--action-primary-bg-hover);
  }
  .primary:disabled {
    color: var(--text-disabled);
    background: var(--surface-inset);
    cursor: not-allowed;
  }
  .ghost {
    height: 22px;
    padding: 0 7px;
    font-size: var(--text-2xs);
    color: var(--action-ghost-fg);
    background: transparent;
    border: 1px solid transparent;
  }
  .ghost:hover:not(:disabled) {
    color: var(--text-primary);
    background: var(--surface-hover);
  }
  .ghost:disabled {
    color: var(--text-disabled);
    cursor: not-allowed;
  }
  .icon {
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-tertiary);
    background: transparent;
    border: 1px solid transparent;
  }
  .icon:hover {
    color: var(--text-primary);
    background: var(--surface-hover);
  }
  .primary:focus-visible,
  .ghost:focus-visible,
  .icon:focus-visible {
    outline: none;
    box-shadow: var(--focus-ring);
  }
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
