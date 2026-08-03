<script lang="ts">
  // Tools section (Story 6.3). Attach a connected tool as a rectangular chip (never a pill) via a
  // searchable picker popover; each chip carries a per-operation grant (a checkbox per operation the
  // tool offers). Default-deny: an attached tool grants nothing until an operation is checked. Config
  // only — the Guard enforces the grants at run time in 6.4. The credential/endpoint never appear here.
  import { tick } from "svelte";
  import { X, Plus } from "@lucide/svelte";
  import type { AttachedTool } from "$lib/agents";
  import type { Tool } from "$lib/tools";

  let { value, tools, onchange }: { value: AttachedTool[]; tools: Tool[]; onchange: (attached: AttachedTool[]) => void } = $props();

  let pickerOpen = $state(false);
  let query = $state("");
  let searchEl = $state<HTMLInputElement | null>(null);
  let addBtn = $state<HTMLButtonElement | null>(null);

  const byId = $derived(new Map(tools.map((t) => [t.id, t])));
  const attachedIds = $derived(new Set(value.map((a) => a.toolId)));
  // Connected tools not already attached (only "connected" tools are grantable).
  const candidates = $derived(
    tools
      .filter((t) => t.status === "connected" && !attachedIds.has(t.id))
      .filter((t) => t.name.toLowerCase().includes(query.trim().toLowerCase())),
  );

  async function openPicker() {
    pickerOpen = true;
    query = "";
    await tick();
    searchEl?.focus();
  }
  function closePicker() {
    pickerOpen = false;
    addBtn?.focus();
  }

  function attach(toolId: string) {
    onchange([...value, { toolId, operations: [] }]); // default-deny — no operation granted yet
    closePicker();
  }
  function remove(toolId: string) {
    onchange(value.filter((a) => a.toolId !== toolId));
  }
  function toggleOperation(toolId: string, op: string, on: boolean) {
    onchange(
      value.map((a) =>
        a.toolId === toolId
          ? { ...a, operations: on ? [...a.operations, op] : a.operations.filter((o) => o !== op) }
          : a,
      ),
    );
  }
</script>

<div class="tools-editor">
  {#if tools.length === 0}
    <p class="muted">No tools connected. Add one in Settings → Tools first.</p>
  {:else if value.length === 0}
    <p class="muted">No tools attached.</p>
  {/if}

  <ul class="chips">
    {#each value as a (a.toolId)}
      {@const tool = byId.get(a.toolId)}
      <li class="chip">
        <div class="chip-head">
          <span class="name">{tool ? tool.name : a.toolId}</span>
          <button type="button" class="remove" aria-label={`Remove ${tool ? tool.name : a.toolId}`} onclick={() => remove(a.toolId)}>
            <X size={14} color="currentColor" />
          </button>
        </div>
        {#if tool && tool.operations.length > 0}
          <fieldset class="operations">
            <legend class="field-label">Granted operations</legend>
            {#each tool.operations as op (op.name)}
              <label class="op">
                <input
                  type="checkbox"
                  checked={a.operations.includes(op.name)}
                  onchange={(e) => toggleOperation(a.toolId, op.name, (e.currentTarget as HTMLInputElement).checked)}
                />
                <span class="op-name">{op.name}</span>
                {#if op.description}<span class="op-desc">{op.description}</span>{/if}
              </label>
            {/each}
          </fieldset>
        {:else if tool}
          <p class="muted small">This tool exposes no operations yet.</p>
        {:else}
          <p class="muted small">This tool is no longer available — remove it.</p>
        {/if}
      </li>
    {/each}
  </ul>

  {#if tools.length > 0}
    <div class="add">
      <button type="button" class="add-btn" bind:this={addBtn} onclick={openPicker} disabled={candidates.length === 0 && !pickerOpen}>
        <Plus size={14} color="currentColor" /> Add a tool
      </button>

      {#if pickerOpen}
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <div
          class="picker"
          role="dialog"
          tabindex={-1}
          aria-label="Attach a tool"
          onkeydown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              closePicker();
            }
          }}
          onfocusout={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) pickerOpen = false;
          }}
        >
          <input class="search" type="text" bind:this={searchEl} bind:value={query} placeholder="Search tools" aria-label="Search tools" />
          {#if candidates.length === 0}
            <p class="empty">No tools to attach.</p>
          {:else}
            {#each candidates as c (c.id)}
              <button type="button" class="option" onmousedown={(e) => e.preventDefault()} onclick={() => attach(c.id)}>{c.name}</button>
            {/each}
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .tools-editor {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    max-width: 560px;
  }
  .muted {
    margin: 0;
    color: var(--text-tertiary);
    font-size: var(--text-sm);
  }
  .muted.small {
    font-size: var(--text-xs);
    margin-top: var(--space-2);
  }
  .chips {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  /* Rectangular (4px) — NEVER a pill (DESIGN.md#Shapes / anti-patterns). */
  .chip {
    padding: var(--space-3);
    background: var(--surface-card);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
  }
  .chip-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
  }
  .name {
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--text-primary);
  }
  .remove {
    display: inline-flex;
    padding: var(--space-1);
    background: none;
    border: none;
    color: var(--text-secondary);
    cursor: pointer;
    border-radius: var(--radius-sm);
  }
  .remove:hover {
    color: var(--text-primary);
  }
  .operations {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin: var(--space-3) 0 0;
    padding: 0;
    border: none;
  }
  .field-label {
    padding: 0;
    font-size: var(--text-xs);
    color: var(--text-secondary);
    margin-bottom: var(--space-1);
  }
  .op {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    font-size: var(--text-sm);
    color: var(--text-primary);
  }
  .op-name {
    font-family: var(--font-mono, ui-monospace, monospace);
  }
  .op-desc {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
  }
  .add {
    position: relative;
  }
  .add-btn {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    height: var(--control-h-md);
    padding: 0 var(--space-3);
    background: var(--action-secondary-bg);
    color: var(--action-secondary-fg);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    cursor: pointer;
  }
  .add-btn:disabled {
    color: var(--text-disabled);
    cursor: default;
  }
  .picker {
    position: absolute;
    top: 100%;
    left: 0;
    margin-top: var(--space-1);
    z-index: 10;
    min-width: 220px;
    padding: var(--space-1);
    background: var(--surface-card);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-md);
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .search {
    height: var(--control-h-sm);
    padding: 0 var(--space-2);
    font-size: var(--text-sm);
    color: var(--text-primary);
    background: var(--surface-card);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
  }
  .picker .option {
    text-align: left;
    padding: var(--space-2) var(--space-3);
    background: none;
    border: none;
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
    color: var(--text-primary);
    cursor: pointer;
  }
  .picker .option:hover {
    background: var(--surface-raised);
  }
  .picker .empty {
    margin: 0;
    padding: var(--space-2) var(--space-3);
    font-size: var(--text-sm);
    color: var(--text-tertiary);
  }
</style>
