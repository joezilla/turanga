<script lang="ts">
  // Tools tab — the design's grouped, filterable operation list. Replaces the chip-and-popover
  // ToolsEditor from Story 6.3 with a single flat surface: one collapsible group per connected
  // tool, one checkbox row per operation it offers.
  //
  // The permission model is unchanged and still default-deny: an attached tool with zero granted
  // operations grants nothing, and the control-api validates every operation against what the
  // tool actually offers. Unchecking a tool's last operation drops the attachment entirely.
  //
  // OMITTED FROM THE DESIGN, deliberately: the read/write/destructive risk column, the risk
  // filter, and the "N destructive operations enabled" warning. `ToolOperation` carries no risk
  // field — control-api discovers operations over MCP and MCP does not report one. Deriving it
  // from the operation name would render a guess as fact next to a permission checkbox, which is
  // exactly where a wrong label does the most damage. If risk lands in the contract, this file
  // and the filter bar below are where it goes.
  import { ChevronRight } from "@lucide/svelte";
  import type { AttachedTool } from "$lib/agents";
  import type { Tool } from "$lib/tools";

  let { value, tools, onchange }: { value: AttachedTool[]; tools: Tool[]; onchange: (attached: AttachedTool[]) => void } = $props();

  let search = $state("");
  let enabledOnly = $state(false);
  let groupFilter = $state<string | null>(null); // toolId, or null for "all"
  let collapsed = $state<Record<string, boolean>>({});
  let searchEl = $state<HTMLInputElement | null>(null);

  // Only connected tools are grantable — an unverified or errored tool can't be invoked, so
  // offering its operations would promise something the Guard would refuse.
  const connected = $derived(tools.filter((t) => t.status === "connected"));
  const grantsById = $derived(new Map(value.map((a) => [a.toolId, new Set(a.operations)])));

  const isOn = (toolId: string, op: string) => grantsById.get(toolId)?.has(op) ?? false;

  const groups = $derived.by(() => {
    const q = search.trim().toLowerCase();
    return connected
      .filter((t) => groupFilter === null || t.id === groupFilter)
      .map((tool) => {
        const rows = tool.operations
          .filter((op) => !q || op.name.toLowerCase().includes(q) || (op.description ?? "").toLowerCase().includes(q))
          .filter((op) => !enabledOnly || isOn(tool.id, op.name));
        const granted = tool.operations.filter((op) => isOn(tool.id, op.name)).length;
        return { tool, rows, granted };
      })
      .filter((g) => g.rows.length > 0);
  });

  const totalOps = $derived(connected.reduce((n, t) => n + t.operations.length, 0));
  const grantedOps = $derived(connected.reduce((n, t) => n + t.operations.filter((op) => isOn(t.id, op.name)).length, 0));
  const shownOps = $derived(groups.reduce((n, g) => n + g.rows.length, 0));

  /** Write a tool's full operation set back, dropping the attachment when nothing is granted. */
  function setOperations(toolId: string, ops: string[]) {
    const others = value.filter((a) => a.toolId !== toolId);
    onchange(ops.length > 0 ? [...others, { toolId, operations: ops }] : others);
  }

  function toggle(toolId: string, op: string, on: boolean) {
    const current = value.find((a) => a.toolId === toolId)?.operations ?? [];
    setOperations(toolId, on ? [...current, op] : current.filter((o) => o !== op));
  }

  /** Grant/revoke every operation currently visible in a group (respects the active filters). */
  function bulkGroup(toolId: string, visible: string[], on: boolean) {
    const current = value.find((a) => a.toolId === toolId)?.operations ?? [];
    setOperations(toolId, on ? [...new Set([...current, ...visible])] : current.filter((o) => !visible.includes(o)));
  }

  function enableAllShown() {
    let next = value;
    for (const g of groups) {
      const current = next.find((a) => a.toolId === g.tool.id)?.operations ?? [];
      const ops = [...new Set([...current, ...g.rows.map((r) => r.name)])];
      next = [...next.filter((a) => a.toolId !== g.tool.id), { toolId: g.tool.id, operations: ops }];
    }
    onchange(next);
  }

  function clearAll() {
    onchange([]);
  }

  // "/" focuses the filter, matching the agents list. The badge in the field says so.
  function onKeydown(e: KeyboardEvent) {
    if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t?.tagName === "INPUT" || t?.tagName === "TEXTAREA" || t?.isContentEditable) return;
    e.preventDefault();
    searchEl?.focus();
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if connected.length === 0}
  <div class="pad">
    <p class="empty">No tools are connected. Connect one in Settings → Tools, then grant its operations here.</p>
    <a class="link" href="/settings/tools">Open Tools settings</a>
  </div>
{:else}
  <div class="bar">
    <div class="bar-row">
      <div class="field">
        <input
          type="text"
          bind:this={searchEl}
          bind:value={search}
          placeholder="Filter operations by name or description"
          aria-label="Filter operations"
        />
        <span class="kbd" aria-hidden="true">/</span>
      </div>
      <label class="check">
        <input type="checkbox" bind:checked={enabledOnly} />
        Granted only
      </label>
      <div class="grow"></div>
      <button type="button" class="secondary" onclick={enableAllShown} disabled={shownOps === 0}>Grant all shown</button>
      <button type="button" class="ghost" onclick={clearAll} disabled={grantedOps === 0}>Clear all</button>
    </div>

    <div class="chips">
      <button type="button" class="chip" class:on={groupFilter === null} onclick={() => (groupFilter = null)}>
        All tools <span class="chip-count">{totalOps}</span>
      </button>
      {#each connected as tool (tool.id)}
        <button type="button" class="chip" class:on={groupFilter === tool.id} onclick={() => (groupFilter = tool.id)}>
          {tool.name} <span class="chip-count">{tool.operations.length}</span>
        </button>
      {/each}
    </div>

    <p class="summary">
      <span class="mono-num strong">{grantedOps}</span> of <span class="mono-num">{totalOps}</span> operations granted ·
      <span class="mono-num">{shownOps}</span> shown
    </p>
  </div>

  <div class="list">
    {#each groups as g (g.tool.id)}
      {@const open = !collapsed[g.tool.id]}
      {@const visible = g.rows.map((r) => r.name)}
      {@const allVisibleOn = visible.every((op) => isOn(g.tool.id, op))}
      <section class="group">
        <div class="group-head">
          <button
            type="button"
            class="group-toggle"
            aria-expanded={open}
            onclick={() => (collapsed = { ...collapsed, [g.tool.id]: open })}
          >
            <span class="caret" class:open aria-hidden="true"><ChevronRight size={10} color="currentColor" /></span>
            <span class="group-name">{g.tool.name}</span>
            <span class="group-ratio mono-num">{g.granted}/{g.tool.operations.length}</span>
          </button>
          <button type="button" class="ghost small" onclick={() => bulkGroup(g.tool.id, visible, !allVisibleOn)}>
            {allVisibleOn ? "Revoke shown" : "Grant shown"}
          </button>
        </div>

        {#if open}
          <div class="rows">
            {#each g.rows as op (op.name)}
              <label class="row" class:on={isOn(g.tool.id, op.name)}>
                <input
                  type="checkbox"
                  checked={isOn(g.tool.id, op.name)}
                  onchange={(e) => toggle(g.tool.id, op.name, (e.currentTarget as HTMLInputElement).checked)}
                />
                <span class="row-body">
                  <span class="op-name">{op.title ?? op.name}</span>
                  {#if op.description}<span class="op-desc">{op.description}</span>{/if}
                </span>
              </label>
            {/each}
          </div>
        {/if}
      </section>
    {/each}

    {#if groups.length === 0}
      <p class="no-match">No operations match this filter.</p>
    {/if}
  </div>
{/if}

<style>
  .bar {
    flex: none;
    display: flex;
    flex-direction: column;
    gap: var(--space-2-5);
    padding: var(--space-3) var(--space-5);
    border-bottom: 1px solid var(--border-hairline);
    background: var(--surface-card);
  }
  .bar-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .field {
    position: relative;
    flex: 1 1 240px;
    min-width: 240px;
    max-width: 380px;
  }
  .field input {
    width: 100%;
    height: 30px;
    box-sizing: border-box;
    padding: 0 34px 0 var(--control-pad-x);
    font-size: var(--text-sm);
    color: var(--text-primary);
    background: var(--surface-inset);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
  }
  .field input:focus-visible {
    outline: none;
    background: var(--surface-card);
    border-color: var(--border-focus);
    box-shadow: var(--focus-ring);
  }
  .kbd {
    position: absolute;
    top: 7px;
    right: var(--space-2);
    padding: 1px 4px;
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-tertiary);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-xs);
  }
  .check {
    display: flex;
    align-items: center;
    gap: var(--space-1-5);
    font-size: var(--text-xs);
    color: var(--text-secondary);
    cursor: pointer;
  }
  .grow {
    flex: 1 1 0;
    min-width: 0;
  }
  .chips {
    display: flex;
    align-items: center;
    gap: var(--space-1-5);
    flex-wrap: wrap;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1-5);
    height: 24px;
    padding: 0 var(--space-2);
    font-size: var(--text-xs);
    color: var(--text-secondary);
    background: var(--surface-inset);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md); /* rectangular — pills mean live status only */
    cursor: pointer;
  }
  .chip:hover {
    color: var(--text-primary);
    background: var(--surface-hover);
  }
  .chip.on {
    color: var(--text-primary);
    background: var(--surface-selected);
    border-color: var(--border-strong);
  }
  .chip-count {
    font-family: var(--font-mono);
    font-size: 10px;
    opacity: 0.7;
  }
  .summary {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--text-secondary);
  }
  .summary .strong {
    color: var(--text-primary);
  }
  .list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: var(--space-2) var(--space-5) var(--space-24);
  }
  .group {
    border-bottom: 1px solid var(--border-hairline);
  }
  .group-head {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    align-items: center;
    gap: var(--space-2-5);
    height: 34px;
    background: var(--bg-canvas);
  }
  .group-toggle {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 0;
    color: var(--text-primary);
    background: transparent;
    border: none;
    cursor: pointer;
  }
  .caret {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 10px;
    color: var(--text-tertiary);
    transition: transform var(--duration-fast) var(--ease-standard);
  }
  .caret.open {
    transform: rotate(90deg);
  }
  .group-name {
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    letter-spacing: -0.004em;
  }
  .group-ratio {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-tertiary);
  }
  .group-head .small {
    margin-left: auto;
  }
  .rows {
    display: flex;
    flex-direction: column;
    padding-bottom: var(--space-2);
  }
  .row {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2-5);
    padding: var(--space-1-5) var(--space-2);
    border-radius: var(--radius-md);
    cursor: pointer;
  }
  .row:hover {
    background: var(--surface-hover);
  }
  .row input {
    width: 13px;
    height: 13px;
    margin: 5px 0 0;
    flex: none;
  }
  .row input:focus-visible {
    outline: none;
    box-shadow: var(--focus-ring);
  }
  .row-body {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .op-name {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-primary);
  }
  .op-desc {
    font-size: var(--text-xs);
    line-height: var(--lh-xs);
    color: var(--text-secondary);
  }
  .no-match {
    padding: var(--space-10) 0;
    margin: 0;
    text-align: center;
    font-size: var(--text-sm);
    color: var(--text-tertiary);
  }
  .pad {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-2);
    padding: var(--space-6) var(--space-5);
  }
  .empty {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }
  .link {
    font-size: var(--text-sm);
    color: var(--text-link);
  }
  .secondary,
  .ghost {
    height: 28px;
    padding: 0 var(--control-pad-x);
    font-size: var(--text-xs);
    font-weight: var(--weight-medium);
    border-radius: var(--radius-md);
    cursor: pointer;
    transition: var(--transition-control);
  }
  .ghost.small {
    height: 22px;
    padding: 0 7px;
    font-size: var(--text-2xs);
  }
  .secondary {
    color: var(--action-secondary-fg);
    background: var(--action-secondary-bg);
    border: 1px solid var(--border-strong);
  }
  .secondary:hover:not(:disabled) {
    background: var(--surface-hover);
  }
  .ghost {
    color: var(--action-ghost-fg);
    background: transparent;
    border: 1px solid transparent;
  }
  .ghost:hover:not(:disabled) {
    color: var(--text-primary);
    background: var(--surface-hover);
  }
  .secondary:disabled,
  .ghost:disabled {
    color: var(--text-disabled);
    cursor: not-allowed;
  }
  .secondary:focus-visible,
  .ghost:focus-visible,
  .chip:focus-visible,
  .group-toggle:focus-visible {
    outline: none;
    box-shadow: var(--focus-ring);
  }
</style>
