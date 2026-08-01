<script lang="ts">
  import { Circle } from "@lucide/svelte";
  import {
    listProviders,
    connectProvider,
    rotateKey,
    removeProvider,
    type Provider,
    type ProviderKind,
  } from "$lib/connections";

  let providers = $state<Provider[]>([]);
  let loading = $state(true);
  let loadError = $state("");

  // add form
  let kind = $state<ProviderKind>("openai");
  let name = $state("");
  let apiKey = $state("");
  let baseUrl = $state("");
  let models = $state("");
  let busy = $state(false);
  let formError = $state("");

  // per-card ui
  let rotatingId = $state<string | null>(null);
  let rotateKeyValue = $state("");
  let confirmRemoveId = $state<string | null>(null);

  async function load() {
    loading = true;
    const r = await listProviders();
    loading = false;
    if (r.ok) {
      providers = r.value;
      loadError = "";
    } else {
      loadError = r.error;
    }
  }
  $effect(() => {
    load();
  });

  const isCompatible = $derived(kind === "openai-compatible");

  async function onConnect(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    formError = "";
    const r = await connectProvider({ provider: kind, apiKey, name: name || undefined, baseUrl: baseUrl || undefined, models: models || undefined });
    busy = false;
    if (r.ok) {
      apiKey = "";
      name = "";
      baseUrl = "";
      models = "";
      await load();
    } else {
      formError = r.error;
    }
  }

  async function onRotate(id: string) {
    if (!rotateKeyValue) return;
    const r = await rotateKey(id, rotateKeyValue);
    rotatingId = null;
    rotateKeyValue = "";
    if (r.ok) await load();
    else loadError = r.error;
  }

  async function onRemove(id: string) {
    confirmRemoveId = null;
    const r = await removeProvider(id);
    if (r.ok) await load();
    else loadError = r.error;
  }

  function dotColor(status: string): string {
    return status === "connected" ? "var(--state-succeeded)" : status === "error" ? "var(--state-failed)" : "var(--text-tertiary)";
  }
</script>

<h1>Model providers</h1>

<!-- Add provider -->
<form class="card add" onsubmit={onConnect}>
  <div class="row">
    <label class="field">
      <span>Provider</span>
      <select bind:value={kind}>
        <option value="openai">OpenAI</option>
        <option value="anthropic">Anthropic</option>
        <option value="openai-compatible">OpenAI-compatible</option>
      </select>
    </label>
    {#if isCompatible}
      <label class="field">
        <span>Name</span>
        <input type="text" bind:value={name} placeholder="e.g. openrouter" />
      </label>
    {/if}
  </div>

  {#if isCompatible}
    <label class="field">
      <span>Base URL</span>
      <input type="url" bind:value={baseUrl} placeholder="https://…/v1" />
    </label>
    <label class="field">
      <span>Models (comma-separated)</span>
      <input type="text" bind:value={models} placeholder="llama-3.1-70b, mixtral-8x7b" />
    </label>
  {/if}

  <label class="field">
    <span>API key</span>
    <input type="password" bind:value={apiKey} autocomplete="off" required />
  </label>

  {#if formError}<p class="error" role="alert">{formError}</p>{/if}
  <button type="submit" class="connect" disabled={busy}>{busy ? "Connecting…" : "Connect provider"}</button>
</form>

<!-- Connected providers -->
{#if loading}
  <p class="muted">Loading…</p>
{:else if loadError}
  <p class="error" role="alert">{loadError}</p>
{:else if providers.length === 0}
  <p class="muted">No providers connected.</p>
{:else}
  <ul class="cards">
    {#each providers as p (p.id)}
      <li class="card provider">
        <div class="head">
          <span class="status">
            <Circle size={8} fill={dotColor(p.status)} color={dotColor(p.status)} aria-hidden="true" />
            {p.name} · {p.status}
          </span>
          <span class="key mono-num">{p.keyLast4 ? `sk-…${p.keyLast4}` : "—"}</span>
        </div>
        {#if p.baseUrl}<p class="sub">{p.baseUrl}</p>{/if}
        {#if p.status === "error" && p.lastError}<p class="error">{p.lastError}</p>{/if}

        <div class="actions">
          {#if rotatingId === p.id}
            <input type="password" bind:value={rotateKeyValue} placeholder="New API key" />
            <button type="button" onclick={() => onRotate(p.id)}>Save</button>
            <button type="button" class="ghost" onclick={() => (rotatingId = null)}>Cancel</button>
          {:else if confirmRemoveId === p.id}
            <span class="confirm">Remove {p.name}?</span>
            <button type="button" class="danger" onclick={() => onRemove(p.id)}>Remove</button>
            <button type="button" class="ghost" onclick={() => (confirmRemoveId = null)}>Cancel</button>
          {:else}
            <button type="button" class="ghost" onclick={() => { rotatingId = p.id; rotateKeyValue = ""; }}>Update key</button>
            <button type="button" class="ghost" onclick={() => (confirmRemoveId = p.id)}>Remove</button>
          {/if}
        </div>
      </li>
    {/each}
  </ul>
{/if}

<style>
  h1 {
    margin: 0 0 var(--space-4);
    font-size: var(--text-2xl);
    line-height: var(--lh-2xl);
    font-weight: var(--weight-semibold);
    letter-spacing: var(--tracking-heading);
    color: var(--text-primary);
  }
  .card {
    background: var(--surface-card);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-sm);
    padding: var(--space-5);
  }
  .add {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    max-width: 480px;
    margin-bottom: var(--space-6);
  }
  .row {
    display: flex;
    gap: var(--space-3);
  }
  .row .field {
    flex: 1 1 0;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    font-size: var(--text-xs);
    color: var(--text-secondary);
  }
  input,
  select {
    height: var(--control-h-md);
    padding: 0 var(--space-3);
    font-size: var(--text-sm);
    color: var(--text-primary);
    background: var(--surface-card);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
  }
  .connect {
    align-self: flex-start;
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
  .connect:disabled {
    color: var(--text-disabled);
    cursor: default;
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
  .provider {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .head {
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
  .key {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
  }
  .sub {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--text-tertiary);
  }
  .actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .actions input {
    height: var(--control-h-sm);
    flex: 1 1 160px;
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
