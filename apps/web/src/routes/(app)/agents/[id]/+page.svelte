<script lang="ts">
  // Agent-definition surface (Story 3.2): two-pane builder (config left / test right),
  // collapsible Model section, autosave (name + model). Instructions/Skills/Variables/
  // Cost caps/Allowlist are later stories; the test pane is a scaffold (runs are Epic 4).
  import { page } from "$app/state";
  import { ArrowLeft } from "@lucide/svelte";
  import { getAgent, updateAgent, type Agent } from "$lib/agents";
  import { listProviders, type Provider } from "$lib/connections";
  import Section from "$lib/components/Section.svelte";
  import StatusDot from "$lib/components/StatusDot.svelte";
  import ModelSelector from "$lib/components/ModelSelector.svelte";

  const id = $derived(page.params.id ?? "");

  let agent = $state<Agent | null>(null);
  let providers = $state<Provider[]>([]);
  let loading = $state(true);
  let loadError = $state("");
  let notFound = $state(false);

  // Autosave indicator: idle (hidden) → saving → saved; error shows an inline hint.
  let save = $state<"idle" | "saving" | "saved" | "error">("idle");
  let name = $state("");
  let nameTimer: ReturnType<typeof setTimeout> | null = null;

  // Config UI state
  let showTest = $state(false); // < 1024px: the test pane collapses behind this toggle

  async function load() {
    loading = true;
    notFound = false;
    loadError = "";
    const [a, p] = await Promise.all([getAgent(id), listProviders()]);
    loading = false;
    if (!a.ok) {
      if (a.error.includes("doesn't exist")) notFound = true;
      else loadError = a.error;
      return;
    }
    agent = a.value;
    name = a.value.name;
    providers = p.ok ? p.value : []; // a provider outage shouldn't block editing the agent
  }
  $effect(() => {
    // re-run when the route id changes
    void id;
    load();
  });

  // Server-authoritative autosave (AD-7): PATCH, then trust the returned agent.
  async function persist(patch: { name?: string; model?: string | null }) {
    save = "saving";
    const r = await updateAgent(id, patch);
    if (r.ok) {
      agent = r.value;
      save = "saved";
    } else {
      save = "error";
    }
  }

  function onNameInput(e: Event) {
    name = (e.currentTarget as HTMLInputElement).value;
    if (nameTimer) clearTimeout(nameTimer);
    const next = name.trim();
    if (!next) return; // control-api rejects an empty name; don't autosave blanks
    nameTimer = setTimeout(() => persist({ name: next }), 400); // debounce text
  }

  function onModelChange(model: string | null) {
    persist({ model }); // discrete change → save immediately
  }
</script>

{#if loading}
  <p class="muted">Loading agent…</p>
{:else if notFound}
  <div class="stack">
    <p class="muted">That agent doesn't exist.</p>
    <a class="link" href="/agents">Back to Agents</a>
  </div>
{:else if loadError}
  <div class="stack">
    <p class="error">{loadError}</p>
    <button class="primary" onclick={load}>Retry</button>
  </div>
{:else if agent}
  <div class="head">
    <a class="back" href="/agents" aria-label="Back to Agents"><ArrowLeft size={16} color="currentColor" /></a>
    <label class="name-field">
      <span class="visually-hidden">Agent name</span>
      <input type="text" value={name} oninput={onNameInput} aria-label="Agent name" />
    </label>
    <StatusDot status={agent.state} />
    <span class="save" aria-live="polite">
      {#if save === "saving"}Saving…{:else if save === "saved"}Saved{:else if save === "error"}Couldn't save — retry{/if}
    </span>
    <button class="test-toggle" onclick={() => (showTest = !showTest)} aria-pressed={showTest}>Test</button>
  </div>

  <div class="split" class:show-test={showTest}>
    <div class="config">
      <Section label="Model">
        <ModelSelector {providers} value={agent.model} onchange={onModelChange} />
      </Section>
    </div>
    <div class="test-pane">
      <p class="muted">Test runs appear here.</p>
    </div>
  </div>
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
  .back:focus-visible {
    outline: 2px solid var(--focus-ring);
    outline-offset: 2px;
    border-radius: var(--radius-sm);
  }
  .name-field {
    flex: 1;
    min-width: 0;
  }
  .name-field input {
    width: 100%;
    max-width: 360px;
    height: var(--control-h-md);
    padding: 0 var(--space-3);
    font-size: var(--text-lg);
    font-weight: var(--weight-semibold);
    color: var(--text-primary);
    background: var(--surface-card);
    border: 1px solid transparent;
    border-radius: var(--radius-md);
  }
  .name-field input:hover {
    border-color: var(--border-subtle);
  }
  .name-field input:focus-visible {
    outline: 2px solid var(--focus-ring);
    outline-offset: 2px;
    border-color: var(--border-strong);
  }
  .save {
    font-size: 11px;
    letter-spacing: var(--tracking-micro);
    text-transform: uppercase;
    color: var(--text-tertiary);
    min-width: 9ch;
  }
  .test-toggle {
    display: none; /* only shown < 1024px */
    height: var(--control-h-sm);
    padding: 0 var(--space-3);
    background: var(--action-secondary-bg);
    color: var(--action-secondary-fg);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    cursor: pointer;
  }

  .split {
    display: grid;
    grid-template-columns: 60fr 40fr;
    gap: 0;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    overflow: hidden;
    min-height: 60vh;
  }
  .config {
    background: var(--surface-card);
    padding: var(--space-2) var(--space-5);
  }
  .test-pane {
    background: var(--bg-canvas);
    border-left: 1px solid var(--border-subtle);
    padding: var(--space-5);
  }

  /* Below 1024px: single-column config; the test pane collapses behind the Test toggle. */
  @media (max-width: 1023px) {
    .test-toggle {
      display: inline-flex;
      align-items: center;
    }
    .split {
      grid-template-columns: 1fr;
    }
    .test-pane {
      display: none;
      border-left: none;
      border-top: 1px solid var(--border-subtle);
    }
    .split.show-test .test-pane {
      display: block;
    }
  }

  .muted {
    color: var(--text-tertiary);
    font-size: var(--text-sm);
  }
  .error {
    color: var(--state-failed);
    font-size: var(--text-sm);
  }
  .stack {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-3);
  }
  .link,
  .primary {
    font-size: var(--text-sm);
  }
  .primary {
    height: var(--control-h-md);
    padding: 0 var(--space-4);
    background: var(--action-primary-bg);
    color: var(--action-primary-fg);
    border: none;
    border-radius: var(--radius-md);
    cursor: pointer;
  }
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
