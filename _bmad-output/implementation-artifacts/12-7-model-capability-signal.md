---
baseline_commit: 59ada4616c5c0e57e397424b8697d70b408e3fd7
---
# Story 12.7: Model capability signal (not a gate)

Status: review

<!-- SEVENTH + FINAL story of Epic 12. The loop is live (12.4), repair-resilient (12.5), and fully
     observable (12.6). 12.7 closes the epic with the one thing that keeps the platform honest about a
     WEAK model: a capability SIGNAL, not a gate. The whole Mortimer episode that opened this epic was a
     small local model (gpt-oss-20b) that couldn't reliably use its tools; the party-mode call was
     explicit — surface the reliability so the builder chooses with eyes open, but NEVER block a config
     they want to run. So 12.7 is: a maintained VERIFIED-MODELS reference (the models we've actually run
     the tool loop against) + a non-blocking note on the Tools tab when the chosen model isn't verified
     AND tools are attached. Pure web + a reference list — NO contract change, NO backend, NO gate. The
     smallest story in the epic, and the one that makes "agents you can trust with real access" honest
     about model limits. -->

## Story

As the builder,
I want turanga to tell me how reliable a model is at tool use when I attach tools to an agent,
so that I can choose with eyes open — without being blocked from a config I want to run.

## Acceptance Criteria

1. **Given** a **verified-models reference** — the models we've actually run the tool loop against — **when** it is maintained, **then** it records (evidence-based, not vibes) which models emit well-formed tool calls reliably, and is the single source for the signal below. It is a maintained checked-in reference (no new table/API), with a helper `isToolVerified(model)` and a human-readable label of the verified set. [Source: epics.md#Story-12.7 AC1]

2. **Given** the agent-definition **Tools** surface where tools are attached, **when** the chosen model is **not** on the verified reference **and** the agent has ≥1 attached tool, **then** a **non-blocking signal** is shown — plainly worded ("Limited tool-calling reliability — …; verified models: …"), never celebratory — and it **does not** disable attaching a tool, granting an operation, saving, activating, or running. `gpt-oss-20b` (and any other unverified model) shows the signal but **stays fully usable** (a signal, not a gate). When the model IS verified, or no tool is attached, no signal shows. [Source: epics.md#Story-12.7 AC2; the "signal not gate" decision]

3. **Given** the signal, **when** it renders, **then** it follows project UI conventions — a status **stated with a word** (never colour-only), sentence case, verb-first if it carries an action, and the model id(s) in **mono/tabular** type (`.mono-num`), keyboard-reachable, WCAG-AA contrast (NFR-6, UX-DR15/16). [Source: epics.md#Story-12.7 AC3; project-context.md UI conventions]

## Tasks / Subtasks

- [x] **Task 1: The verified-models reference + helper** (AC: #1)
  - [x] `apps/web/src/lib/toolModels.ts` (NEW) — `VERIFIED_TOOL_MODELS` (lowercase substrings: gpt-4o/gpt-4.1/gpt-5/claude-3-5/3-7/sonnet/opus/haiku/claude-4/gemini-1.5/gemini-2; **`gpt-oss` intentionally absent**), commented as an evidence-based maintained reference; `isToolVerified(model)` (case-insensitive substring match, null/empty → false, never throws); `VERIFIED_TOOL_MODELS_LABEL` ("gpt-4o, claude, gemini") for the copy. Small + pure.

- [x] **Task 2: The non-blocking signal on the Tools tab** (AC: #2, #3)
  - [x] `apps/web/src/lib/components/AgentToolsTab.svelte` — added an optional `model` prop; `showSignal = value.length > 0 && !isToolVerified(model)`; renders a non-blocking `role="note"` at the top of the tab: a caution dot **paired with the word** "Limited tool-calling reliability", the model id in `.mono-num`, sentence case, no exclamation — "…isn't on the verified list, so it may not call tools reliably. It stays usable. Verified models: gpt-4o, claude, gemini." **Nothing is disabled** (checkboxes/attach/grant untouched). Tokenized styles (`--state-killed` dot, `--text-secondary`/`--text-primary`), no raw hex.
  - [x] `apps/web/src/routes/(app)/agents/[id]/+page.svelte` — passes `{model}` to `<AgentToolsTab …>` (the page already holds `model` state — no new state).

- [x] **Task 3: Tests + verification** (AC: all)
  - [x] `apps/web/src/lib/toolModels.test.ts` (NEW) — `isToolVerified` true for gpt-4o / claude / gemini ids (case-insensitive), false for the gpt-oss-20b id + `null`/`undefined`/`""`; the label is non-empty. **4 tests.**
  - [x] **web** — `svelte-check` clean (0/0); the signal is guarded by the `showSignal` derived (tools attached + unverified); the `isToolVerified` logic is unit-tested.
  - [x] `pnpm -r build` · `pnpm lint` (0) · `svelte-check` (0) · full `pnpm -r test` green (web 26, contracts 18, harness 22, control-api 257, guard 36, domain 5).
  - [x] **NO contract change, NO backend change** — `git status` shows **only** web files (`toolModels.ts`/`.test.ts`, `AgentToolsTab.svelte`, `agents/[id]/+page.svelte`). No `CONTRACT_VERSION` bump.
  - [x] Bookkeeping: boxes checked, Dev Agent Record / File List / Change Log filled, Status → review.

## Dev Notes

**A signal, not a gate — this is the whole point.** The epic's opening bug was a weak local model (`gpt-oss-20b`) that flailed at tools. The party-mode decision (PM + Architect) was explicit: **surface the reliability, never forbid the config.** turanga's ethos is "agents you can trust with real access" — trust includes being honest when a model may be *unreliable*, without paternalistically blocking the builder. So 12.7 shows a plain note and disables **nothing**. A verified model shows no note; an unverified model + attached tools shows the note and is **still fully usable** — attach, grant, save, activate, run all work exactly as before.

### Why the Tools tab, keyed on attached tools
Tool-calling reliability only matters when the agent actually has tools. So the trigger is `attachedTools.length > 0 && !isToolVerified(model)` — placed on the **Tools tab** (`AgentToolsTab`), where the builder is granting operations and the note is most contextual ("you're wiring up tools; heads up, this model may not call them reliably"). A no-tools agent, or a verified model, shows nothing.

### The verified reference is a maintained, evidence-based list — start honest
`VERIFIED_TOOL_MODELS` is the models we've **run the tool loop against** and seen emit well-formed calls — frontier, natively tool-trained models (gpt-4o / claude / gemini families). It is deliberately a small **checked-in reference** (no table, no API, no migration) that we tune as we verify more models. **`gpt-oss-20b` is intentionally NOT on it yet** — it is tool-*trained* (so it's not blocked, per AC2) but not yet tool-*verified* live (the Mortimer e2e is still pending). That is exactly the intended signal: "this model may be unreliable; here's what we've verified." When the Mortimer demo proves gpt-oss reliable, it can be added — a one-line reference edit. Match by **substring** because model ids carry a provider prefix (`openai/gpt-4o`, `openai-compatible//models/gpt-oss-20b-…`).

### UI conventions (project-context NFR-6 / UX-DR15/16)
- Status **stated with a word** — lead with "Limited" (or similar); a coloured dot always pairs with the word, **never colour-only** (UX-DR15). Use `--state-*`/`--text-secondary` tokens, no raw hex.
- Sentence case, no exclamation, no emoji; the model state is **stated, not celebrated** (UX-DR16). Model id in `.mono-num` (mono + tabular).
- Keyboard-reachable + visible focus if it carries any control; WCAG-AA contrast. It's a static note (no control needed), so mainly: legible, tokenized, worded.

### Architecture (binding)
- **No plane crossed** — this is a pure control-plane **UI** affordance reading agent-definition state the page already has (`model`, `attachedTools`). No sandbox, no Guard, no contract, no run-path change (AD-1/7/9/10 untouched — nothing new reaches a run).
- It is **advisory only** — it never feeds enforcement. The Guard still brokers whatever the (possibly unreliable) model calls; the cost cap + step ceiling still bound the loop. The signal changes **zero** runtime behavior.

### Existing patterns / source (file:line)
- **The Tools tab:** `apps/web/src/lib/components/AgentToolsTab.svelte` — props (`:22`), the `connected`/`grantsById` deriveds (`:31-32`), the group list (where the note goes above). Uses `@lucide/svelte` icons + Warm Ink tokens + `.mono-num`.
- **The mount + model state:** `apps/web/src/routes/(app)/agents/[id]/+page.svelte` — `model` state (`:65`, set `:98`), `attachedTools` (`:69`), the `<AgentToolsTab …/>` mount (`:597`).
- **Status-with-a-word precedent:** `RunTranscript.svelte` tool/refusal rows (dot + word), the run-status dot pattern; `ModelSelector.svelte` for how model ids render.
- **Model id shape:** e.g. `openai/gpt-4o`, `openai-compatible//models/gpt-oss-20b-MXFP4.gguf` (Mortimer). Prior stories: `12-1`…`12-6`; [[epic-12-tool-loop]].

### Project Structure Notes
- **New:** `apps/web/src/lib/toolModels.ts` (+ `toolModels.test.ts`).
- **Edited:** `apps/web/src/lib/components/AgentToolsTab.svelte` (the `model` prop + the note), `apps/web/src/routes/(app)/agents/[id]/+page.svelte` (pass `model`).
- **No change:** contracts, control-api, egress-guard, agent-harness (this is web-only). NO `CONTRACT_VERSION` bump.
- **Scope guard:** NO gate/disable of any control, NO backend/API for the list (checked-in reference only), NO contract change, NO run-path/enforcement wiring. This story is: a verified-models reference + a non-blocking Tools-tab note + tests.

### Testing standards
- Vitest, co-located; `svelte-check` for web. Unit-test the pure `isToolVerified` (verified true / gpt-oss false / null-empty / case-insensitive). Confirm the note is purely advisory (nothing disabled) by inspection + `svelte-check`. Full verification: `pnpm -r build`, `pnpm lint`, `svelte-check`, `pnpm -r test`. No e2e needed (a UI note; the loop's live proof is the 12.4 Mortimer demo).

### References
- [Source: epics.md#Epic-12 + #Story-12.7 (capability signal not a gate; verified-models list; gpt-oss stays usable) + #Architecture-and-scope-decisions (capability is a signal, not a gate)]
- [Source: project-context.md (NFR-6 semantic tokens + mono numerals; UX-DR15 status never colour-only; UX-DR16 stated-not-celebrated voice)]
- [Source: AgentToolsTab.svelte (the Tools tab) + agents/[id]/+page.svelte (model + attachedTools state, the mount) ; the epic's party-mode "signal vs gate" decision]
- [Source: 12-1…12-6 story files ; [[epic-12-tool-loop]]]

## Dev Agent Record

### Agent Model Used

claude-opus-4-8 (Claude Opus 4.8)

### Debug Log References

- **Substring matching over exact ids.** Model ids carry a provider prefix (`openai/gpt-4o`, `openai-compatible//models/gpt-oss-20b-MXFP4.gguf`), so `isToolVerified` lowercases + does a substring match against the reference patterns. This is robust to the prefix and to version suffixes (`claude-3-5-sonnet-20241022` matches `claude-3-5`).
- **The signal is keyed on `value.length` (attached tools), not the raw tool registry.** Tool-calling reliability only matters once the agent actually has tools attached — so a no-tools agent (even on a weak model) shows nothing, and the note appears exactly when the builder is wiring up tools on an unverified model.
- **`gpt-oss` deliberately excluded from the verified reference.** It is tool-*trained* (so AC2 says never blocked) but not tool-*verified* live yet — the Mortimer acceptance demo is still pending. Excluding it makes the signal honest: Mortimer's config shows "limited reliability … stays usable," which is exactly the intended behavior. Adding it later is a one-line reference edit once the e2e proves it.

### Completion Notes List

- **The epic closes honestly.** A maintained, evidence-based verified-models reference (`toolModels.ts`) drives a **non-blocking** note on the Tools tab when the chosen model isn't verified and tools are attached. `gpt-oss-20b` (the model that opened the epic) shows the note but **stays fully usable** — attach, grant, save, activate, run all work; **nothing is disabled**. A signal, not a gate.
- **Web-only, zero blast radius:** no contract change, no backend, no `CONTRACT_VERSION` bump, no run-path/enforcement wiring (AD-1/7/9/10 untouched — the signal is advisory UI reading agent-definition state the page already holds). The Guard still brokers whatever the model calls; the cost cap + step ceiling still bound the loop.
- **UI per conventions (NFR-6/UX-DR15/16):** status stated with a word ("Limited"), a caution dot paired with the word (never colour-only), model id in `.mono-num`, sentence case, no exclamation, tokenized (no raw hex).
- **Verification:** web 26 (+4 toolModels), full `pnpm -r test` green (contracts 18, harness 22, control-api 257, guard 36, domain 5); `pnpm -r build` + `pnpm lint` + `svelte-check` clean. Confirmed web-only (git status shows only web files). No e2e needed — a UI note; the loop's live proof is the 12.4 Mortimer demo.

### File List

**New — web**
- `apps/web/src/lib/toolModels.ts` — `VERIFIED_TOOL_MODELS` + `isToolVerified` + `VERIFIED_TOOL_MODELS_LABEL`
- `apps/web/src/lib/toolModels.test.ts` — the reference/helper tests

**Edited — web**
- `apps/web/src/lib/components/AgentToolsTab.svelte` — `model` prop + the non-blocking capability note
- `apps/web/src/routes/(app)/agents/[id]/+page.svelte` — pass `{model}` to the Tools tab

### Change Log

| Date | Version | Description |
|------|---------|-------------|
| 2026-08-06 | 0.1 | Story 12.7 drafted. |
| 2026-08-07 | 0.2 | Story 12.7 implemented — the epic's final story. A maintained checked-in verified-models reference (`toolModels.ts` + `isToolVerified`, `gpt-oss` intentionally absent) drives a non-blocking note on the Tools tab when the chosen model isn't verified AND tools are attached ("limited tool-calling reliability … verified models: gpt-4o, claude, gemini"). gpt-oss-20b shows the signal but stays fully usable; nothing is disabled — a signal, not a gate. Web-only: no contract/backend change, no CONTRACT_VERSION bump. UI per NFR-6/UX-DR15/16. Verified: web 26 (+4) / full pnpm -r test + build + lint + svelte-check green; confirmed web-only. Status → review. |
