<script lang="ts">
  // Agents workspace — master/detail. The 264px list column stays put while an agent is open
  // (the design's Agent Management spec); the route's content fills the rest.
  //
  // The polling behaviour is carried over unchanged from the old /agents page (Story 5.2): a
  // visibility-aware 5s refresh of the list + daily spend, with a failed refresh keeping the
  // last-known values rather than blanking the column.
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { listAgents, createAgent, type Agent } from "$lib/agents";
  import { formatMinor, formatMicros, meterTone } from "$lib/money";
  import { getAgentsCost } from "$lib/runs";
  import ControlStatus from "$lib/components/ControlStatus.svelte";
  import { agentsBus } from "$lib/agentsBus.svelte";

  let { children } = $props();

  const POLL_MS = 5000;

  let agents = $state<Agent[]>([]);
  let costs = $state<Record<string, number>>({}); // agentId → today's spend (micro-USD); absent ⇒ 0
  let loading = $state(true);
  let loadError = $state("");
  let creating = $state(false);
  let createError = $state("");
  let filter = $state("");
  let filterEl = $state<HTMLInputElement | null>(null);
  let refreshing = false; // guards against overlapping polls

  const selectedId = $derived(page.params.id ?? "");

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

  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      const r = await listAgents();
      if (r.ok) {
        agents = r.value;
        loadError = "";
        costs = await getAgentsCost();
      }
    } finally {
      refreshing = false;
    }
  }

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

  // The editor bumps this after a save/publish/duplicate — refresh now rather than on the next tick.
  $effect(() => {
    if (agentsBus.rev > 0) void refresh();
  });

  const shown = $derived(
    filter.trim() ? agents.filter((a) => a.name.toLowerCase().includes(filter.trim().toLowerCase())) : agents,
  );
  const draftCount = $derived(agents.filter((a) => a.dirty).length);

  async function onCreate() {
    creating = true;
    createError = "";
    const r = await createAgent();
    creating = false;
    if (r.ok) {
      await load();
      await goto(`/agents/${r.value.id}`); // land in the editor — the design has no separate list page
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

<aside class="column">
  <header>
    <h2 class="title">Agents</h2>
    <button type="button" class="secondary" onclick={onCreate} disabled={creating}>New</button>
  </header>

  <div class="search">
    <input type="text" bind:this={filterEl} bind:value={filter} placeholder="Search agents" aria-label="Search agents" />
  </div>

  {#if createError}<p class="msg error">{createError}</p>{/if}

  <div class="rows">
    {#if loading}
      <p class="msg">Loading agents…</p>
    {:else if loadError}
      <div class="msg-block">
        <p class="msg error">{loadError}</p>
        <button type="button" class="secondary" onclick={load}>Retry</button>
      </div>
    {:else if agents.length === 0}
      <div class="msg-block">
        <p class="msg">No agents yet.</p>
        <button type="button" class="secondary" onclick={onCreate} disabled={creating}>Create the first one</button>
      </div>
    {:else if shown.length === 0}
      <p class="msg">No agents match "{filter}".</p>
    {:else}
      {#each shown as agent (agent.id)}
        <a class="row" href="/agents/{agent.id}" aria-current={agent.id === selectedId ? "page" : undefined}>
          <span class="row-top">
            <span class="dot" class:live={agent.state === "active"} aria-hidden="true"></span>
            <span class="name">{agent.name}</span>
            <span class="state-word">{agent.state === "active" ? "active" : "draft"}</span>
            {#if agent.dirty}<span class="tag">unpublished</span>{/if}
          </span>
          <span class="row-bottom mono-num">
            <span class="id">{agent.id}</span>
            {#if agent.state === "active"}
              <span class="meter" class:warn={meterTone(costs[agent.id] ?? 0, agent.costCap.perDay?.minor ?? null) === "warn"}>
                {formatMicros(costs[agent.id] ?? 0)}{#if agent.costCap.perDay} / ${formatMinor(agent.costCap.perDay.minor)}{/if}
              </span>
            {/if}
          </span>
        </a>
      {/each}
    {/if}
  </div>

  <footer>
    <span class="micro">{agents.length} agents · {draftCount} unpublished</span>
    <ControlStatus />
  </footer>
</aside>

{@render children()}

<style>
  .column {
    width: 264px;
    flex: none;
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-right: 1px solid var(--border-hairline);
    background: var(--bg-sunken);
  }
  header {
    flex: none;
    height: 48px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 var(--space-2-5) 0 var(--space-4);
    border-bottom: 1px solid var(--border-hairline);
  }
  .title {
    margin: 0;
    font-size: var(--text-base);
    font-weight: var(--weight-medium);
    letter-spacing: -0.008em;
  }
  .search {
    flex: none;
    padding: var(--space-2-5);
    border-bottom: 1px solid var(--border-hairline);
  }
  .search input {
    width: 100%;
    height: 28px;
    box-sizing: border-box;
    padding: 0 var(--space-2);
    font-size: var(--text-sm);
    color: var(--text-primary);
    background: var(--surface-inset);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
  }
  .search input:focus-visible {
    outline: none;
    background: var(--surface-card);
    border-color: var(--border-focus);
    box-shadow: var(--focus-ring);
  }
  .rows {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: var(--space-1-5) 0;
  }
  .row {
    display: flex;
    flex-direction: column;
    gap: var(--space-0-5);
    padding: var(--space-1-5) var(--space-4);
    text-decoration: none;
    color: var(--text-primary);
    border-left: 2px solid transparent;
  }
  .row:hover {
    background: var(--surface-hover);
  }
  .row[aria-current="page"] {
    background: var(--surface-selected);
    border-left-color: var(--text-primary);
  }
  .row:focus-visible {
    outline: none;
    box-shadow: var(--focus-ring);
  }
  .row-top {
    display: flex;
    align-items: center;
    gap: var(--space-1-5);
    min-width: 0;
  }
  .dot {
    width: 6px;
    height: 6px;
    flex: none;
    border-radius: var(--radius-full);
    background: var(--state-idle);
  }
  .dot.live {
    background: var(--state-succeeded);
  }
  .name {
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    letter-spacing: -0.004em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* The dot never carries the state on its own (UX-DR15) — the word is the status. */
  .state-word {
    flex: none;
    font-size: var(--text-2xs);
    color: var(--text-tertiary);
  }
  .tag {
    flex: none;
    font-family: var(--font-mono);
    font-size: 9px;
    letter-spacing: var(--tracking-micro);
    text-transform: uppercase;
    color: var(--caution-600);
  }
  .row-bottom {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-tertiary);
  }
  .id {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .meter {
    flex: none;
  }
  .meter.warn {
    color: var(--caution-600);
  }
  footer {
    flex: none;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-2-5) var(--space-4);
    border-top: 1px solid var(--border-hairline);
  }
  .micro {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: var(--tracking-micro);
    text-transform: uppercase;
    color: var(--text-tertiary);
  }
  .msg {
    margin: var(--space-3) var(--space-4);
    font-size: var(--text-sm);
    color: var(--text-tertiary);
  }
  .msg.error {
    color: var(--critical-500);
  }
  .msg-block {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-2);
    padding: 0 var(--space-4);
  }
  .secondary {
    height: 26px;
    padding: 0 var(--space-2);
    font-size: var(--text-xs);
    font-weight: var(--weight-medium);
    color: var(--action-secondary-fg);
    background: var(--action-secondary-bg);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    cursor: pointer;
  }
  .secondary:hover:not(:disabled) {
    background: var(--surface-hover);
  }
  .secondary:disabled {
    color: var(--text-disabled);
    cursor: not-allowed;
  }
  .secondary:focus-visible {
    outline: none;
    box-shadow: var(--focus-ring);
  }
</style>
