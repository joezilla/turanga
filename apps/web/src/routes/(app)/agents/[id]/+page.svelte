<script lang="ts">
  // Agent-definition surface: two-pane builder (config left / test right), collapsible
  // sections, autosave. Model (3.2), Instructions + Variables (3.3). Skills/Cost caps are
  // later stories; the test pane is a scaffold (runs are Epic 4).
  import { page } from "$app/state";
  import { onDestroy } from "svelte";
  import { ArrowLeft, Circle } from "@lucide/svelte";
  import { getAgent, updateAgent, type Agent, type AgentPatch, type AgentVariable, type AttachedSkill, type CostCap } from "$lib/agents";
  import { listProviders, type Provider } from "$lib/connections";
  import { startRun, runEventsUrl, type RunMessage } from "$lib/runs";
  import { undefinedVariables } from "$lib/variables";
  import Section from "$lib/components/Section.svelte";
  import StatusDot from "$lib/components/StatusDot.svelte";
  import RunStatusDot from "$lib/components/RunStatusDot.svelte";
  import ModelSelector from "$lib/components/ModelSelector.svelte";
  import InstructionsEditor from "$lib/components/InstructionsEditor.svelte";
  import SkillsEditor from "$lib/components/SkillsEditor.svelte";
  import CostCapsEditor from "$lib/components/CostCapsEditor.svelte";

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
  let costCap = $state<CostCap>({ perRun: null, perDay: null });
  let capsTimer: ReturnType<typeof setTimeout> | null = null;

  // Config UI state
  let showTest = $state(false); // < 1024px: the test pane collapses behind this toggle

  // Test pane (Story 4.2): start a run, then stream its control-channel messages over SSE.
  // runState drives the five UI states. `error` = couldn't start / stream dropped (a control-plane
  // problem, not a run that executed and resolved to failed).
  type RunUiState = "empty" | "running" | "succeeded" | "failed" | "killed" | "error";
  let runState = $state<RunUiState>("empty");
  let taskInput = $state("");
  let transcript = $state<RunMessage[]>([]);
  let runError = $state("");
  let es: EventSource | null = null; // the live SSE stream (not reactive)
  let doneReceived = false;

  const lastMetrics = $derived(transcript.filter((m): m is Extract<RunMessage, { type: "metrics" }> => m.type === "metrics").at(-1));
  const fmtNum = (n: number) => n.toLocaleString("en-US");

  function closeStream() {
    if (es) {
      es.close();
      es = null;
    }
  }

  function runTest() {
    if (runState === "running") return; // one test at a time
    closeStream();
    transcript = [];
    runError = "";
    doneReceived = false;
    runState = "running";
    const task = taskInput;
    void (async () => {
      const started = await startRun(id, task);
      if (!started.ok) {
        // Couldn't even start — cause→consequence→recovery inline (no run executed).
        runState = "error";
        runError = started.error;
        return;
      }
      const source = new EventSource(runEventsUrl(started.value.id), { withCredentials: true });
      es = source;
      source.addEventListener("message", (e) => {
        try {
          transcript = [...transcript, JSON.parse((e as MessageEvent).data) as RunMessage];
        } catch {
          /* skip an unreadable frame rather than break the stream */
        }
      });
      source.addEventListener("done", (e) => {
        doneReceived = true;
        try {
          const { status } = JSON.parse((e as MessageEvent).data) as { status: "succeeded" | "failed" | "killed" };
          runState = status;
        } catch {
          runState = "failed";
        }
        closeStream(); // we own the close so the browser doesn't auto-reconnect
      });
      source.onerror = () => {
        // EventSource also fires error when the server closes normally — only surface it if we
        // never received the terminal `done` (a genuine mid-stream drop).
        if (!doneReceived) {
          runState = "error";
          runError = "The test stream dropped before finishing. Check the control plane, then run the test again.";
        }
        closeStream();
      };
    })();
  }

  function clearTest() {
    closeStream();
    transcript = [];
    runError = "";
    runState = "empty";
  }

  // Cmd/Ctrl+Enter runs the current test from anywhere in the editor (EXPERIENCE.md#Interaction).
  function onEditorKeydown(e: KeyboardEvent) {
    if (!agent) return; // only while an agent is loaded
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      runTest();
    }
  }

  onDestroy(closeStream);

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

  // Drop any debounced saves still pending for the previous agent so they can't PATCH the new
  // one with the old agent's data (a fast edit-then-navigate would otherwise cross agents).
  function cancelPendingSaves() {
    for (const t of [nameTimer, instrTimer, varsTimer, capsTimer]) if (t) clearTimeout(t);
    nameTimer = instrTimer = varsTimer = capsTimer = null;
  }

  async function load() {
    const target = id; // guard against a fast id change resolving out of order
    cancelPendingSaves();
    clearTest(); // a different agent starts with a fresh test pane
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
    costCap = { perRun: a.value.costCap.perRun, perDay: a.value.costCap.perDay };
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

  function onCapsChange(next: CostCap) {
    costCap = next;
    if (capsTimer) clearTimeout(capsTimer);
    capsTimer = setTimeout(() => persist({ costCap: next }), 400); // typed text → debounce
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

<svelte:window onkeydown={onEditorKeydown} />

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

      <Section label="Cost caps">
        <CostCapsEditor value={costCap} onchange={onCapsChange} />
      </Section>
    </div>
    <div class="test-pane">
      <div class="transcript" role="log" aria-live="polite">
        {#if transcript.length === 0 && runState !== "error"}
          <p class="muted">No test runs.</p>
        {:else}
          {#each transcript as msg, i (i)}
            {#if msg.type === "turn"}
              <div class="turn">
                <span class="turn-role">{msg.role}</span>
                <p class="turn-text">{msg.text}</p>
              </div>
            {:else if msg.type === "refusal"}
              <div class="refusal">
                <Circle size={7} fill="var(--state-failed)" color="var(--state-failed)" aria-hidden="true" />
                <span>Refused ({msg.kind}) — {msg.detail}</span>
              </div>
            {/if}
          {/each}

          {#if runState === "running"}
            <div class="resolution"><RunStatusDot status="running" /></div>
          {:else if runState === "succeeded" || runState === "failed" || runState === "killed"}
            <div class="resolution">
              <RunStatusDot status={runState} />
              {#if lastMetrics}
                <span class="metrics mono-num">{fmtNum(lastMetrics.latencyMs)} ms · {fmtNum(lastMetrics.tokens)} tokens</span>
              {/if}
            </div>
          {/if}
        {/if}

        {#if runState === "error"}
          <p class="run-error">
            <Circle size={7} fill="var(--state-failed)" color="var(--state-failed)" aria-hidden="true" />
            <span>{runError}</span>
          </p>
        {/if}
      </div>

      <div class="composer">
        <label class="visually-hidden" for="task-input">Task for this test run</label>
        <textarea id="task-input" rows="2" placeholder="What should it do?" bind:value={taskInput}></textarea>
        <div class="composer-actions">
          <button type="button" class="ghost" onclick={clearTest} disabled={transcript.length === 0 && runState === "empty"}>Clear</button>
          <button type="button" class="primary" onclick={runTest} disabled={runState === "running"}>Run test</button>
        </div>
      </div>
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
    border-left: 1px solid var(--border-subtle); /* hairline, never shadow (DESIGN.md#Elevation) */
    padding: var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    min-height: 0;
  }
  .transcript {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    overflow-y: auto;
    min-height: 0;
  }
  .turn {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .turn-role {
    font-size: 11px;
    letter-spacing: var(--tracking-micro);
    text-transform: uppercase;
    color: var(--text-tertiary);
  }
  .turn-text {
    margin: 0;
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    color: var(--text-primary);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .resolution {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }
  .metrics {
    font-size: var(--text-sm); /* ≥ 12px */
    color: var(--text-secondary);
  }
  .refusal,
  .run-error {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    margin: 0;
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }
  .composer {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .composer textarea {
    width: 100%;
    resize: vertical;
    padding: var(--space-2) var(--space-3);
    font-family: inherit;
    font-size: var(--text-sm);
    color: var(--text-primary);
    background: var(--surface-card);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
  }
  .composer-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
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
