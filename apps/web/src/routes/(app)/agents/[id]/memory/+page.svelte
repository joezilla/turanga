<script lang="ts">
  // Memory observability + curation (Story 8.5). What an agent has learned, agent-scoped (FR-7):
  // each row shows kind, summary (expand for the full content), salience + usage, the source run it
  // was learned from, and whether it's pinned or superseded. Curate: pin (protect from the reflect
  // prune), edit (re-embeds server-side), forget. control-api is the sole writer (AD-7).
  import { page } from "$app/state";
  import { ArrowLeft, Pin } from "@lucide/svelte";
  import { listAgentMemories, setMemoryPinned, editMemory, forgetMemory, type MemoryView } from "$lib/memory";
  import { formatTimestamp } from "$lib/datetime";

  const id = $derived(page.params.id ?? "");

  let memories = $state<MemoryView[]>([]);
  let loadState = $state<"loading" | "ok" | "error">("loading");
  let loadError = $state("");
  let seq = 0;

  let expandedId = $state<string | null>(null);
  let editingId = $state<string | null>(null);
  let editContent = $state("");
  let editSummary = $state("");
  let confirmForgetId = $state<string | null>(null);
  let busyId = $state<string | null>(null); // a row with an in-flight mutation

  async function load() {
    const s = ++seq;
    loadState = "loading";
    const r = await listAgentMemories(id);
    if (s !== seq) return;
    if (r.ok) {
      memories = r.value;
      loadState = "ok";
    } else {
      loadError = r.error;
      loadState = "error";
    }
  }
  $effect(() => {
    load();
  });

  const isSuperseded = (m: MemoryView) => m.validUntil !== null && Date.parse(m.validUntil) < Date.now();

  async function togglePin(m: MemoryView) {
    busyId = m.id;
    await setMemoryPinned(id, m.id, !m.pinned);
    busyId = null;
    await load();
  }

  function startEdit(m: MemoryView) {
    editingId = m.id;
    editContent = m.content;
    editSummary = m.summary;
    confirmForgetId = null;
  }
  async function saveEdit(m: MemoryView) {
    if (!editContent.trim()) return;
    busyId = m.id;
    await editMemory(id, m.id, { content: editContent, summary: editSummary });
    busyId = null;
    editingId = null;
    await load();
  }

  async function forget(m: MemoryView) {
    busyId = m.id;
    await forgetMemory(id, m.id);
    busyId = null;
    confirmForgetId = null;
    await load();
  }
</script>

<div class="head">
  <a class="back" href="/agents/{id}" aria-label="Back to agent"><ArrowLeft size={16} color="currentColor" /></a>
  <h1>Memory</h1>
</div>

{#if loadState === "loading"}
  <p class="muted">Loading memories…</p>
{:else if loadState === "error"}
  <div class="empty">
    <p class="error">{loadError}</p>
    <button class="primary" onclick={load}>Retry</button>
  </div>
{:else if memories.length === 0}
  <div class="empty">
    <p>This agent hasn't learned anything yet.</p>
    <p class="muted">Turn memory on for this agent, then run it — reflection distills each run into memories.</p>
  </div>
{:else}
  <ul class="mems">
    {#each memories as m (m.id)}
      <li class="mem" class:pinned={m.pinned} class:superseded={isSuperseded(m)}>
        <div class="row">
          <span class="left">
            <span class="kind">{m.kind}</span>
            <button type="button" class="summary" onclick={() => (expandedId = expandedId === m.id ? null : m.id)} title="Show the full memory">
              {m.summary || m.content}
            </button>
          </span>
          <span class="right">
            {#if m.pinned}<span class="pin-badge"><Pin size={11} color="currentColor" /> Pinned</span>{/if}
            {#if isSuperseded(m)}<span class="tag super">superseded</span>{/if}
            <span class="salience mono-num" title="salience">★ {m.salience}</span>
          </span>
        </div>

        {#if expandedId === m.id && editingId !== m.id}
          <p class="content">{m.content}</p>
        {/if}

        {#if editingId === m.id}
          <div class="editor">
            <label class="field"><span>Summary (shown to the agent on recall)</span><input type="text" bind:value={editSummary} /></label>
            <label class="field"><span>Content</span><textarea rows="3" bind:value={editContent}></textarea></label>
            <div class="edit-actions">
              <button type="button" class="primary sm" disabled={busyId === m.id || !editContent.trim()} onclick={() => saveEdit(m)}>Save</button>
              <button type="button" class="ghost sm" disabled={busyId === m.id} onclick={() => (editingId = null)}>Cancel</button>
            </div>
          </div>
        {/if}

        <div class="meta">
          <span>used {m.useCount}×</span>
          {#if m.lastUsedAt}<span class="mono-num">last {formatTimestamp(m.lastUsedAt)}</span>{/if}
          {#if m.sourceRunId}<a class="src" href="/agents/{id}/runs/{m.sourceRunId}">learned in a run →</a>{/if}
          <span class="grow"></span>
          {#if confirmForgetId === m.id}
            <span class="confirm">Forget this memory?</span>
            <button type="button" class="danger sm" disabled={busyId === m.id} onclick={() => forget(m)}>Forget</button>
            <button type="button" class="ghost sm" disabled={busyId === m.id} onclick={() => (confirmForgetId = null)}>Cancel</button>
          {:else}
            <button type="button" class="ghost sm" disabled={busyId === m.id} onclick={() => togglePin(m)}>{m.pinned ? "Unpin" : "Pin"}</button>
            <button type="button" class="ghost sm" disabled={busyId === m.id} onclick={() => startEdit(m)}>Edit</button>
            <button type="button" class="danger-outline sm" disabled={busyId === m.id} onclick={() => ((confirmForgetId = m.id), (editingId = null))}>Forget</button>
          {/if}
        </div>
      </li>
    {/each}
  </ul>
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
    gap: var(--space-2);
  }
  .empty p {
    margin: 0;
    color: var(--text-secondary);
    font-size: var(--text-sm);
  }
  .error {
    margin: 0;
    color: var(--state-failed);
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
    cursor: pointer;
  }
  .mems {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    max-width: 720px;
  }
  .mem {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    background: var(--surface-card);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
  }
  .mem.pinned {
    border-color: var(--border-strong);
  }
  .mem.superseded {
    opacity: 0.6;
  }
  .row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
  }
  .left {
    display: inline-flex;
    align-items: baseline;
    gap: var(--space-2);
    min-width: 0;
  }
  .kind {
    flex: none;
    font-size: var(--text-2xs);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-tertiary);
    padding: 1px 5px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
  }
  .summary {
    text-align: left;
    background: transparent;
    border: none;
    padding: 0;
    font-size: var(--text-sm);
    color: var(--text-primary);
    cursor: pointer;
  }
  .summary:hover {
    color: var(--text-link);
  }
  .right {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }
  .pin-badge {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: var(--text-2xs);
    color: var(--text-secondary);
  }
  .tag.super {
    font-size: var(--text-2xs);
    color: var(--state-killed);
  }
  .salience {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
  }
  .content {
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--lh-sm);
    color: var(--text-secondary);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .editor {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    font-size: var(--text-xs);
    color: var(--text-secondary);
  }
  .field input,
  .field textarea {
    font-size: var(--text-sm);
    color: var(--text-primary);
    background: var(--surface-inset);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    padding: var(--space-2);
    font-family: inherit;
  }
  .edit-actions {
    display: flex;
    gap: var(--space-2);
  }
  .meta {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    font-size: var(--text-xs);
    color: var(--text-tertiary);
    flex-wrap: wrap;
  }
  .grow {
    flex: 1 1 0;
  }
  .src {
    color: var(--text-link);
    text-decoration: none;
  }
  .confirm {
    color: var(--text-secondary);
  }
  button.sm {
    height: var(--control-h-sm);
    padding: 0 var(--space-3);
    font-size: var(--text-xs);
    border-radius: var(--radius-md);
    cursor: pointer;
  }
  button.ghost {
    background: transparent;
    border: 1px solid var(--border-subtle);
    color: var(--text-secondary);
  }
  button.ghost:hover:not(:disabled) {
    color: var(--text-primary);
    background: var(--surface-hover);
  }
  button.primary.sm {
    height: var(--control-h-sm);
    padding: 0 var(--space-3);
    font-size: var(--text-xs);
  }
  button.danger,
  button.danger-outline {
    background: var(--surface-card);
    border: 1px solid var(--border-strong);
    color: var(--state-failed);
  }
  button:disabled {
    color: var(--text-disabled);
    cursor: default;
  }
</style>
