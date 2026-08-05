<script lang="ts">
  // Agent editor — the design's tabbed workspace. Four tabs over one definition (Definition,
  // Tools, Skills, Limits), a header carrying identity + lifecycle + publish, a dirty bar, and
  // the test console as a docked drawer.
  //
  // SAVE MODEL (changed from Story 3.2's autosave): edits live in component state until you press
  // Save draft. The saved draft then differs from the published snapshot until you Publish, which
  // the server reports back as `dirty` + `changedFields`. Two distinct ideas share the word
  // "unsaved", so they're named apart throughout: `unsaved` = typed but not PATCHed;
  // `agent.dirty` = saved but not published.
  import { page } from "$app/state";
  import { beforeNavigate, goto } from "$app/navigation";
  import { Play, Circle, X } from "@lucide/svelte";
  import {
    getAgent,
    updateAgent,
    activateAgent,
    deactivateAgent,
    publishAgent,
    duplicateAgent,
    listVersions,
    activationBlockers,
    FIELD_TAB,
    type Agent,
    type AgentPatch,
    type AgentVariable,
    type AttachedSkill,
    type AttachedTool,
    type CostCap,
    type AgentVersion,
  } from "$lib/agents";
  import { listProviders, type Provider } from "$lib/connections";
  import { listTools, type Tool } from "$lib/tools";
  import { getAgentToolStats, type ToolStat } from "$lib/runs";
  import { formatTimestamp } from "$lib/datetime";
  import { agentsChanged } from "$lib/agentsBus.svelte";
  import { undefinedVariables } from "$lib/variables";
  import ModelSelector from "$lib/components/ModelSelector.svelte";
  import InstructionsEditor from "$lib/components/InstructionsEditor.svelte";
  import SkillsEditor from "$lib/components/SkillsEditor.svelte";
  import AgentToolsTab from "$lib/components/AgentToolsTab.svelte";
  import CostCapsEditor from "$lib/components/CostCapsEditor.svelte";
  import TestConsole from "$lib/components/TestConsole.svelte";

  const VAR_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

  const id = $derived(page.params.id ?? "");

  let agent = $state<Agent | null>(null); // the last server-confirmed state
  let providers = $state<Provider[]>([]);
  let connectedTools = $state<Tool[]>([]);
  let toolStats = $state<ToolStat[]>([]);
  let loading = $state(true);
  let loadError = $state("");
  let notFound = $state(false);

  // Local editable copies. Seeded on load and after every successful save/discard.
  let name = $state("");
  let description = $state("");
  let model = $state<string | null>(null);
  let instructions = $state("");
  let vars = $state<AgentVariable[]>([]);
  let skills = $state<AttachedSkill[]>([]);
  let attachedTools = $state<AttachedTool[]>([]);
  let costCap = $state<CostCap>({ perRun: null, perDay: null });

  type Tab = "definition" | "tools" | "skills" | "limits";
  let tab = $state<Tab>("definition");
  let consoleOpen = $state(false);
  let consoleRef = $state<TestConsole | null>(null);

  let saving = $state(false);
  let saveError = $state("");
  let savedAt = $state("");
  let publishing = $state(false);
  let publishError = $state("");
  let duplicating = $state(false);
  let lifecycleBusy = $state(false);
  let activateError = $state("");
  let showDeactivateConfirm = $state(false);
  let historyOpen = $state(false);
  let versions = $state<AgentVersion[]>([]);
  let versionsError = $state("");

  function seed(a: Agent) {
    name = a.name;
    description = a.description;
    model = a.model;
    instructions = a.instructions;
    vars = a.variables.map((v) => ({ ...v }));
    skills = a.skills.map((s) => ({ ...s }));
    attachedTools = a.attachedTools.map((at) => ({ ...at, operations: [...at.operations] }));
    costCap = { perRun: a.costCap.perRun, perDay: a.costCap.perDay };
  }

  // Serialize with OBJECT KEYS SORTED (arrays keep their order — reordering is a real edit). A
  // client-built object and a Postgres-jsonb object that PG re-key-ordered are structurally equal
  // but stringify differently otherwise; e.g. local costCap `{perRun,perDay}` vs the server's
  // `{perDay,perRun}` would forever read as an unsaved "Limits" change. This makes the compare stable.
  function stable(x: unknown): string {
    return JSON.stringify(x, (_, v) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? Object.keys(v as Record<string, unknown>)
            .sort()
            .reduce<Record<string, unknown>>((o, k) => ((o[k] = (v as Record<string, unknown>)[k]), o), {})
        : v,
    );
  }

  // Typed-but-not-saved. Compared field by field against the last server-confirmed agent, the same
  // way the server compares the saved draft against the published snapshot.
  const unsavedFields = $derived.by((): string[] => {
    if (!agent) return [];
    const out: string[] = [];
    if (name.trim() !== agent.name) out.push("name");
    if (description !== agent.description) out.push("description");
    if (model !== agent.model) out.push("model");
    if (instructions !== agent.instructions) out.push("instructions");
    if (stable(validVars()) !== stable(agent.variables)) out.push("variables");
    if (stable(skills) !== stable(agent.skills)) out.push("skills");
    if (stable(attachedTools) !== stable(agent.attachedTools)) out.push("attachedTools");
    if (stable(costCap) !== stable(agent.costCap)) out.push("costCap");
    return out;
  });
  const unsaved = $derived(unsavedFields.length > 0);

  // Human labels for the dirty bar — never surface raw field keys (`attachedTools`, `costCap`).
  const FIELD_LABEL: Record<string, string> = {
    name: "Name",
    description: "Description",
    model: "Model",
    instructions: "Instructions",
    variables: "Variables",
    skills: "Skills",
    attachedTools: "Tools",
    costCap: "Limits",
  };
  const labelFields = (fs: string[]): string => fs.map((f) => FIELD_LABEL[f] ?? f).join(", ");

  // A tab shows a caution dot when it holds either kind of pending change.
  const tabsWithChange = $derived.by(() => {
    const set = new Set<Tab>();
    for (const f of unsavedFields) set.add(FIELD_TAB[f as keyof typeof FIELD_TAB] ?? "definition");
    for (const f of agent?.changedFields ?? []) set.add(FIELD_TAB[f] ?? "definition");
    return set;
  });

  const tabs = $derived([
    { key: "definition" as Tab, label: "Definition", count: null as number | null },
    { key: "tools" as Tab, label: "Tools", count: attachedTools.reduce((n, t) => n + t.operations.length, 0) },
    { key: "skills" as Tab, label: "Skills", count: skills.length },
    { key: "limits" as Tab, label: "Limits", count: null as number | null },
  ]);

  const definedNames = $derived(vars.map((v) => v.name).filter((n) => VAR_NAME_RE.test(n)));
  const undefinedNames = $derived(undefinedVariables(instructions, definedNames));

  const modelProviderConnected = $derived.by(() => {
    if (!agent?.model) return false;
    const prefix = agent.model.split("/")[0];
    return providers.some((p) => p.status === "connected" && (p.provider === prefix || p.name === prefix));
  });
  const activateBlockers = $derived(
    agent ? activationBlockers({ model: agent.model, costCap: agent.costCap }, modelProviderConnected) : [],
  );

  const nextVersion = $derived((agent?.publishedVersion ?? 0) + 1);
  const publishBlocker = $derived.by(() => {
    if (unsaved) return "Save the draft before publishing it.";
    if (!agent?.dirty) return "There are no unpublished changes.";
    return "";
  });

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

  // Only well-formed, unique-named variables are sent — incomplete rows stay visible for editing
  // but aren't persisted (control-api would reject a blank/duplicate name).
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

  async function load() {
    const target = id; // guard against a fast id change resolving out of order
    loading = true;
    notFound = false;
    loadError = "";
    saveError = "";
    publishError = "";
    activateError = "";
    savedAt = "";
    historyOpen = false;
    toolStats = [];
    // Clear any in-flight busy flags — a mutation on the previous agent early-returns on the
    // target guard below without resetting its own flag, so the new agent must start clean.
    saving = false;
    publishing = false;
    lifecycleBusy = false;
    const [a, p, t] = await Promise.all([getAgent(target), listProviders(), listTools()]);
    if (target !== id) return; // navigated away before this resolved — drop it
    loading = false;
    if (!a.ok) {
      if (a.error.includes("doesn't exist")) notFound = true;
      else loadError = a.error;
      return;
    }
    agent = a.value;
    seed(a.value);
    providers = p.ok ? p.value : []; // a provider outage shouldn't block editing the agent
    connectedTools = t.ok ? t.value : []; // a tools outage shouldn't block editing the agent
    void getAgentToolStats(target).then((s) => { if (target === id) toolStats = s; }); // Story 6.5 — best-effort
  }

  $effect(() => {
    void id; // re-run when the route id changes
    load();
  });

  // A monotonic seq coalesces overlapping saves so an out-of-order response can't overwrite
  // newer state (carried over from the autosave implementation).
  let saveSeq = 0;
  async function save() {
    if (!agent || saving || !unsaved) return;
    const trimmed = name.trim();
    if (!trimmed) {
      saveError = "A name can't be empty. Give the agent a name, then save.";
      return;
    }
    const patch: AgentPatch = {
      name: trimmed,
      description,
      model,
      instructions,
      variables: validVars(),
      skills,
      attachedTools,
      costCap,
    };
    const target = id; // a save that resolves after navigation must not clobber the new agent
    const mine = ++saveSeq;
    saving = true;
    saveError = "";
    const r = await updateAgent(target, patch);
    if (target !== id || mine !== saveSeq) return; // navigated away OR superseded → drop it
    saving = false;
    if (r.ok) {
      // Adopt the server's canonical row so `unsaved` recomputes — but do NOT re-seed the editable
      // copies: that would clobber keystrokes typed during the in-flight save. (When nothing was
      // typed, the local copies already match what was sent; genuine new edits stay flagged unsaved.)
      agent = r.value;
      savedAt = formatTimestamp(new Date().toISOString());
      agentsChanged(); // the list column shows the name + the unpublished marker
    } else {
      saveError = r.error;
    }
  }

  function discard() {
    if (!agent) return;
    seed(agent); // back to the last server-confirmed draft
    saveError = "";
  }

  async function publish() {
    if (!agent || publishing || publishBlocker) return;
    const target = id;
    publishing = true;
    publishError = "";
    const r = await publishAgent(target);
    if (target !== id) return; // navigated away → drop
    publishing = false;
    if (r.ok) {
      // Publish is gated on !unsaved, so the draft content is unchanged — adopting the row (without
      // re-seeding) clears `dirty` while leaving any keystrokes typed during the round-trip intact.
      agent = r.value;
      agentsChanged();
      if (historyOpen) void loadVersions();
    } else {
      publishError = r.error;
    }
  }

  async function loadVersions() {
    versionsError = "";
    const r = await listVersions(id);
    if (r.ok) versions = r.value;
    else versionsError = r.error;
  }

  function toggleHistory() {
    historyOpen = !historyOpen;
    if (historyOpen) void loadVersions();
  }

  async function duplicate() {
    if (duplicating) return; // a double-click must not fire two copies
    duplicating = true;
    const r = await duplicateAgent(id);
    if (r.ok) {
      agentsChanged();
      await goto(`/agents/${r.value.id}`); // navigates away → the reloaded editor resets `duplicating`
    } else {
      duplicating = false;
      saveError = r.error;
    }
  }

  async function doActivate() {
    if (!agent || activateBlockers.length || lifecycleBusy) return;
    // Activate acts on the SAVED draft — refuse when there are unsaved edits so the user never
    // activates a config that differs from what's on screen (mirrors Publish's save-first gate).
    if (unsaved) {
      activateError = "Save the draft before activating it.";
      return;
    }
    const target = id;
    lifecycleBusy = true;
    activateError = "";
    const r = await activateAgent(target);
    if (target !== id) return; // navigated away → drop
    lifecycleBusy = false;
    if (r.ok) {
      agent = r.value;
      agentsChanged();
    } else activateError = r.error; // e.g. caps cleared between enabling the button and the click
  }
  async function doDeactivate() {
    if (!agent || lifecycleBusy) return;
    const target = id;
    lifecycleBusy = true;
    const r = await deactivateAgent(target);
    if (target !== id) return; // navigated away → drop
    lifecycleBusy = false;
    showDeactivateConfirm = false;
    if (r.ok) {
      agent = r.value;
      agentsChanged();
    }
  }

  function addVariable() {
    vars = [...vars, { name: "", value: "" }];
  }
  function removeVariable(i: number) {
    vars = vars.filter((_, idx) => idx !== i);
  }
  function onVarField(i: number, field: "name" | "value", val: string) {
    vars = vars.map((v, idx) => (idx === i ? { ...v, [field]: val } : v));
  }

  // Cmd/Ctrl+S saves the draft; Cmd/Ctrl+Enter runs the test (EXPERIENCE.md#Interaction).
  function onEditorKeydown(e: KeyboardEvent) {
    if (!agent) return;
    if (e.key === "s" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void save();
      return;
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      consoleOpen = true;
      consoleRef?.runTest();
    }
  }

  // Leaving with typed-but-unsaved edits would drop them silently.
  beforeNavigate(({ cancel, to }) => {
    if (!unsaved) return;
    if (to?.url.pathname === page.url.pathname) return;
    if (!confirm("You have unsaved edits. Leave this agent and discard them?")) cancel();
  });
</script>

<svelte:window onkeydown={onEditorKeydown} />

<main class="editor">
  {#if loading}
    <p class="pane-msg">Loading agent…</p>
  {:else if notFound}
    <div class="pane-msg stack">
      <p>That agent doesn't exist.</p>
      <a class="link" href="/agents">Back to Agents</a>
    </div>
  {:else if loadError}
    <div class="pane-msg stack">
      <p class="error">{loadError}</p>
      <button type="button" class="secondary" onclick={load}>Retry</button>
    </div>
  {:else if agent}
    <header class="head">
      <div class="identity">
        <span class="agent-name">{agent.name}</span>
        <span class="agent-id mono-num">{agent.id}</span>
        <span class="pill">
          <span class="pill-dot" class:live={agent.state === "active"} aria-hidden="true"></span>
          {agent.state === "active" ? "Active" : "Draft"}
        </span>
        <span class="version mono-num">{agent.publishedVersion === null ? "unpublished" : `v${agent.publishedVersion}`}</span>
      </div>

      <div class="head-actions">
        <button type="button" class="ghost" class:on={consoleOpen} onclick={() => (consoleOpen = !consoleOpen)} aria-pressed={consoleOpen}>
          <Play size={13} color="currentColor" />
          Test
        </button>
        <a class="ghost" href="/agents/{agent.id}/runs">Runs</a>
        <button type="button" class="ghost" onclick={toggleHistory} aria-expanded={historyOpen}>History</button>
        <button type="button" class="secondary" onclick={duplicate} disabled={duplicating}>Duplicate</button>
        {#if agent.state === "draft"}
          <button
            type="button"
            class="secondary"
            onclick={doActivate}
            disabled={activateBlockers.length > 0 || unsaved || lifecycleBusy}
            title={unsaved ? "Save the draft before activating it." : activateBlockers.join(" ")}
          >
            Activate
          </button>
        {:else}
          <button type="button" class="secondary" onclick={() => (showDeactivateConfirm = true)} disabled={lifecycleBusy}>
            Deactivate
          </button>
        {/if}
        <button type="button" class="primary" onclick={publish} disabled={!!publishBlocker || publishing} title={publishBlocker}>
          Publish v{nextVersion}
        </button>
      </div>
    </header>

    {#if activateBlockers.length > 0 || activateError || publishError}
      <p class="head-note">
        {#if publishError}{publishError}{:else if activateError}{activateError}{:else}{activateBlockers.join(" ")}{/if}
      </p>
    {/if}

    {#if showDeactivateConfirm}
      <div class="confirm" role="alertdialog" aria-label="Deactivate agent">
        <p>Deactivate returns this agent to Draft; it won't run in production until you re-activate it.</p>
        <div class="confirm-actions">
          <button type="button" class="ghost" onclick={() => (showDeactivateConfirm = false)} disabled={lifecycleBusy}>Cancel</button>
          <button type="button" class="primary" onclick={doDeactivate} disabled={lifecycleBusy}>Deactivate</button>
        </div>
      </div>
    {/if}

    {#if historyOpen}
      <div class="history">
        <div class="micro">Publish history</div>
        {#if versionsError}
          <p class="error small">{versionsError}</p>
        {:else if versions.length === 0}
          <p class="small muted">Nothing published yet. Publishing records the definition as v1.</p>
        {:else}
          <ul>
            {#each versions as v (v.version)}
              <li>
                <span class="mono-num strong">v{v.version}</span>
                <span class="small">{formatTimestamp(v.publishedAt)}</span>
                {#if v.publishedBy}<span class="small muted">{v.publishedBy}</span>{/if}
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/if}

    <nav class="tabs" aria-label="Agent editor sections">
      {#each tabs as t (t.key)}
        <button type="button" class="tab" class:on={tab === t.key} onclick={() => (tab = t.key)} aria-current={tab === t.key ? "true" : undefined}>
          {t.label}
          {#if t.count !== null}<span class="tab-count mono-num">{t.count}</span>{/if}
          {#if tabsWithChange.has(t.key)}<span class="tab-dot" title="Has changes that aren't published"></span>{/if}
        </button>
      {/each}
    </nav>

    <div class="body">
      <div class="pane-col">
        {#if tab === "definition"}
          <div class="scroll pad">
            <div class="form">
              <section>
                <div class="micro">Identity</div>
                <div class="grid-2">
                  <label class="field">
                    <span>Name</span>
                    <input type="text" maxlength="200" aria-label="Agent name" bind:value={name} />
                  </label>
                  <div class="field">
                    <span class="field-label">Model</span>
                    <ModelSelector {providers} value={model} onchange={(m) => (model = m)} />
                  </div>
                </div>
                <label class="field">
                  <span>Description</span>
                  <input type="text" maxlength="300" aria-label="Agent description" bind:value={description} placeholder="What this agent is for" />
                </label>
              </section>

              <section>
                <div class="section-head">
                  <div class="micro">Instructions</div>
                  <span class="mono-num chars">{instructions.length.toLocaleString("en-US")} / 20,000</span>
                </div>
                <InstructionsEditor value={instructions} variableNames={definedNames} oninput={(v) => (instructions = v)} />
                {#if undefinedNames.length > 0}
                  <p class="caution">
                    <Circle size={7} fill="var(--caution-500)" color="var(--caution-500)" aria-hidden="true" />
                    <span>
                      caution — {undefinedNames.length} undefined variable{undefinedNames.length === 1 ? "" : "s"}:
                      {#each undefinedNames as n, i}<code>&#123;{n}&#125;</code>{i < undefinedNames.length - 1 ? ", " : ""}{/each}.
                      Define {undefinedNames.length === 1 ? "it" : "them"} below.
                    </span>
                  </p>
                {/if}
              </section>

              <section>
                <div class="micro">Variables</div>
                <div class="table">
                  <div class="table-head">
                    <span>name</span><span>value</span><span></span>
                  </div>
                  {#each vars as v, i (i)}
                    <div class="table-row">
                      <input
                        type="text"
                        class="mono"
                        placeholder="name"
                        aria-label="Variable name"
                        value={v.name}
                        oninput={(e) => onVarField(i, "name", (e.currentTarget as HTMLInputElement).value)}
                      />
                      <input
                        type="text"
                        maxlength="2000"
                        placeholder="value"
                        aria-label="Variable value"
                        value={v.value}
                        oninput={(e) => onVarField(i, "value", (e.currentTarget as HTMLInputElement).value)}
                      />
                      <button type="button" class="icon" aria-label="Remove variable" onclick={() => removeVariable(i)}>
                        <X size={13} color="currentColor" />
                      </button>
                      {#if varIssues[i]}<span class="row-issue">{varIssues[i]} — won't be saved</span>{/if}
                    </div>
                  {/each}
                  <div class="table-foot">
                    <button type="button" class="dashed" onclick={addVariable}>Add variable</button>
                  </div>
                </div>
              </section>
            </div>
          </div>
        {:else if tab === "tools"}
          <AgentToolsTab value={attachedTools} tools={connectedTools} onchange={(next) => (attachedTools = next)} />
          {#if toolStats.length > 0}
            <div class="stats">
              <div class="micro">Observed across this agent's runs</div>
              <ul>
                {#each toolStats as s (s.toolId)}
                  <li>
                    <span class="ta-name">{s.toolName}</span>
                    <span class="mono-num ta-stat">{s.invocations.toLocaleString("en-US")} call{s.invocations === 1 ? "" : "s"}</span>
                    {#if s.refusals > 0}<span class="mono-num ta-stat">· {s.refusals.toLocaleString("en-US")} refused</span>{/if}
                    {#if s.errors > 0}<span class="mono-num ta-stat">· {s.errors.toLocaleString("en-US")} error{s.errors === 1 ? "" : "s"}</span>{/if}
                    <span class="mono-num ta-stat">· {s.avgLatencyMs.toLocaleString("en-US")} ms avg</span>
                  </li>
                {/each}
              </ul>
            </div>
          {/if}
        {:else if tab === "skills"}
          <div class="scroll pad">
            <div class="form">
              <section>
                <div class="section-head">
                  <div class="micro">Skills</div>
                  <span class="blurb">Shared procedures. Each carries its own permission scope; a send grant is separate.</span>
                </div>
                <SkillsEditor value={skills} onchange={(next) => (skills = next)} />
              </section>
            </div>
          </div>
        {:else}
          <div class="scroll pad">
            <div class="form">
              <section>
                <div class="section-head">
                  <div class="micro">Cost caps</div>
                  <span class="blurb">A run is killed the moment it would exceed either cap. Both are required to activate.</span>
                </div>
                <CostCapsEditor value={costCap} onchange={(next) => (costCap = next)} />
              </section>
            </div>
          </div>
        {/if}

        {#if unsaved || saveError}
          <div class="dirty-bar">
            <div class="dirty-left">
              <span class="dot" aria-hidden="true"></span>
              {#if saveError}
                <span class="dirty-label">Couldn't save</span>
                <span class="dirty-detail">{saveError}</span>
              {:else}
                <span class="dirty-label">{unsavedFields.length} unsaved change{unsavedFields.length === 1 ? "" : "s"}</span>
                <span class="dirty-detail">{labelFields(unsavedFields)}</span>
              {/if}
            </div>
            <div class="dirty-right">
              {#if savedAt}<span class="dirty-detail">saved {savedAt}</span>{/if}
              <button type="button" class="ghost" onclick={discard} disabled={saving}>Discard changes</button>
              <button type="button" class="primary" onclick={save} disabled={saving || !unsaved}>
                {saving ? "Saving…" : "Save draft"}
              </button>
            </div>
          </div>
        {:else if agent.dirty}
          <div class="dirty-bar quiet">
            <div class="dirty-left">
              <span class="dot" aria-hidden="true"></span>
              <span class="dirty-label">
                {agent.publishedVersion === null ? "Never published" : `${agent.changedFields.length} change${agent.changedFields.length === 1 ? "" : "s"} not published`}
              </span>
              <span class="dirty-detail">{labelFields(agent.changedFields)}</span>
            </div>
            <div class="dirty-right">
              {#if agent.publishedAt}<span class="dirty-detail">last published {formatTimestamp(agent.publishedAt)}</span>{/if}
            </div>
          </div>
        {/if}
      </div>

      {#if consoleOpen}
        <TestConsole
          bind:this={consoleRef}
          agentId={agent.id}
          costCap={agent.costCap}
          dirty={unsaved}
          onClose={() => (consoleOpen = false)}
        />
      {/if}
    </div>
  {/if}
</main>

<style>
  .editor {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  /* Wraps rather than clips: below ~1400px the action row drops to its own line instead of
     squeezing the agent's name out of existence. */
  .head {
    flex: none;
    min-height: 48px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: var(--space-4);
    row-gap: var(--space-2);
    padding: var(--space-2) var(--space-4);
    border-bottom: 1px solid var(--border-hairline);
    background: var(--surface-card);
  }
  /* The identity block yields to the actions: the name truncates and the mono id drops out
     entirely before anything is allowed to overlap a button. */
  .identity {
    flex: 1 1 auto;
    display: flex;
    align-items: center;
    gap: var(--space-2-5);
    min-width: 0;
    overflow: hidden;
  }
  .agent-name {
    min-width: 8ch; /* never let the actions squeeze the name away entirely */
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    letter-spacing: var(--tracking-heading);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .agent-id,
  .version {
    flex: none;
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-tertiary);
    white-space: nowrap;
  }
  @media (max-width: 1400px) {
    .agent-id {
      display: none;
    }
  }
  /* Pill is reserved for live status — this is the one place it's allowed. */
  .pill {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1-5);
    flex: none;
    height: 20px;
    padding: 0 var(--space-2);
    font-size: var(--text-2xs);
    color: var(--text-secondary);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-full);
    white-space: nowrap;
  }
  .pill-dot {
    width: 5px;
    height: 5px;
    border-radius: var(--radius-full);
    background: var(--state-idle);
  }
  .pill-dot.live {
    background: var(--state-succeeded);
  }
  .head-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex: none;
  }
  .head-note {
    flex: none;
    margin: 0;
    padding: var(--space-2) var(--space-4);
    font-size: var(--text-xs);
    color: var(--text-secondary);
    background: var(--caution-100);
    border-bottom: 1px solid var(--border-hairline);
  }
  .confirm {
    flex: none;
    margin: 0;
    padding: var(--space-3) var(--space-4);
    background: var(--surface-card);
    border-bottom: 1px solid var(--border-subtle);
  }
  .confirm p {
    margin: 0 0 var(--space-2);
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }
  .confirm-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
  }
  .history {
    flex: none;
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--border-hairline);
    background: var(--surface-card);
  }
  .history ul {
    list-style: none;
    margin: var(--space-2) 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    max-height: 180px;
    overflow-y: auto;
  }
  .history li {
    display: flex;
    align-items: baseline;
    gap: var(--space-3);
  }
  .strong {
    color: var(--text-primary);
  }
  .tabs {
    flex: none;
    display: flex;
    align-items: stretch;
    gap: 2px;
    padding: 0 var(--space-3);
    border-bottom: 1px solid var(--border-hairline);
    background: var(--surface-card);
  }
  .tab {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1-5);
    height: 36px;
    padding: 0 var(--space-2-5);
    font-size: var(--text-xs);
    font-weight: var(--weight-medium);
    color: var(--text-secondary);
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    cursor: pointer;
  }
  .tab:hover {
    color: var(--text-primary);
  }
  .tab.on {
    color: var(--text-primary);
    border-bottom-color: var(--text-primary);
  }
  .tab:focus-visible {
    outline: none;
    box-shadow: var(--focus-ring);
  }
  .tab-count {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-tertiary);
  }
  .tab-dot {
    width: 4px;
    height: 4px;
    border-radius: var(--radius-full);
    background: var(--caution-500);
  }
  .body {
    flex: 1;
    min-height: 0;
    display: flex;
  }
  .pane-col {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
  .pad {
    padding: var(--space-6) var(--space-6) var(--space-24);
  }
  .form {
    max-width: 720px;
    display: flex;
    flex-direction: column;
    gap: var(--space-8);
  }
  section {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .section-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
  }
  .blurb {
    font-size: var(--text-xs);
    color: var(--text-secondary);
  }
  .chars {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-tertiary);
  }
  .micro {
    flex: none;
    white-space: nowrap; /* the section label never wraps; the blurb beside it does */
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: var(--tracking-micro);
    text-transform: uppercase;
    color: var(--text-tertiary);
  }
  .grid-2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-3);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1-5);
  }
  .field > span,
  .field-label {
    font-size: var(--text-xs);
    color: var(--text-secondary);
  }
  .field input {
    height: var(--control-h-md);
    padding: 0 var(--control-pad-x);
    font-size: var(--text-sm);
    color: var(--text-primary);
    background: var(--surface-card);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
  }
  .field input:focus-visible {
    outline: none;
    border-color: var(--border-focus);
    box-shadow: var(--focus-ring);
  }
  .table {
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg);
    overflow: hidden;
    background: var(--surface-card);
  }
  .table-head,
  .table-row {
    display: grid;
    grid-template-columns: 220px 1fr 32px;
    gap: var(--space-3);
    align-items: center;
    padding: 0 var(--space-3);
  }
  .table-head {
    height: 30px;
    background: var(--surface-inset);
    border-bottom: 1px solid var(--border-hairline);
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: var(--tracking-micro);
    text-transform: uppercase;
    color: var(--text-tertiary);
  }
  .table-row {
    min-height: 40px;
    padding-top: var(--space-1);
    padding-bottom: var(--space-1);
    border-bottom: 1px solid var(--border-hairline);
  }
  .table-row input {
    height: 28px;
    padding: 0 var(--space-2);
    font-size: var(--text-xs);
    color: var(--text-primary);
    background: var(--surface-card);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
  }
  .table-row input.mono {
    font-family: var(--font-mono);
  }
  .table-row input:focus-visible {
    outline: none;
    border-color: var(--border-focus);
    box-shadow: var(--focus-ring);
  }
  .row-issue {
    grid-column: 1 / -1;
    font-size: var(--text-2xs);
    color: var(--caution-600);
  }
  .table-foot {
    padding: var(--space-2) var(--space-3);
  }
  .dashed {
    height: 26px;
    padding: 0 var(--space-2);
    font-size: var(--text-xs);
    font-weight: var(--weight-medium);
    color: var(--action-ghost-fg);
    background: transparent;
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius-md);
    cursor: pointer;
  }
  .dashed:hover {
    color: var(--text-primary);
    background: var(--surface-hover);
  }
  .stats {
    flex: none;
    padding: var(--space-3) var(--space-5);
    border-top: 1px solid var(--border-hairline);
  }
  .stats ul {
    list-style: none;
    margin: var(--space-2) 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .stats li {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-2);
    font-size: var(--text-xs);
  }
  .ta-name {
    color: var(--text-secondary);
    font-weight: var(--weight-medium);
  }
  .ta-stat {
    color: var(--text-tertiary);
  }
  /* Sticky footer — shadow is allowed here because it genuinely floats over scrolled content. */
  .dirty-bar {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    padding: var(--space-2-5) var(--space-4);
    border-top: 1px solid var(--border-subtle);
    background: var(--surface-raised);
    box-shadow: var(--shadow-lg);
  }
  .dirty-bar.quiet {
    box-shadow: none;
    background: var(--surface-card);
  }
  .dirty-left,
  .dirty-right {
    display: flex;
    align-items: center;
    gap: var(--space-2-5);
    min-width: 0;
  }
  .dirty-right {
    flex: none;
  }
  .dirty-bar .dot {
    width: 6px;
    height: 6px;
    flex: none;
    border-radius: var(--radius-full);
    background: var(--caution-500);
  }
  .dirty-label {
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    white-space: nowrap;
  }
  .dirty-detail {
    font-size: var(--text-xs);
    color: var(--text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .caution {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    margin: 0;
    font-size: var(--text-xs);
    color: var(--text-secondary);
  }
  .caution code {
    font-family: var(--font-mono);
    color: var(--text-primary);
  }
  .pane-msg {
    padding: var(--space-6);
    font-size: var(--text-sm);
    color: var(--text-tertiary);
  }
  .stack {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-3);
  }
  .stack p {
    margin: 0;
  }
  .error {
    color: var(--critical-500);
  }
  .small {
    font-size: var(--text-xs);
  }
  .muted {
    color: var(--text-tertiary);
  }
  .link {
    font-size: var(--text-sm);
    color: var(--text-link);
  }
  .primary,
  .secondary,
  .ghost {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1-5);
    height: 28px;
    padding: 0 var(--control-pad-x);
    font-size: var(--text-xs);
    font-weight: var(--weight-medium);
    border-radius: var(--radius-md);
    cursor: pointer;
    text-decoration: none;
    white-space: nowrap;
    transition: var(--transition-control);
  }
  .primary {
    color: var(--action-primary-fg);
    background: var(--action-primary-bg);
    border: 1px solid transparent;
  }
  .primary:hover:not(:disabled) {
    background: var(--action-primary-bg-hover);
  }
  .secondary {
    color: var(--action-secondary-fg);
    background: var(--action-secondary-bg);
    border: 1px solid var(--border-strong);
  }
  .secondary:hover:not(:disabled) {
    background: var(--surface-hover);
  }
  .ghost {
    color: var(--action-ghost-fg);
    background: transparent;
    border: 1px solid transparent;
  }
  .ghost:hover:not(:disabled),
  .ghost.on {
    color: var(--text-primary);
    background: var(--surface-hover);
  }
  .primary:disabled,
  .secondary:disabled,
  .ghost:disabled {
    color: var(--text-disabled);
    background: var(--surface-inset);
    border-color: transparent;
    cursor: not-allowed;
  }
  .icon {
    width: 22px;
    height: 22px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: var(--text-base);
    line-height: 1;
    color: var(--text-tertiary);
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    cursor: pointer;
  }
  .icon:hover {
    color: var(--critical-500);
    background: var(--surface-hover);
  }
  .primary:focus-visible,
  .secondary:focus-visible,
  .ghost:focus-visible,
  .icon:focus-visible,
  .dashed:focus-visible {
    outline: none;
    box-shadow: var(--focus-ring);
  }
</style>
