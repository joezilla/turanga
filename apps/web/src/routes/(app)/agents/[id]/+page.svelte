<script lang="ts">
  // Agent-definition surface: two-pane builder (config left / test right), collapsible
  // sections, autosave. Model (3.2), Instructions + Variables (3.3). Skills/Cost caps are
  // later stories; the test pane is a scaffold (runs are Epic 4).
  import { page } from "$app/state";
  import { ArrowLeft, Circle } from "@lucide/svelte";
  import { getAgent, updateAgent, type Agent, type AgentPatch, type AgentVariable, type AttachedSkill } from "$lib/agents";
  import { listProviders, type Provider } from "$lib/connections";
  import { undefinedVariables } from "$lib/variables";
  import Section from "$lib/components/Section.svelte";
  import StatusDot from "$lib/components/StatusDot.svelte";
  import ModelSelector from "$lib/components/ModelSelector.svelte";
  import InstructionsEditor from "$lib/components/InstructionsEditor.svelte";
  import SkillsEditor from "$lib/components/SkillsEditor.svelte";

  const VAR_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

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

  // Local editable copies of instructions + variables (seeded on load; the server response
  // is not written back onto them so in-progress typing isn't clobbered).
  let instructions = $state("");
  let instrTimer: ReturnType<typeof setTimeout> | null = null;
  let vars = $state<AgentVariable[]>([]);
  let varsTimer: ReturnType<typeof setTimeout> | null = null;
  let skills = $state<AttachedSkill[]>([]);

  // Config UI state
  let showTest = $state(false); // < 1024px: the test pane collapses behind this toggle

  const definedNames = $derived(vars.map((v) => v.name).filter((n) => VAR_NAME_RE.test(n)));
  const undefinedNames = $derived(undefinedVariables(instructions, definedNames));

  // Per-row "why this variable isn't saved" cue (blank / malformed / duplicate name).
  const varIssues = $derived.by(() => {
    const seen = new Set<string>();
    return vars.map((v) => {
      if (!v.name.trim()) return "name required";
      if (!VAR_NAME_RE.test(v.name)) return "use letters, numbers, or _ (start with a letter)";
      if (seen.has(v.name)) return "duplicate name";
      seen.add(v.name);
      return "";
    });
  });

  async function load() {
    const target = id; // guard against a fast id change resolving out of order
    loading = true;
    notFound = false;
    loadError = "";
    const [a, p] = await Promise.all([getAgent(target), listProviders()]);
    if (target !== id) return; // navigated away before this resolved — drop it
    loading = false;
    if (!a.ok) {
      if (a.error.includes("doesn't exist")) notFound = true;
      else loadError = a.error;
      return;
    }
    agent = a.value;
    name = a.value.name;
    instructions = a.value.instructions;
    vars = a.value.variables.map((v) => ({ ...v }));
    skills = a.value.skills.map((s) => ({ ...s }));
    providers = p.ok ? p.value : []; // a provider outage shouldn't block editing the agent
  }
  $effect(() => {
    // re-run when the route id changes
    void id;
    load();
  });

  // Server-authoritative autosave (AD-7): PATCH, then trust the returned agent. A monotonic
  // seq coalesces overlapping saves so an out-of-order response can't overwrite newer state.
  let saveSeq = 0;
  async function persist(patch: AgentPatch) {
    const mine = ++saveSeq;
    save = "saving";
    const r = await updateAgent(id, patch);
    if (mine !== saveSeq) return; // a newer save superseded this one
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

  function onSkillsChange(next: AttachedSkill[]) {
    skills = next;
    persist({ skills: next }); // discrete change → save immediately
  }

  function onInstructionsInput(v: string) {
    instructions = v;
    if (instrTimer) clearTimeout(instrTimer);
    instrTimer = setTimeout(() => persist({ instructions }), 400); // debounce text; empty is allowed
  }

  // Persist only well-formed, unique-named variables — incomplete rows stay visible for editing
  // but aren't sent (control-api would reject a blank/duplicate name).
  function validVars(): AgentVariable[] {
    const seen = new Set<string>();
    const out: AgentVariable[] = [];
    for (const v of vars) {
      if (VAR_NAME_RE.test(v.name) && !seen.has(v.name)) {
        seen.add(v.name);
        out.push({ name: v.name, value: v.value });
      }
    }
    return out;
  }
  function persistVars() {
    persist({ variables: validVars() });
  }
  function debouncePersistVars() {
    if (varsTimer) clearTimeout(varsTimer);
    varsTimer = setTimeout(persistVars, 400);
  }

  function addVariable() {
    vars = [...vars, { name: "", value: "" }]; // persisted once it has a valid name
  }
  function removeVariable(i: number) {
    if (varsTimer) clearTimeout(varsTimer); // drop any pending value-edit save for the old rows
    vars = vars.filter((_, idx) => idx !== i);
    persistVars(); // structural change → save now
  }
  function onVarField(i: number, field: "name" | "value", val: string) {
    vars = vars.map((v, idx) => (idx === i ? { ...v, [field]: val } : v));
    debouncePersistVars();
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
      <input type="text" maxlength="200" value={name} oninput={onNameInput} aria-label="Agent name" />
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

      <Section label="Instructions">
        <InstructionsEditor value={instructions} variableNames={definedNames} oninput={onInstructionsInput} />
        {#if undefinedNames.length > 0}
          <p class="caution">
            <Circle size={7} fill="var(--caution-500)" color="var(--caution-500)" aria-hidden="true" />
            <span>
              caution — {undefinedNames.length} undefined variable{undefinedNames.length === 1 ? "" : "s"}:
              {#each undefinedNames as n, i}<code>&#123;{n}&#125;</code>{i < undefinedNames.length - 1 ? ", " : ""}{/each}.
              <a href="#variables-section">Define {undefinedNames.length === 1 ? "it" : "them"} in Variables.</a>
            </span>
          </p>
        {/if}
      </Section>

      <Section label="Skills">
        <SkillsEditor value={skills} onchange={onSkillsChange} />
      </Section>

      <div id="variables-section">
        <Section label="Variables">
          {#if vars.length === 0}
            <p class="muted">No variables yet.</p>
          {/if}
          {#each vars as v, i (i)}
            <div class="var-row">
              <label class="var-field">
                <span class="visually-hidden">Variable name</span>
                <input
                  type="text"
                  class="var-name"
                  placeholder="name"
                  aria-label="Variable name"
                  value={v.name}
                  oninput={(e) => onVarField(i, "name", (e.currentTarget as HTMLInputElement).value)}
                />
              </label>
              <label class="var-field grow">
                <span class="visually-hidden">Variable value</span>
                <input
                  type="text"
                  maxlength="2000"
                  placeholder="value"
                  aria-label="Variable value"
                  value={v.value}
                  oninput={(e) => onVarField(i, "value", (e.currentTarget as HTMLInputElement).value)}
                />
              </label>
              <button type="button" class="ghost" onclick={() => removeVariable(i)}>Remove</button>
              {#if varIssues[i]}<span class="var-issue">{varIssues[i]} — not saved</span>{/if}
            </div>
          {/each}
          <button type="button" class="secondary" onclick={addVariable}>Add variable</button>
        </Section>
      </div>
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
  .caution {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    margin: var(--space-2) 0 0;
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }
  .caution code {
    font-family: var(--font-mono);
    color: var(--text-primary);
  }
  .caution a {
    color: var(--text-link);
  }
  .var-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    margin-bottom: var(--space-2);
    max-width: 640px;
  }
  .var-issue {
    flex-basis: 100%;
    font-size: var(--text-xs);
    color: var(--caution-600);
  }
  .var-field {
    display: block;
  }
  .var-field.grow {
    flex: 1;
  }
  .var-row input {
    width: 100%;
    height: var(--control-h-md);
    padding: 0 var(--space-3);
    font-size: var(--text-sm);
    color: var(--text-primary);
    background: var(--surface-card);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
  }
  .var-row .var-name {
    font-family: var(--font-mono);
    width: 160px;
  }
  .secondary,
  .ghost {
    height: var(--control-h-md);
    padding: 0 var(--space-3);
    font-size: var(--text-sm);
    border-radius: var(--radius-md);
    cursor: pointer;
  }
  .secondary {
    background: var(--action-secondary-bg);
    color: var(--action-secondary-fg);
    border: 1px solid var(--border-strong);
  }
  .ghost {
    background: none;
    border: 1px solid transparent;
    color: var(--text-secondary);
  }
  .ghost:hover {
    color: var(--text-primary);
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
