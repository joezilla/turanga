<script lang="ts">
  // Agents surface (Story 3.1): create + list + Draft state. Story 5.2 makes the list live: each
  // Active agent shows its live Lifecycle State (dot + word) and a live daily-spend meter (today's
  // spend vs the per-day cap), refreshed by a visibility-aware poll.
  import { listAgents, createAgent, type Agent } from "$lib/agents";
  import { formatMinor, formatMicros, meterTone } from "$lib/money";
  import { getAgentsCost } from "$lib/runs";
  import StatusDot from "$lib/components/StatusDot.svelte";

  const POLL_MS = 5000; // agents-list refresh cadence while the tab is visible

  let agents = $state<Agent[]>([]);
  let costs = $state<Record<string, number>>({}); // agentId → today's spend (micro-USD); absent ⇒ 0
  let loading = $state(true);
  let loadError = $state("");
  let creating = $state(false);
  let createError = $state("");
  let filter = $state("");
  let filterEl = $state<HTMLInputElement | null>(null);
  let refreshing = false; // guards against overlapping polls

  // Initial / explicit load (mount, Create, Retry) — shows the loading state and surfaces errors.
  async function load() {
    loading = true;
    const r = await listAgents();
    loading = false;
    if (r.ok) {
      agents = r.value;
      loadError = "";
      costs = await getAgentsCost();
    } else {
      loadError = r.error;
    }
  }

  // Background poll — no loading flash, no transient error surfaced. A failed refresh keeps the
  // last-known list + costs (a blip must not blank the page or clobber the meter). The client-side
  // `filter` is derived (`shown`), so refreshing the array preserves the user's filter.
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      const r = await listAgents();
      if (r.ok) {
        agents = r.value; // live Lifecycle State (StatusDot reads agent.state)
        loadError = "";
        costs = await getAgentsCost(); // live daily-spend meter
      }
    } finally {
      refreshing = false;
    }
  }

  // Mount: load once, then poll every POLL_MS but only while the document is visible (pause when
  // hidden; refresh immediately on becoming visible again). The effect's teardown clears both.
  $effect(() => {
    load();
    const tick = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const timer = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  });

  const shown = $derived(
    filter.trim() ? agents.filter((a) => a.name.toLowerCase().includes(filter.trim().toLowerCase())) : agents,
  );

  async function onCreate() {
    creating = true;
    createError = "";
    const r = await createAgent();
    creating = false;
    if (r.ok) {
      await load();
    } else {
      createError = r.error;
    }
  }

  // Press "/" (when not already typing in a field) to focus the filter. [EXPERIENCE.md]
  function onKeydown(e: KeyboardEvent) {
    if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    const tag = t?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || t?.isContentEditable) return;
    e.preventDefault();
    filterEl?.focus();
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="head">
  <h1>Agents</h1>
  {#if agents.length > 0}
    <button class="primary" onclick={onCreate} disabled={creating}>Create agent</button>
  {/if}
</div>

{#if loading}
  <p class="muted">Loading agents…</p>
{:else if loadError}
  <div class="empty">
    <p class="error">{loadError}</p>
    <button class="primary" onclick={load} disabled={creating}>Retry</button>
  </div>
{:else if agents.length === 0}
  <div class="empty">
    <p>No agents yet.</p>
    <button class="primary" onclick={onCreate} disabled={creating}>Create agent</button>
    {#if createError}<p class="error">{createError}</p>{/if}
  </div>
{:else}
  <input
    class="filter"
    type="text"
    bind:this={filterEl}
    bind:value={filter}
    placeholder="Filter agents"
    aria-label="Filter agents"
  />
  {#if createError}<p class="error">{createError}</p>{/if}
  <ul class="agents">
    {#each shown as agent (agent.id)}
      <li>
        <a class="agent" href="/agents/{agent.id}">
          <span class="name">{agent.name}</span>
          <span class="meta">
            {#if agent.state === "active"}
              <span
                class="meter"
                class:warn={meterTone(costs[agent.id] ?? 0, agent.costCap.perDay?.minor ?? null) === "warn"}
              >
                today {formatMicros(costs[agent.id] ?? 0)}{#if agent.costCap.perDay} / ${formatMinor(agent.costCap.perDay.minor)}{/if}
              </span>
            {/if}
            <StatusDot status={agent.state} />
          </span>
        </a>
      </li>
    {/each}
    {#if shown.length === 0}
      <li class="no-match muted">No agents match "{filter}".</li>
    {/if}
  </ul>
{/if}

<style>
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    margin: 0 0 var(--space-4);
  }
  h1 {
    margin: 0;
    font-size: var(--text-2xl);
    line-height: var(--lh-2xl);
    font-weight: var(--weight-semibold);
    letter-spacing: var(--tracking-heading);
    color: var(--text-primary);
  }
  .primary {
    height: var(--control-h-md);
    padding: 0 var(--space-4);
    background: var(--action-primary-bg);
    color: var(--action-primary-fg);
    border: none;
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    cursor: pointer;
  }
  .primary:disabled {
    color: var(--text-disabled);
    cursor: default;
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
  .filter {
    width: 100%;
    max-width: 560px;
    height: var(--control-h-md);
    padding: 0 var(--space-3);
    font-size: var(--text-sm);
    color: var(--text-primary);
    background: var(--surface-card);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    margin: 0 0 var(--space-3);
  }
  .agents {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    max-width: 560px;
  }
  .agent {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    background: var(--surface-card);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    text-decoration: none;
    color: inherit;
  }
  .agent:hover {
    background: var(--surface-raised);
    border-color: var(--border-strong);
  }
  .agent:focus-visible {
    outline: 2px solid var(--focus-ring);
    outline-offset: 2px;
  }
  .name {
    font-size: var(--text-sm);
    color: var(--text-primary);
  }
  .meta {
    display: inline-flex;
    align-items: center;
    gap: var(--space-3);
  }
  /* Per-Active-agent live daily-spend meter (Story 5.2) — mono/tabular; neutral until near the cap. */
  .meter {
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    font-size: var(--text-xs);
    color: var(--text-tertiary);
    white-space: nowrap;
  }
  /* Near/over the per-day cap — caution tone (never color-only: the numbers still read literally). */
  .meter.warn {
    color: var(--caution-500);
  }
  .muted {
    color: var(--text-tertiary);
    font-size: var(--text-sm);
  }
  .no-match {
    padding: var(--space-3) var(--space-4);
  }
  .error {
    margin: 0 0 var(--space-3);
    color: var(--state-failed);
    font-size: var(--text-sm);
  }
</style>
