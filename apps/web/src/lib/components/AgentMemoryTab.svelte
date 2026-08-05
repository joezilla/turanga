<script lang="ts">
  // Memory tab (Epic 8, Story 8.2) — the per-agent memory controls. A CONTROLLED component like
  // AgentToolsTab: it never saves; it takes `value` + `onchange`, and the parent's Save draft PATCHes
  // `memoryConfig` (operational config — saving it never makes the agent "dirty"). The effective state
  // is computed from the global defaults so the three-level resolution (global → inherit/on/off) is
  // legible. Recall/reflect/kinds are shown but de-emphasised while the agent is effectively off.
  import { MEMORY_KINDS, effectiveMemoryConfig, type MemoryConfig, type MemoryKind, type MemoryGlobalConfig } from "$lib/agents";

  let {
    value,
    global,
    onchange,
    onpurge,
  }: {
    value: MemoryConfig;
    global: MemoryGlobalConfig;
    onchange: (next: MemoryConfig) => void;
    onpurge?: () => Promise<void>;
  } = $props();

  const effective = $derived(effectiveMemoryConfig(global, value));

  const KIND_LABEL: Record<MemoryKind, string> = {
    episodic: "Episodic — what happened in a run",
    semantic: "Semantic — durable facts & preferences",
    procedure: "Procedure — reusable multi-step playbooks",
  };
  const MODES: { key: MemoryConfig["mode"]; label: string }[] = [
    { key: "inherit", label: "Inherit" },
    { key: "on", label: "On" },
    { key: "off", label: "Off" },
  ];

  function setMode(mode: MemoryConfig["mode"]) {
    onchange({ ...value, mode });
  }
  function setFlag(key: "recall" | "reflect", on: boolean) {
    onchange({ ...value, [key]: on });
  }
  function toggleKind(kind: MemoryKind, on: boolean) {
    const set = new Set(value.kinds);
    if (on) set.add(kind);
    else set.delete(kind);
    // Rebuild in canonical MEMORY_KINDS order — kinds is a SET, so ordering must not matter. Keeping a
    // stable order means toggling a kind off then on isn't read as an "unsaved change" (52f1c84 class).
    onchange({ ...value, kinds: MEMORY_KINDS.filter((k) => set.has(k)) });
  }

  const inheritWord = $derived(global.killSwitch ? "off (kill switch)" : global.defaultEnabled ? "on" : "off");
  const effectiveWord = $derived(effective.enabled ? "on" : "off");

  // Purge (Task 3) — opt-in, destructive, confirmed.
  let confirmPurge = $state(false);
  let purging = $state(false);
  async function doPurge() {
    if (!onpurge || purging) return;
    purging = true;
    await onpurge();
    purging = false;
    confirmPurge = false;
  }
</script>

<div class="scroll pad">
  <div class="form">
    <section>
      <div class="section-head">
        <div class="micro">Memory</div>
        <span class="blurb">Whether this agent remembers across runs. Off by default — the global default is <strong>{inheritWord}</strong>.</span>
      </div>

      <!-- mode: inherit / on / off -->
      <div class="seg" role="group" aria-label="Memory mode">
        {#each MODES as m (m.key)}
          <button type="button" class="seg-btn" class:on={value.mode === m.key} aria-pressed={value.mode === m.key} onclick={() => setMode(m.key)}>
            {m.label}
            {#if m.key === "inherit"}<span class="seg-sub">({inheritWord})</span>{/if}
          </button>
        {/each}
      </div>

      <p class="effective" class:is-on={effective.enabled}>
        <span class="dot" style="background: {effective.enabled ? 'var(--state-succeeded)' : 'var(--text-tertiary)'}" aria-hidden="true"></span>
        <span>
          Effectively <strong>{effectiveWord}</strong>.
          {#if value.mode === "inherit"}
            Following the global default ({inheritWord}).
          {:else if value.mode === "on" && global.killSwitch}
            The global kill switch overrides this — memory is off platform-wide.
          {:else if value.mode === "on"}
            This agent remembers regardless of the global default.
          {:else}
            This agent never remembers.
          {/if}
        </span>
      </p>
    </section>

    <section class:muted={!effective.enabled}>
      <div class="micro">What it does</div>
      <div class="rows">
        <label class="opt">
          <input type="checkbox" checked={value.recall} onchange={(e) => setFlag("recall", (e.currentTarget as HTMLInputElement).checked)} />
          <span class="opt-body">
            <span class="opt-name">Recall</span>
            <span class="opt-desc">Inject relevant memories into a run at the start, so it doesn't repeat past mistakes.</span>
          </span>
        </label>
        <label class="opt">
          <input type="checkbox" checked={value.reflect} onchange={(e) => setFlag("reflect", (e.currentTarget as HTMLInputElement).checked)} />
          <span class="opt-body">
            <span class="opt-name">Reflect</span>
            <span class="opt-desc">Distil each completed run into durable memories afterward — the self-improving loop.</span>
          </span>
        </label>
      </div>
      {#if !effective.enabled}
        <p class="inert-note">These apply once memory is on for this agent.</p>
      {/if}
    </section>

    <section class:muted={!effective.enabled}>
      <div class="micro">Kinds it may learn</div>
      <div class="rows">
        {#each MEMORY_KINDS as kind (kind)}
          <label class="opt">
            <input type="checkbox" checked={value.kinds.includes(kind)} onchange={(e) => toggleKind(kind, (e.currentTarget as HTMLInputElement).checked)} />
            <span class="opt-body"><span class="opt-name">{KIND_LABEL[kind]}</span></span>
          </label>
        {/each}
      </div>
    </section>

    {#if onpurge}
      <section class="danger-zone">
        <div class="micro">Forget everything</div>
        <span class="blurb">Permanently delete every memory this agent has learned. This can't be undone. Turning memory off does not delete anything on its own.</span>
        <div class="danger-actions">
          {#if confirmPurge}
            <span class="confirm">Forget all of this agent's memories?</span>
            <button type="button" class="danger" disabled={purging} onclick={doPurge}>{purging ? "Forgetting…" : "Forget all"}</button>
            <button type="button" class="ghost" disabled={purging} onclick={() => (confirmPurge = false)}>Cancel</button>
          {:else}
            <button type="button" class="danger-outline" onclick={() => (confirmPurge = true)}>Forget all memories</button>
          {/if}
        </div>
      </section>
    {/if}
  </div>
</div>

<style>
  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
  .pad {
    padding: var(--space-6) var(--space-5) var(--space-24);
  }
  .form {
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
    max-width: 560px;
  }
  section {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  section.muted {
    opacity: 0.55;
  }
  .section-head {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .micro {
    font-size: var(--text-2xs);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-tertiary);
    font-weight: var(--weight-medium);
  }
  .blurb {
    font-size: var(--text-xs);
    line-height: var(--lh-xs);
    color: var(--text-secondary);
  }
  .seg {
    display: inline-flex;
    align-self: flex-start;
    padding: 2px;
    gap: 2px;
    background: var(--surface-inset);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
  }
  .seg-btn {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1-5);
    height: 28px;
    padding: 0 var(--space-3);
    font-size: var(--text-sm);
    color: var(--text-secondary);
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
  }
  .seg-btn:hover {
    color: var(--text-primary);
  }
  .seg-btn.on {
    color: var(--text-primary);
    background: var(--surface-card);
    box-shadow: var(--shadow-sm);
    font-weight: var(--weight-medium);
  }
  .seg-sub {
    font-size: var(--text-2xs);
    color: var(--text-tertiary);
  }
  .effective {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    margin: 0;
    font-size: var(--text-xs);
    line-height: var(--lh-xs);
    color: var(--text-secondary);
  }
  .dot {
    position: relative;
    top: 1px;
    width: 7px;
    height: 7px;
    flex: none;
    border-radius: var(--radius-full);
  }
  .rows {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .opt {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2-5);
    padding: var(--space-1-5) var(--space-2);
    border-radius: var(--radius-md);
    cursor: pointer;
  }
  .opt:hover {
    background: var(--surface-hover);
  }
  .opt input {
    width: 13px;
    height: 13px;
    margin: 3px 0 0;
    flex: none;
  }
  .opt input:focus-visible {
    outline: none;
    box-shadow: var(--focus-ring);
  }
  .opt-body {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .opt-name {
    font-size: var(--text-sm);
    color: var(--text-primary);
  }
  .opt-desc {
    font-size: var(--text-xs);
    line-height: var(--lh-xs);
    color: var(--text-secondary);
  }
  .inert-note {
    margin: 0;
    font-size: var(--text-2xs);
    color: var(--text-tertiary);
  }
  .danger-zone {
    border-top: 1px solid var(--border-hairline);
    padding-top: var(--space-5);
  }
  .danger-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .confirm {
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }
  .danger-actions button {
    height: var(--control-h-sm);
    padding: 0 var(--space-3);
    font-size: var(--text-xs);
    border-radius: var(--radius-md);
    cursor: pointer;
    background: var(--surface-card);
    border: 1px solid var(--border-strong);
    color: var(--text-primary);
  }
  .danger-actions button.danger,
  .danger-actions button.danger-outline {
    color: var(--state-failed);
    border-color: var(--border-strong);
  }
  .danger-actions button.ghost {
    border-color: var(--border-subtle);
    color: var(--text-secondary);
  }
  .danger-actions button:disabled {
    color: var(--text-disabled);
    cursor: default;
  }
</style>
