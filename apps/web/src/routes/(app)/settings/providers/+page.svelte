<script lang="ts">
  import { Circle } from "@lucide/svelte";
  import {
    listProviders,
    connectProvider,
    rotateKey,
    removeProvider,
    providerDependents,
    setEnabledModels,
    refreshModels,
    discoverModels,
    type Provider,
    type ProviderKind,
    type DependentAgent,
  } from "$lib/connections";

  let providers = $state<Provider[]>([]);
  let loading = $state(true);
  let loadError = $state("");

  // add form
  let kind = $state<ProviderKind>("openai");
  let name = $state("");
  let apiKey = $state("");
  let baseUrl = $state("");
  let busy = $state(false);
  let formError = $state("");
  // Model discovery (Story 2.4) — for openai-compatible, discover the model list from the base URL +
  // key instead of typing it. Discovered ids become checkboxes; the checked ones are what gets added.
  let discovering = $state(false);
  let discovered = $state<string[] | null>(null); // null = not discovered yet
  let selected = $state<Set<string>>(new Set());
  let discoverError = $state("");

  // per-card ui
  let rotatingId = $state<string | null>(null);
  let rotateKeyValue = $state("");
  let confirmRemoveId = $state<string | null>(null);
  let dependents = $state<DependentAgent[]>([]); // agents that use the provider being removed
  let dependentsUnknown = $state(false); // the dependents check failed — don't imply "safe"
  // Model curation (Story 2.4)
  let refreshingId = $state<string | null>(null);
  let refreshKeyValue = $state("");
  let modelFilter = $state<Record<string, string>>({}); // per-provider filter text (long catalogs)
  const toggleSeq: Record<string, number> = {}; // per-provider write generation (drops out-of-order responses)

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
  // A compatible provider can only be added once at least one discovered model is selected.
  const canConnect = $derived(!isCompatible || selected.size > 0);

  function resetDiscovery() {
    discovered = null;
    selected = new Set();
    discoverError = "";
  }

  // Discover the model list from the entered base URL + key (no connect, nothing persisted).
  async function onDiscover() {
    discovering = true;
    discoverError = "";
    const r = await discoverModels({ provider: kind, apiKey, baseUrl: baseUrl || undefined });
    discovering = false;
    if (r.ok) {
      discovered = r.value.models;
      selected = new Set(r.value.models); // default: add them all; the user unchecks any they don't want
    } else {
      discovered = null;
      discoverError = r.error;
    }
  }

  function toggleSelected(m: string, on: boolean) {
    const next = new Set(selected);
    if (on) next.add(m);
    else next.delete(m);
    selected = next;
  }

  async function onConnect(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    formError = "";
    // Compatible providers add the selected discovered models; openai/anthropic auto-fetch on connect.
    const modelsArg = isCompatible ? [...selected] : undefined;
    const r = await connectProvider({ provider: kind, apiKey, name: name || undefined, baseUrl: baseUrl || undefined, models: modelsArg });
    busy = false;
    if (r.ok) {
      apiKey = "";
      name = "";
      baseUrl = "";
      resetDiscovery();
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

  // Arm removal: surface the dependent agents first (so you don't break a running agent).
  async function armRemove(id: string) {
    confirmRemoveId = id;
    dependents = [];
    dependentsUnknown = false;
    const r = await providerDependents(id);
    if (confirmRemoveId !== id) return; // armed a different card meanwhile
    if (r.ok) dependents = r.value;
    else dependentsUnknown = true; // fail closed in the copy — don't imply it's safe to remove
  }

  async function onRemove(id: string) {
    confirmRemoveId = null;
    dependents = [];
    dependentsUnknown = false;
    const r = await removeProvider(id);
    if (r.ok) await load();
    else loadError = r.error;
  }

  // Toggle a single model on/off (Story 2.4) — optimistic, reconciled from the server response. A
  // per-provider generation drops a superseded (out-of-order) response so rapid toggles don't flip-flop.
  async function onToggle(p: Provider, model: string, enable: boolean) {
    const next = enable ? [...new Set([...p.enabledModels, model])] : p.enabledModels.filter((m) => m !== model);
    const seq = (toggleSeq[p.id] ?? 0) + 1;
    toggleSeq[p.id] = seq;
    providers = providers.map((x) => (x.id === p.id ? { ...x, enabledModels: next } : x)); // optimistic
    const r = await setEnabledModels(p.id, next);
    if (toggleSeq[p.id] !== seq) return; // a newer toggle superseded this response — drop it
    if (r.ok) providers = providers.map((x) => (x.id === p.id ? r.value.provider : x));
    else await load(); // a write failure → reconcile from the server (don't leave a wrong toggle)
  }

  // Re-query the provider's catalog. The key isn't stored control-api-side (AD-10) → re-enter it.
  async function onRefresh(id: string) {
    if (!refreshKeyValue) return;
    const r = await refreshModels(id, refreshKeyValue);
    refreshingId = null;
    refreshKeyValue = "";
    if (r.ok) await load();
    else loadError = r.error;
  }

  function shownModels(p: Provider): string[] {
    const q = (modelFilter[p.id] ?? "").toLowerCase();
    return q ? p.models.filter((m) => m.toLowerCase().includes(q)) : p.models;
  }

  function dotColor(status: string): string {
    return status === "connected" ? "var(--state-succeeded)" : status === "error" ? "var(--state-failed)" : "var(--text-tertiary)";
  }
</script>


<!-- Add provider -->
<form class="card add" onsubmit={onConnect}>
  <div class="row">
    <label class="field">
      <span>Provider</span>
      <select bind:value={kind} onchange={resetDiscovery}>
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
  {/if}

  <label class="field">
    <span>API key</span>
    <input type="password" bind:value={apiKey} autocomplete="off" required />
  </label>

  <!-- Model discovery (Story 2.4): for an OpenAI-compatible provider, discover the models from the
       base URL + key instead of typing them, then pick which to add. -->
  {#if isCompatible}
    <div class="discover">
      <button type="button" class="ghost" onclick={onDiscover} disabled={discovering || !baseUrl || !apiKey}>
        {discovering ? "Discovering…" : discovered ? "Re-discover models" : "Discover models"}
      </button>
      {#if discoverError}<p class="error" role="alert">{discoverError}</p>{/if}
      {#if discovered}
        {#if discovered.length === 0}
          <p class="muted">No models returned by this endpoint — check the base URL, or the provider may not list models.</p>
        {:else}
          <p class="muted">{selected.size} of {discovered.length} selected to add.</p>
          <ul class="discover-list">
            {#each discovered as m (m)}
              <li>
                <label class="model">
                  <input type="checkbox" checked={selected.has(m)} onchange={(e) => toggleSelected(m, e.currentTarget.checked)} />
                  <span class="mono-num">{m}</span>
                </label>
              </li>
            {/each}
          </ul>
        {/if}
      {:else}
        <p class="muted">Enter the base URL and API key, then discover the available models.</p>
      {/if}
    </div>
  {/if}

  {#if formError}<p class="error" role="alert">{formError}</p>{/if}
  <button type="submit" class="connect" disabled={busy || !canConnect}>{busy ? "Connecting…" : "Connect provider"}</button>
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
            <span class="confirm">
              Remove {p.name}?
              {#if dependentsUnknown}
                Couldn't check which agents use it — remove anyway?
              {:else if dependents.length > 0}
                {dependents.length} agent{dependents.length === 1 ? "" : "s"} use{dependents.length === 1 ? "s" : ""} it
                ({dependents.map((d) => d.name).join(", ")}) — {dependents.length === 1 ? "it" : "they"}'ll have no model.
              {/if}
            </span>
            <button type="button" class="danger" onclick={() => onRemove(p.id)}>Remove</button>
            <button type="button" class="ghost" onclick={() => { confirmRemoveId = null; dependents = []; dependentsUnknown = false; }}>Cancel</button>
          {:else}
            <button type="button" class="ghost" onclick={() => { rotatingId = p.id; rotateKeyValue = ""; }}>Update key</button>
            <button type="button" class="ghost" onclick={() => armRemove(p.id)}>Remove</button>
          {/if}
        </div>

        <!-- Model catalog + enable/disable (Story 2.4). Only enabled models are selectable on an agent. -->
        {#if p.status === "connected"}
          <div class="models">
            <div class="models-head">
              <span class="count mono-num">{p.enabledModels.length} of {p.models.length} enabled</span>
              {#if refreshingId === p.id}
                <input class="refresh-key" type="password" bind:value={refreshKeyValue} placeholder="API key to refresh" autocomplete="off" />
                <button type="button" onclick={() => onRefresh(p.id)}>Refresh</button>
                <button type="button" class="ghost" onclick={() => (refreshingId = null)}>Cancel</button>
              {:else}
                <button type="button" class="ghost" onclick={() => { refreshingId = p.id; refreshKeyValue = ""; }}>Refresh models</button>
              {/if}
            </div>
            {#if p.models.length === 0}
              <p class="muted">No models — Refresh to fetch the catalog.</p>
            {:else}
              {#if p.models.length > 8}
                <input class="model-filter" type="text" placeholder="Filter models" value={modelFilter[p.id] ?? ""} oninput={(e) => (modelFilter = { ...modelFilter, [p.id]: e.currentTarget.value })} />
              {/if}
              <ul class="model-list">
                {#each shownModels(p) as m (m)}
                  <li>
                    <label class="model">
                      <input type="checkbox" checked={p.enabledModels.includes(m)} onchange={(e) => onToggle(p, m, e.currentTarget.checked)} />
                      <span class="mono-num">{m}</span>
                    </label>
                  </li>
                {/each}
                {#if shownModels(p).length === 0}
                  <li class="muted no-match">No models match "{modelFilter[p.id]}".</li>
                {/if}
              </ul>
            {/if}
          </div>
        {/if}
      </li>
    {/each}
  </ul>
{/if}

<style>
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
  /* Model discovery (Story 2.4) */
  .discover {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .discover > button {
    align-self: flex-start;
    height: var(--control-h-sm);
    padding: 0 var(--space-3);
    font-size: var(--text-xs);
    border-radius: var(--radius-md);
    cursor: pointer;
    background: var(--surface-card);
    color: var(--text-secondary);
    border: 1px solid var(--border-subtle);
  }
  .discover > button:disabled {
    color: var(--text-disabled);
    cursor: default;
  }
  .discover-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    max-height: 220px;
    overflow-y: auto;
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
  /* Model catalog + toggles (Story 2.4) */
  .models {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding-top: var(--space-2);
    border-top: 1px solid var(--border-subtle);
  }
  .models-head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .count {
    font-size: var(--text-xs);
    color: var(--text-secondary);
    margin-right: auto;
  }
  .models-head button {
    height: var(--control-h-sm);
    padding: 0 var(--space-3);
    font-size: var(--text-xs);
    border-radius: var(--radius-md);
    cursor: pointer;
    background: var(--surface-card);
    color: var(--text-secondary);
    border: 1px solid var(--border-subtle);
  }
  .refresh-key {
    height: var(--control-h-sm);
    flex: 1 1 160px;
  }
  .model-filter {
    height: var(--control-h-sm);
    width: 100%;
  }
  .model-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    max-height: 220px;
    overflow-y: auto;
  }
  .model {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-xs);
    color: var(--text-primary);
    cursor: pointer;
  }
  .model input {
    height: auto;
    accent-color: var(--action-primary-bg);
  }
  .no-match {
    padding: var(--space-1) 0;
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
