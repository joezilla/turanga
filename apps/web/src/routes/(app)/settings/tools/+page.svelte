<script lang="ts">
  // Tools management surface (Epic 6, Story 6.1): list the tools an agent can use, with their type +
  // status; remove one. Connecting a remote tool (URL + credential) + deploying a container come next
  // (6.2 / Epic 7) — so "Add a tool" is present but not yet wired.
  import { Circle } from "@lucide/svelte";
  import { listTools, removeTool, connectTool, type Tool } from "$lib/tools";

  let tools = $state<Tool[]>([]);
  let loading = $state(true);
  let loadError = $state("");
  let confirmRemoveId = $state<string | null>(null);

  // Add-a-remote-tool form (Story 6.2)
  let showAdd = $state(false);
  let addName = $state("");
  let addUrl = $state("");
  let addCredential = $state("");
  let adding = $state(false);
  let addError = $state("");

  async function load() {
    loading = true;
    const r = await listTools();
    loading = false;
    if (r.ok) {
      tools = r.value;
      loadError = "";
    } else {
      loadError = r.error;
    }
  }
  $effect(() => {
    load();
  });

  function openAdd() {
    showAdd = true;
    addName = "";
    addUrl = "";
    addCredential = "";
    addError = "";
  }

  async function onConnect(e: SubmitEvent) {
    e.preventDefault();
    adding = true;
    addError = "";
    const r = await connectTool({ name: addName, url: addUrl, credential: addCredential || undefined });
    adding = false;
    if (r.ok) {
      showAdd = false;
      await load();
    } else {
      addError = r.error;
    }
  }

  async function onRemove(id: string) {
    confirmRemoveId = null;
    const r = await removeTool(id);
    if (r.ok) await load();
    else loadError = r.error;
  }

  function dotColor(status: string): string {
    return status === "connected" ? "var(--state-succeeded)" : status === "error" ? "var(--state-failed)" : "var(--text-tertiary)";
  }
  const endpointLabel = (e: string) => (e === "remote" ? "Remote MCP" : "Container");
</script>

<h1>Tools</h1>
<p class="lede">Tools are MCP servers your agents can call at runtime — a remote server or one you deploy yourself. Attach them to an agent to grant specific operations.</p>

<!-- Add / connect a remote MCP tool (Story 6.2) -->
{#if showAdd}
  <form class="card add" onsubmit={onConnect}>
    <label class="field">
      <span>Name</span>
      <input type="text" bind:value={addName} placeholder="e.g. Weather" required />
    </label>
    <label class="field">
      <span>MCP server URL</span>
      <input type="url" bind:value={addUrl} placeholder="https://…/mcp" required />
    </label>
    <label class="field">
      <span>Credential (optional)</span>
      <input type="password" bind:value={addCredential} autocomplete="off" placeholder="bearer token — leave blank if the server needs none" />
    </label>
    {#if addError}<p class="error" role="alert">{addError}</p>{/if}
    <div class="add-actions">
      <button type="submit" class="primary" disabled={adding}>{adding ? "Connecting…" : "Connect"}</button>
      <button type="button" class="ghost" onclick={() => (showAdd = false)} disabled={adding}>Cancel</button>
    </div>
  </form>
{:else}
  <div class="head">
    <button class="primary" onclick={openAdd}>Add a tool</button>
  </div>
{/if}

{#if loading}
  <p class="muted">Loading…</p>
{:else if loadError}
  <div class="empty">
    <p class="error" role="alert">{loadError}</p>
    <button class="primary" onclick={load}>Retry</button>
  </div>
{:else if tools.length === 0}
  {#if !showAdd}<p class="muted">No tools yet.</p>{/if}
{:else}
  <ul class="cards">
    {#each tools as t (t.id)}
      <li class="card tool">
        <div class="row">
          <span class="status">
            <Circle size={8} fill={dotColor(t.status)} color={dotColor(t.status)} aria-hidden="true" />
            {t.name} · {t.status}
          </span>
          <span class="type">{endpointLabel(t.endpoint)}</span>
        </div>
        {#if t.url}<p class="sub mono">{t.url}{#if t.credentialSet} · credential set{/if}</p>{/if}
        {#if t.operations.length > 0}
          <p class="sub">{t.operations.length} operation{t.operations.length === 1 ? "" : "s"}: <span class="ops">{t.operations.map((o) => o.name).join(", ")}</span></p>
        {:else}
          <p class="sub">No operations discovered.</p>
        {/if}
        {#if t.status === "error" && t.lastError}<p class="error">{t.lastError}</p>{/if}
        <div class="actions">
          {#if confirmRemoveId === t.id}
            <span class="confirm">Remove {t.name}?</span>
            <button type="button" class="danger" onclick={() => onRemove(t.id)}>Remove</button>
            <button type="button" class="ghost" onclick={() => (confirmRemoveId = null)}>Cancel</button>
          {:else}
            <button type="button" class="ghost" onclick={() => (confirmRemoveId = t.id)}>Remove</button>
          {/if}
        </div>
      </li>
    {/each}
  </ul>
{/if}

<style>
  h1 {
    margin: 0 0 var(--space-2);
    font-size: var(--text-2xl);
    line-height: var(--lh-2xl);
    font-weight: var(--weight-semibold);
    letter-spacing: var(--tracking-heading);
    color: var(--text-primary);
  }
  .lede {
    margin: 0 0 var(--space-5);
    max-width: 560px;
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }
  .head {
    margin: 0 0 var(--space-3);
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
  .cards {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    max-width: 560px;
  }
  .card {
    background: var(--surface-card);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-sm);
    padding: var(--space-5);
  }
  .tool {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }
  .status {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    color: var(--text-primary);
  }
  .type {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
  }
  .sub {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--text-tertiary);
  }
  .sub.mono {
    font-family: var(--font-mono, ui-monospace, monospace);
    word-break: break-all;
  }
  .ops {
    color: var(--text-secondary);
  }
  /* Connect form (Story 6.2) — mirrors the providers add-form */
  .add {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    max-width: 480px;
    margin-bottom: var(--space-6);
    padding: var(--space-5);
  }
  .add .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    font-size: var(--text-xs);
    color: var(--text-secondary);
  }
  .add input {
    height: var(--control-h-md);
    padding: 0 var(--space-3);
    font-size: var(--text-sm);
    color: var(--text-primary);
    background: var(--surface-card);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
  }
  .add-actions {
    display: flex;
    gap: var(--space-2);
  }
  .add-actions .ghost {
    height: var(--control-h-md);
    padding: 0 var(--space-4);
    font-size: var(--text-sm);
    border-radius: var(--radius-md);
    cursor: pointer;
    background: var(--surface-card);
    color: var(--text-secondary);
    border: 1px solid var(--border-subtle);
  }
  .add-actions .ghost:disabled {
    color: var(--text-disabled);
    cursor: default;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .actions button {
    height: var(--control-h-sm);
    padding: 0 var(--space-3);
    font-size: var(--text-xs);
    border-radius: var(--radius-md);
    cursor: pointer;
    background: var(--surface-card);
    color: var(--text-primary);
    border: 1px solid var(--border-strong);
  }
  .actions button.ghost {
    border-color: var(--border-subtle);
    color: var(--text-secondary);
  }
  .actions button.danger {
    color: var(--state-failed);
    border-color: var(--border-strong);
  }
  .confirm {
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }
  .error {
    margin: 0;
    color: var(--critical-500);
    font-size: var(--text-sm);
  }
  .muted {
    color: var(--text-tertiary);
    font-size: var(--text-sm);
  }
</style>
