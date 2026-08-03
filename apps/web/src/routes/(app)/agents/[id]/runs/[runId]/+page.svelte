<script lang="ts">
  // Single-run review (Story 5.3, AC1/AC2): renders a past run's persisted record — the outcome +
  // cause (status dot + reason), when it ran, the task, the transcript (turns + per-call metrics +
  // Guard/permission refusals), and the total cost. Read-only over GET /runs/:id (E4-AD-7).
  import { page } from "$app/state";
  import { ArrowLeft } from "@lucide/svelte";
  import { getRun, type Run } from "$lib/runs";
  import { formatMicros } from "$lib/money";
  import { formatTimestamp } from "$lib/datetime";
  import RunStatusDot from "$lib/components/RunStatusDot.svelte";
  import RunTranscript from "$lib/components/RunTranscript.svelte";

  const id = $derived(page.params.id ?? "");
  const runId = $derived(page.params.runId ?? "");

  let run = $state<Run | null>(null);
  let loading = $state(true);

  async function load() {
    loading = true;
    run = await getRun(runId); // null on 404 / unreachable
    loading = false;
  }
  $effect(() => {
    load();
  });
</script>

<div class="head">
  <a class="back" href="/agents/{id}/runs" aria-label="Back to run history"><ArrowLeft size={16} color="currentColor" /></a>
  <h1>Run</h1>
</div>

{#if loading}
  <p class="muted">Loading run…</p>
{:else if !run}
  <div class="empty">
    <p>That run doesn't exist.</p>
    <a class="primary" href="/agents/{id}/runs">Back to run history</a>
  </div>
{:else}
  <div class="review">
    <!-- Outcome + cause (AC2): the status dot + word, and for a killed/failed run its reason. -->
    <div class="outcome">
      <RunStatusDot status={run.status} />
      <span class="when mono-num">{formatTimestamp(run.createdAt)}</span>
      <span class="cost mono-num">{formatMicros(run.costMicros)}</span>
    </div>
    {#if run.reason && (run.status === "killed" || run.status === "failed")}
      <p class="reason">{run.reason}</p>
    {/if}

    <div class="task">
      <span class="label">Task</span>
      <p class="task-text">{run.taskInput || "—"}</p>
    </div>

    <!-- Transcript (AC1): turns, per-call metrics, and any Guard/permission refusals. -->
    <div class="transcript" role="log">
      {#if run.transcript.length === 0}
        <p class="muted">No transcript recorded.</p>
      {:else}
        <RunTranscript transcript={run.transcript} showMetrics />
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
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    text-decoration: none;
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
