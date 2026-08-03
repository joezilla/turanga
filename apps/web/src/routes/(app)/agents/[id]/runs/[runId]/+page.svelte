<script lang="ts">
  // Single-run review (Story 5.3, AC1/AC2): renders a past run's persisted record — the outcome +
  // cause (status dot + reason), when it ran, the task, the transcript (turns + per-call metrics +
  // Guard/permission refusals), and the total cost. Read-only over GET /runs/:id (E4-AD-7).
  import { page } from "$app/state";
  import { ArrowLeft } from "@lucide/svelte";
  import { getRun, runCause, type Run, type RunMessage } from "$lib/runs";
  import { formatMicros } from "$lib/money";
  import { formatTimestamp } from "$lib/datetime";
  import RunStatusDot from "$lib/components/RunStatusDot.svelte";
  import RunTranscript from "$lib/components/RunTranscript.svelte";

  const id = $derived(page.params.id ?? "");
  const runId = $derived(page.params.runId ?? "");

  let run = $state<Run | null>(null);
  let viewState = $state<"loading" | "ok" | "notfound" | "error">("loading");
  let loadError = $state("");
  let seq = 0; // discards a superseded in-flight load (fast run→run navigation)

  async function load() {
    const s = ++seq;
    viewState = "loading";
    const r = await getRun(runId);
    if (s !== seq) return; // a newer load started — drop this stale response
    if (!r.ok) {
      loadError = r.error; // an outage is distinct from a genuine 404
      viewState = "error";
    } else if (!r.value || r.value.agentId !== id) {
      // 404, or a run that belongs to a different agent than the URL claims → treat as not-found
      viewState = "notfound";
    } else {
      run = r.value;
      viewState = "ok";
    }
  }
  $effect(() => {
    load();
  });

  const isRenderable = (m: RunMessage) => m.type === "turn" || m.type === "refusal" || m.type === "metrics" || m.type === "tool";
  const cause = $derived(run ? runCause(run.status, run.reason) : null);
  const inProgress = $derived(run ? run.status === "running" || run.status === "created" : false);
</script>

<div class="head">
  <a class="back" href="/agents/{id}/runs" aria-label="Back to run history"><ArrowLeft size={16} color="currentColor" /></a>
  <h1>Run</h1>
</div>

{#if viewState === "loading"}
  <p class="muted">Loading run…</p>
{:else if viewState === "error"}
  <div class="empty">
    <p class="error">{loadError}</p>
    <button class="primary" onclick={load}>Retry</button>
  </div>
{:else if viewState === "notfound" || !run}
  <div class="empty">
    <p>That run doesn't exist.</p>
    <a class="primary" href="/agents/{id}/runs">Back to run history</a>
  </div>
{:else}
  <div class="review">
    <!-- Outcome + cause (AC2): the status dot + word, timestamps, and — for a killed/failed run — a
         legible cause (the persisted reason, or an honest fallback so "error" is never blank). -->
    <div class="outcome">
      <RunStatusDot status={run.status} />
      <span class="when mono-num">{formatTimestamp(run.createdAt)}{#if run.endedAt} – {formatTimestamp(run.endedAt)}{/if}</span>
      <span class="cost mono-num">{formatMicros(run.costMicros)}</span>
    </div>
    {#if cause}
      <p class="reason">{cause}</p>
    {/if}
    {#if inProgress}
      <p class="in-progress">This run is still in progress — open the agent's test pane for the live view.</p>
    {/if}

    <div class="task">
      <span class="label">Task</span>
      <p class="task-text">{run.taskInput || "—"}</p>
    </div>

    <!-- Transcript (AC1): turns, per-call metrics, and any Guard/permission refusals. -->
    <div class="transcript" role="log">
      {#if run.transcript.some(isRenderable)}
        <RunTranscript transcript={run.transcript} showMetrics />
      {:else}
        <p class="muted">No transcript recorded.</p>
      {/if}
    </div>
  </div>
{/if}

<style>
  .head {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    margin: 0 0 var(--space-4);
  }
  .back {
    display: inline-flex;
    color: var(--text-secondary);
  }
  .back:hover {
    color: var(--text-primary);
  }
  h1 {
    margin: 0;
    font-size: var(--text-2xl);
    line-height: var(--lh-2xl);
    font-weight: var(--weight-semibold);
    letter-spacing: var(--tracking-heading);
    color: var(--text-primary);
  }
  .muted {
    color: var(--text-tertiary);
    font-size: var(--text-sm);
  }
  .empty {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-3);
  }
  .empty p {
    margin: 0;
    color: var(--text-tertiary);
    font-size: var(--text-sm);
  }
  .primary {
    height: var(--control-h-md);
    display: inline-flex;
    align-items: center;
    padding: 0 var(--space-4);
    background: var(--action-primary-bg);
    color: var(--action-primary-fg);
    border: none;
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    text-decoration: none;
    cursor: pointer;
  }
  .error {
    margin: 0;
    color: var(--state-failed);
    font-size: var(--text-sm);
  }
  .review {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    max-width: 720px;
    padding: var(--space-4);
    background: var(--surface-card);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
  }
  .outcome {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    font-size: var(--text-xs);
    color: var(--text-tertiary);
  }
  .reason {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--text-secondary);
    overflow-wrap: anywhere; /* a long unbroken token in a reason must not overflow the card */
  }
  .in-progress {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--text-tertiary);
  }
  .task {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .label {
    font-size: 11px;
    letter-spacing: var(--tracking-micro);
    text-transform: uppercase;
    color: var(--text-tertiary);
  }
  .task-text {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--text-primary);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .transcript {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding-top: var(--space-3);
    border-top: 1px solid var(--border-subtle);
  }
</style>
