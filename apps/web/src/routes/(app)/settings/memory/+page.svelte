<script lang="ts">
  // Settings → Memory (Epic 8, Story 8.2). The operator's GLOBAL memory defaults: whether new agents
  // remember by default, a master kill switch, and how long memories are kept. control-api is the sole
  // writer (AD-7); each change PATCHes and adopts the server's returned config. The embedding model +
  // agent-scoped privacy are shown read-only (the pgvector dimension is fixed; changing the model needs
  // a migration + re-embed — out of scope here). Off by default: memory does nothing until turned on.
  import { Circle } from "@lucide/svelte";
  import { getMemoryConfig, setMemoryConfig, type MemoryGlobalConfig } from "$lib/memory";

  let cfg = $state<MemoryGlobalConfig | null>(null);
  let loading = $state(true);
  let loadError = $state("");
  let saveError = $state("");
  let saving = $state(false);

  // Retention is edited as a string so "blank = keep indefinitely" (null) is expressible.
  let retentionText = $state("");

  async function load() {
    loading = true;
    const r = await getMemoryConfig();
    loading = false;
    if (r.ok) {
      cfg = r.value;
      retentionText = r.value.retentionDays === null ? "" : String(r.value.retentionDays);
      loadError = "";
    } else {
      loadError = r.error;
    }
  }
  $effect(() => {
    load();
  });

  async function patch(next: Partial<MemoryGlobalConfig>) {
    if (!cfg || saving) return;
    saving = true;
    saveError = "";
    const r = await setMemoryConfig(next);
    saving = false;
    if (r.ok) {
      cfg = r.value;
      retentionText = r.value.retentionDays === null ? "" : String(r.value.retentionDays);
    } else {
      saveError = r.error;
      // Re-sync the controls to the server's last-known-good so a rejected edit doesn't stick visually.
      if (cfg) retentionText = cfg.retentionDays === null ? "" : String(cfg.retentionDays);
    }
  }

  function commitRetention() {
    if (!cfg) return;
    const t = retentionText.trim();
    const next = t === "" ? null : Number(t);
    if (next !== null && (!Number.isInteger(next) || next <= 0)) {
      saveError = "Retention must be a positive whole number of days, or blank to keep memories indefinitely.";
      retentionText = cfg.retentionDays === null ? "" : String(cfg.retentionDays);
      return;
    }
    if (next === cfg.retentionDays) return; // no change
    void patch({ retentionDays: next });
  }

  // Platform state as a dot + WORD (NFR-6 / UX-DR11 — never colour-only).
  const platform = $derived.by(() => {
    if (!cfg) return { color: "var(--text-tertiary)", word: "loading…" };
    if (cfg.killSwitch) return { color: "var(--state-failed)", word: "Kill switch active — memory is off for every agent" };
    if (cfg.defaultEnabled) return { color: "var(--state-succeeded)", word: "New agents remember by default" };
    return { color: "var(--text-tertiary)", word: "Off by default — enable memory per agent, or flip the default" };
  });
</script>

{#if loading}
  <p class="muted">Loading…</p>
{:else if loadError}
  <div class="empty">
    <p class="error" role="alert">{loadError}</p>
    <button class="primary" onclick={load}>Retry</button>
  </div>
{:else if cfg}
  <p class="status">
    <Circle size={8} fill={platform.color} color={platform.color} aria-hidden="true" />
    <span>{platform.word}</span>
  </p>

  <div class="cards">
    <!-- Kill switch first — it's the master override. -->
    <div class="card row-card">
      <div class="row-text">
        <span class="row-title">Kill switch</span>
        <span class="row-sub">Disable memory for every agent, platform-wide — overrides each agent's own setting. Nothing is recalled or learned while this is on.</span>
      </div>
      <label class="switch">
        <input type="checkbox" role="switch" aria-label="Toggle the platform kill switch" checked={cfg.killSwitch} disabled={saving} onchange={(e) => patch({ killSwitch: (e.currentTarget as HTMLInputElement).checked })} />
        <span class="track" aria-hidden="true"></span>
      </label>
    </div>

    <div class="card row-card">
      <div class="row-text">
        <span class="row-title">New agents remember by default</span>
        <span class="row-sub">The value an agent set to <code>inherit</code> resolves to. Off means a new agent won't remember until you turn it on for that agent.</span>
      </div>
      <label class="switch">
        <input type="checkbox" role="switch" aria-label="Toggle the default for new agents" checked={cfg.defaultEnabled} disabled={saving || cfg.killSwitch} onchange={(e) => patch({ defaultEnabled: (e.currentTarget as HTMLInputElement).checked })} />
        <span class="track" aria-hidden="true"></span>
      </label>
    </div>

    <div class="card row-card">
      <div class="row-text">
        <span class="row-title">Retention</span>
        <span class="row-sub">Forget memories older than this many days. Leave blank to keep them indefinitely.</span>
      </div>
      <div class="retention">
        <input
          type="number"
          min="1"
          step="1"
          inputmode="numeric"
          placeholder="∞"
          aria-label="Retention in days"
          bind:value={retentionText}
          disabled={saving}
          onblur={commitRetention}
          onkeydown={(e) => { if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur(); }}
        />
        <span class="unit">days</span>
      </div>
    </div>

    <!-- Read-only for this story (see header note). -->
    <div class="card readonly">
      <div class="ro-row"><span class="ro-key">Embedding model</span><span class="ro-val mono">{cfg.embeddingModel}</span></div>
      <div class="ro-row"><span class="ro-key">Privacy</span><span class="ro-val">Agent-scoped — an agent's memories are never shared with another agent</span></div>
      <p class="ro-note">Changing the embedding model needs a re-embed and isn't editable here yet.</p>
    </div>
  </div>

  {#if saveError}<p class="error" role="alert">{saveError}</p>{/if}
{/if}

<style>
  .status {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    margin: 0 0 var(--space-5);
    font-size: var(--text-sm);
    color: var(--text-primary);
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
  .row-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
  }
  .row-text {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    min-width: 0;
  }
  .row-title {
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--text-primary);
  }
  .row-sub {
    font-size: var(--text-xs);
    line-height: var(--lh-xs);
    color: var(--text-tertiary);
  }
  code {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 0.9em;
    color: var(--text-secondary);
  }
  /* Toggle switch */
  .switch {
    position: relative;
    flex: none;
    display: inline-flex;
    cursor: pointer;
  }
  .switch input {
    position: absolute;
    inset: 0;
    margin: 0;
    opacity: 0;
    cursor: pointer;
  }
  .switch input:disabled {
    cursor: default;
  }
  .track {
    width: 34px;
    height: 20px;
    border-radius: var(--radius-full);
    background: var(--border-strong);
    transition: background var(--duration-fast) var(--ease-standard);
    position: relative;
    pointer-events: none; /* clicks pass through to the opacity:0 input beneath (else the track intercepts) */
  }
  .track::after {
    content: "";
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    border-radius: var(--radius-full);
    background: var(--surface-card);
    box-shadow: var(--shadow-sm);
    transition: transform var(--duration-fast) var(--ease-standard);
  }
  .switch input:checked + .track {
    background: var(--action-primary-bg);
  }
  .switch input:checked + .track::after {
    transform: translateX(14px);
  }
  .switch input:disabled + .track {
    opacity: 0.5;
  }
  .switch input:focus-visible + .track {
    outline: none;
    box-shadow: var(--focus-ring);
  }
  .retention {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }
  .retention input {
    width: 84px;
    height: var(--control-h-md);
    padding: 0 var(--space-3);
    font-size: var(--text-sm);
    color: var(--text-primary);
    background: var(--surface-card);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    text-align: right;
  }
  .retention input:focus-visible {
    outline: none;
    border-color: var(--border-focus);
    box-shadow: var(--focus-ring);
  }
  .unit {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
  }
  .readonly {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .ro-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-4);
  }
  .ro-key {
    font-size: var(--text-xs);
    color: var(--text-secondary);
    flex: none;
  }
  .ro-val {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
    text-align: right;
  }
  .ro-val.mono {
    font-family: var(--font-mono, ui-monospace, monospace);
    color: var(--text-secondary);
  }
  .ro-note {
    margin: var(--space-1) 0 0;
    font-size: var(--text-2xs);
    color: var(--text-tertiary);
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
  .empty {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-3);
  }
  .error {
    margin: var(--space-3) 0 0;
    color: var(--critical-500);
    font-size: var(--text-sm);
  }
  .muted {
    color: var(--text-tertiary);
    font-size: var(--text-sm);
  }
</style>
