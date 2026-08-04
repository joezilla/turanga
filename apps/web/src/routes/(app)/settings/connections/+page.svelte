<script lang="ts">
  import { page } from "$app/state";
  import { Circle } from "@lucide/svelte";
  import { getConfig, listData, removeData, googleStartUrl, type DataConnection } from "$lib/dataConnections";

  let configured = $state(false);
  let connections = $state<DataConnection[]>([]);
  let loading = $state(true);
  let error = $state("");
  let confirmRemoveId = $state<string | null>(null);

  // The OAuth callback redirects back with ?error=… on failure.
  const callbackError = $derived(page.url.searchParams.get("error"));

  async function load() {
    loading = true;
    const [cfg, list] = await Promise.all([getConfig(), listData()]);
    loading = false;
    if (cfg.ok) configured = cfg.value;
    if (list.ok) connections = list.value;
    else error = list.error;
  }
  $effect(() => {
    load();
  });

  function connectGoogle() {
    window.location.href = googleStartUrl();
  }

  async function onRemove(id: string) {
    confirmRemoveId = null;
    const r = await removeData(id);
    if (r.ok) await load();
    else error = r.error;
  }

  function dotColor(status: string): string {
    return status === "connected" ? "var(--state-succeeded)" : status === "error" ? "var(--state-failed)" : "var(--text-tertiary)";
  }
</script>


{#if callbackError}
  <p class="error" role="alert">Google sign-in was cancelled or failed. Try connecting again.</p>
{/if}

{#if loading}
  <p class="muted">Loading…</p>
{:else if error}
  <p class="error" role="alert">{error}</p>
{:else if !configured}
  <p class="muted">Google OAuth isn't configured. Add a Google Cloud OAuth client and set the OAuth env in <code>deploy/.env</code> (see the README), then reload.</p>
{:else if connections.length === 0}
  <p class="muted">No data connections yet.</p>
  <button class="connect" onclick={connectGoogle}>Connect with Google</button>
{:else}
  <ul class="cards">
    {#each connections as conn (conn.id)}
      <li class="card">
        <div class="head">
          <span class="status">
            <Circle size={8} fill={dotColor(conn.status)} color={dotColor(conn.status)} aria-hidden="true" />
            {conn.name}{conn.accountEmail ? ` · ${conn.accountEmail}` : ""} · {conn.status}
          </span>
        </div>
        {#if conn.status === "error" && conn.lastError}<p class="error">{conn.lastError}</p>{/if}
        {#if conn.destinations.length}
          <p class="dest mono-num">{conn.destinations.join(" · ")}</p>
        {/if}
        <div class="actions">
          <!-- No dependent-agent guard here yet: agents can't attach a data connection until a
               later story. Once they can, mirror the providers-page dependents guard (3.6). -->
          {#if confirmRemoveId === conn.id}
            <span class="confirm">Revoke {conn.name}?</span>
            <button type="button" class="danger" onclick={() => onRemove(conn.id)}>Revoke</button>
            <button type="button" class="ghost" onclick={() => (confirmRemoveId = null)}>Cancel</button>
          {:else}
            <button type="button" class="ghost" onclick={() => (confirmRemoveId = conn.id)}>Revoke</button>
          {/if}
        </div>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .connect {
    height: var(--control-h-md);
    padding: 0 var(--space-4);
    background: var(--action-primary-bg);
    color: var(--action-primary-fg);
    border: none;
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    cursor: pointer;
    margin-top: var(--space-2);
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
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .status {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    color: var(--text-primary);
  }
  .dest {
    margin: 0;
    font-size: var(--text-2xs);
    color: var(--text-tertiary);
  }
  .actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .actions button {
    height: var(--control-h-sm);
    padding: 0 var(--space-3);
    font-size: var(--text-xs);
    border-radius: var(--radius-md);
    cursor: pointer;
    background: var(--surface-card);
    border: 1px solid var(--border-subtle);
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
  code {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }
</style>
