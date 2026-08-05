<script lang="ts">
  // Memory observability + curation (Story 8.5). What an agent has learned, agent-scoped (FR-7):
  // each row shows kind, summary (expand for the full content), salience + usage, the source run it
  // was learned from, and whether it's pinned or superseded. Curate: pin (protect from the reflect
  // prune), edit (re-embeds server-side), forget. control-api is the sole writer (AD-7).
  import { page } from "$app/state";
  import { ArrowLeft, Pin, ShieldOff, History } from "@lucide/svelte";
  import {
    listAgentMemories,
    setMemoryPinned,
    editMemory,
    forgetMemory,
    acceptMemory,
    rejectMemory,
    quarantineMemory,
    unquarantineMemory,
    listMemoryChangelog,
    type MemoryView,
    type MemoryEvent,
  } from "$lib/memory";
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

  // Story 8.6 — pending memories wait for approval and are never recalled; quarantined ones are
  // rolled-back active memories. Active/quarantined show in the main list; pending gets its own section.
  const pending = $derived(memories.filter((m) => m.status === "pending"));
  const settled = $derived(memories.filter((m) => m.status !== "pending"));

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

  // Staged approval + quarantine (Story 8.6) — each mutates via control-api (AD-7) then reloads.
  async function accept(m: MemoryView) {
    busyId = m.id;
    await acceptMemory(id, m.id);
    busyId = null;
    await load();
  }
  async function reject(m: MemoryView) {
    busyId = m.id;
    await rejectMemory(id, m.id);
    busyId = null;
    confirmForgetId = null;
    await load();
  }
  async function toggleQuarantine(m: MemoryView) {
    busyId = m.id;
    if (m.status === "quarantined") await unquarantineMemory(id, m.id);
    else await quarantineMemory(id, m.id);
    busyId = null;
    await load();
  }

  // The learning changelog (Story 8.6) — collapsed by default; loaded lazily on first open.
  let changelogOpen = $state(false);
  let changelog = $state<MemoryEvent[]>([]);
  let changelogState = $state<"idle" | "loading" | "ok" | "error">("idle");
  async function loadChangelog() {
    changelogState = "loading";
    const r = await listMemoryChangelog(id);
    if (r.ok) {
      changelog = r.value;
      changelogState = "ok";
    } else {
      changelogState = "error";
    }
  }
  async function toggleChangelog() {
    changelogOpen = !changelogOpen;
    // Load lazily on open; retry from "error" too, so a transient failure isn't permanent until a full
    // page reload (8.6 review). "loading"/"ok" don't re-fetch.
    if (changelogOpen && (changelogState === "idle" || changelogState === "error")) await loadChangelog();
  }
  const EVENT_VERB: Record<MemoryEvent["kind"], string> = {
    learned: "learned",
    reinforced: "reinforced",
    superseded: "superseded",
    forgotten: "forgotten",
    edited: "edited",
    pinned: "pinned",
    unpinned: "unpinned",
    accepted: "accepted",
    rejected: "rejected",
    quarantined: "quarantined",
    unquarantined: "un-quarantined",
  };

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
  {#if pending.length > 0}
    <!-- Story 8.6 — staged approval. These were learned but are held OUT of recall until you accept. -->
    <section class="pending-zone">
      <div class="zone-head">
        <h2>Pending your review</h2>
        <span class="zone-sub">Learned but not yet in effect — nothing here is recalled until you accept it.</span>
      </div>
      <ul class="mems">
        {#each pending as m (m.id)}
          <li class="mem is-pending">
            <div class="row">
              <span class="left">
                <span class="kind">{m.kind}</span>
                <button type="button" class="summary" onclick={() => (expandedId = expandedId === m.id ? null : m.id)} title="Show the full memory">
                  {m.summary || m.content}
                </button>
              </span>
              <span class="right"><span class="tag pending-tag">pending</span></span>
            </div>
            {#if expandedId === m.id}<p class="content">{m.content}</p>{/if}
            <div class="meta">
              {#if m.sourceRunId}<a class="src" href="/agents/{id}/runs/{m.sourceRunId}">learned in a run →</a>{/if}
              <span class="grow"></span>
              <button type="button" class="primary sm" disabled={busyId === m.id} onclick={() => accept(m)}>Accept</button>
              <button type="button" class="danger-outline sm" disabled={busyId === m.id} onclick={() => reject(m)}>Reject</button>
            </div>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  <ul class="mems">
    {#each settled as m (m.id)}
      <li class="mem" class:pinned={m.pinned} class:superseded={isSuperseded(m)} class:is-quarantined={m.status === "quarantined"}>
        <div class="row">
          <span class="left">
            <span class="kind">{m.kind}</span>
            <button type="button" class="summary" onclick={() => (expandedId = expandedId === m.id ? null : m.id)} title="Show the full memory">
              {m.summary || m.content}
            </button>
          </span>
          <span class="right">
            {#if m.status === "quarantined"}<span class="tag quar"><ShieldOff size={11} color="currentColor" /> quarantined</span>{/if}
            {#if m.pinned}<span class="pin-badge"><Pin size={11} color="currentColor" /> Pinned</span>{/if}
            {#if isSuperseded(m)}<span class="tag super">superseded</span>{/if}
            <span class="salience mono-num" title="salience">★ {m.salience}</span>
          </span>
        </div>

        {#if expandedId === m.id && editingId !== m.id}
          <p class="content">{m.content}</p>
        {/if}

        {#if m.status === "quarantined"}
          <p class="quar-note">Held out of recall. Un-quarantine to make it recallable again, or forget it.</p>
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
            <button type="button" class="ghost sm" disabled={busyId === m.id} onclick={() => toggleQuarantine(m)}>{m.status === "quarantined" ? "Un-quarantine" : "Quarantine"}</button>
            <button type="button" class="danger-outline sm" disabled={busyId === m.id} onclick={() => ((confirmForgetId = m.id), (editingId = null))}>Forget</button>
          {/if}
        </div>
      </li>
    {/each}
  </ul>
{/if}

<!-- The learning changelog (Story 8.6) — every accept/reject/quarantine/edit/forget, newest first.
     Shown whenever the page loaded, even with no current memories (the history outlives what's kept). -->
{#if loadState === "ok"}
  <section class="changelog">
    <button type="button" class="log-toggle" onclick={toggleChangelog} aria-expanded={changelogOpen}>
      <History size={14} color="currentColor" />
      <span>Learning history</span>
      <span class="chev" class:open={changelogOpen} aria-hidden="true">›</span>
    </button>
    {#if changelogOpen}
      {#if changelogState === "loading"}
        <p class="muted">Loading history…</p>
      {:else if changelogState === "error"}
        <p class="error">Couldn't load the learning history. <button type="button" class="link-retry" onclick={loadChangelog}>Retry</button></p>
      {:else if changelog.length === 0}
        <p class="muted">No changes recorded yet.</p>
      {:else}
        <ul class="events">
          {#each changelog as e (e.id)}
            <li class="event">
              <span class="ev-kind ev-{e.kind}">{EVENT_VERB[e.kind]}</span>
              <span class="ev-summary">{e.summary || "—"}</span>
              {#if e.sourceRunId}<a class="src" href="/agents/{id}/runs/{e.sourceRunId}">run →</a>{/if}
              <span class="ev-at mono-num">{formatTimestamp(e.at)}</span>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  </section>
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

  /* Story 8.6 — pending-review zone, quarantine, and the learning changelog. */
  .pending-zone {
    max-width: 720px;
    margin: 0 0 var(--space-5);
  }
  .zone-head {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0 0 var(--space-2);
  }
  .zone-head h2 {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
    color: var(--text-primary);
  }
  .zone-sub {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
  }
  .mem.is-pending {
    border-color: var(--border-strong);
    border-left: 2px solid var(--action-primary-bg);
  }
  .mem.is-quarantined {
    opacity: 0.7;
  }
  .tag.pending-tag {
    font-size: var(--text-2xs);
    color: var(--action-primary-bg);
  }
  .tag.quar {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: var(--text-2xs);
    color: var(--state-killed);
  }
  .quar-note {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--text-tertiary);
  }
  .changelog {
    max-width: 720px;
    margin: var(--space-6) 0 0;
    border-top: 1px solid var(--border-hairline);
    padding-top: var(--space-4);
  }
  .log-toggle {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    background: transparent;
    border: none;
    padding: 0;
    font-size: var(--text-sm);
    color: var(--text-secondary);
    cursor: pointer;
  }
  .log-toggle:hover {
    color: var(--text-primary);
  }
  .link-retry {
    background: transparent;
    border: none;
    padding: 0;
    font: inherit;
    color: var(--text-link);
    text-decoration: underline;
    cursor: pointer;
  }
  .chev {
    transition: transform var(--duration-fast) var(--ease-standard);
  }
  .chev.open {
    transform: rotate(90deg);
  }
  .events {
    list-style: none;
    margin: var(--space-3) 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .event {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    font-size: var(--text-xs);
    color: var(--text-secondary);
    padding: var(--space-1) 0;
  }
  .ev-kind {
    flex: none;
    font-size: var(--text-2xs);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-tertiary);
    min-width: 76px;
  }
  .ev-kind.ev-learned,
  .ev-kind.ev-accepted {
    color: var(--state-succeeded);
  }
  .ev-kind.ev-forgotten,
  .ev-kind.ev-rejected,
  .ev-kind.ev-quarantined {
    color: var(--state-killed);
  }
  .ev-summary {
    min-width: 0;
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ev-at {
    flex: none;
    color: var(--text-tertiary);
  }
</style>
