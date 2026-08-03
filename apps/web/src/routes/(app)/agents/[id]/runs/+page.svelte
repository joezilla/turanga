<script lang="ts">
  // Run history (Story 5.3, AC1/AC2): an agent's past runs, newest-first. Each row is a link to the
  // run-review page and states the outcome (status dot + word), when it ran, its cost, the task, and
  // — for a killed/failed run — the cause (reason). Read-only over GET /runs?agentId (E4-AD-7).
  import { page } from "$app/state";
  import { ArrowLeft } from "@lucide/svelte";
  import { listRuns, runCause, type RunSummary } from "$lib/runs";
  import { formatMicros } from "$lib/money";
  import { formatTimestamp } from "$lib/datetime";
  import RunStatusDot from "$lib/components/RunStatusDot.svelte";

  const RUN_LIMIT = 100; // control-api's newest-first list cap (repo DEFAULT_LIST_LIMIT)
  const id = $derived(page.params.id ?? "");

  let runs = $state<RunSummary[]>([]);
  let loadState = $state<"loading" | "ok" | "error">("loading");
  let loadError = $state("");
  let seq = 0; // discards a superseded in-flight load (fast agent→agent navigation)

  async function load() {
    const s = ++seq;
    loadState = "loading";
    const r = await listRuns(id);
    if (s !== seq) return; // a newer load started — drop this stale response
    if (r.ok) {
      runs = r.value;
      loadState = "ok";
    } else {
      loadError = r.error; // an outage is distinct from an empty history (not "No runs yet.")
      loadState = "error";
    }
  }
  $effect(() => {
    load();
  });
</script>

<div class="head">
  <a class="back" href="/agents/{id}" aria-label="Back to agent"><ArrowLeft size={16} color="currentColor" /></a>
  <h1>Run history</h1>
</div>

{#if loadState === "loading"}
  <p class="muted">Loading runs…</p>
{:else if loadState === "error"}
  <div class="empty">
    <p class="error">{loadError}</p>
    <button class="primary" onclick={load}>Retry</button>
  </div>
{:else if runs.length === 0}
  <div class="empty">
    <p>No runs yet.</p>
    <a class="primary" href="/agents/{id}">Run test</a>
  </div>
{:else}
  <ul class="runs">
    {#each runs as run (run.id)}
      {@const cause = runCause(run.status, run.reason)}
      <li>
        <a class="run" href="/agents/{id}/runs/{run.id}">
          <span class="run-main">
            <RunStatusDot status={run.status} />
            <span class="task">{run.taskInput || "—"}</span>
          </span>
          <span class="run-meta">
            <span class="when mono-num">{formatTimestamp(run.createdAt)}</span>
            <span class="cost mono-num">{formatMicros(run.costMicros)}</span>
          </span>
          {#if cause}
            <span class="reason">{cause}</span>
          {/if}
        </a>
      </li>
    {/each}
  </ul>
  {#if runs.length >= RUN_LIMIT}
    <p class="muted cap-note">Showing the latest {RUN_LIMIT} runs.</p>
  {/if}
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
  .cap-note {
    margin: var(--space-3) 0 0;
  }
  .runs {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    max-width: 720px;
  }
  .run {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: center;
    gap: var(--space-2) var(--space-4);
    padding: var(--space-3) var(--space-4);
    background: var(--surface-card);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    text-decoration: none;
    color: inherit;
  }
  .run:hover {
    background: var(--surface-raised);
    border-color: var(--border-strong);
  }
  .run:focus-visible {
    outline: 2px solid var(--focus-ring);
    outline-offset: 2px;
  }
  .run-main {
    display: inline-flex;
    align-items: center;
    gap: var(--space-3);
    min-width: 0;
  }
  .task {
    font-size: var(--text-sm);
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .run-meta {
    display: inline-flex;
    align-items: center;
    gap: var(--space-3);
    font-size: var(--text-xs);
    color: var(--text-tertiary);
  }
  /* The killed/failed cause, on its own line spanning both columns (AC2 legibility). */
  .reason {
    grid-column: 1 / -1;
    font-size: var(--text-sm);
    color: var(--text-secondary);
    overflow-wrap: anywhere; /* a long unbroken token (URL/base64) must not overflow the card */
  }
</style>
