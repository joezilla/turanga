---
baseline_commit: efa9442e680ad541aa5c328a2e51615746ba62a3
---
# Story 3.3: Instructions editor with variables

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As the builder,
I want to write instructions with variables,
so that my agent has reusable, parameterized guidance.

## Acceptance Criteria

1. **Given** the Instructions section, **when** editing, **then** it is a **mono** editor; typing `{` opens a **variable-insert popover** and inserted `{vars}` render as **signal-tinted variable-tokens**. Edits **autosave** (`Saving… → Saved`), written by `control-api` only (AD-7). [Source: epics.md#Story-3.3 FR-1; DESIGN.md#components.variable-token, #Typography (mono zones); EXPERIENCE.md#Component-Patterns; ARCHITECTURE-SPINE.md AD-7]
2. **Given** an undefined `{var}` referenced in text, **when** detected, **then** a **caution hint** surfaces (inline, `caution-500`, dot + word — never colour-only, no banner) **linking to the Variables section** (an advisory validation warning; it does not block Test). [Source: epics.md#Story-3.3; EXPERIENCE.md#State-Patterns (Error: cause→consequence→recovery), #Accessibility (status never colour-only)]

## Tasks / Subtasks

- [x] **Task 1: Persist instructions + variables** (AC: #1, #2)
  - [x] `apps/control-api/src/db/schema.ts` — add to `agents`: `instructions text not null default ''` and `variables jsonb ... $type<AgentVariable[]>().notNull().default([])` (mirror the existing `jsonb().$type<string[]>()` pattern used by `connections.models`). `drizzle-kit generate` → migration **`0005`**. Preserve columns + migrations `0000`–`0004`. [Source: db/schema.ts existing jsonb usage; ARCHITECTURE-SPINE.md AD-7]
  - [x] `packages/domain/src/index.ts` — add `export interface AgentVariable { name: string; value: string }` and `variables?: AgentVariable[]` to `Agent` (`instructions: string` already exists). [Source: domain Agent]
  - [x] `apps/control-api/src/agents/repo.ts` — extend `AgentRow` (`instructions: string; variables: AgentVariable[]`) and `AgentPatch` (`instructions?: string; variables?: AgentVariable[]`); thread through `toRow`, `applyPatch`, Drizzle `create` (defaults `instructions: ""`, `variables: []`) + `update` (`set.instructions`, `set.variables`), and the memory repo. Re-export/define `AgentVariable`.

- [x] **Task 2: Instructions + variables autosave routes (control-api)** (AC: #1, #2)
  - [x] Extend `PATCH /agents/:id` (mirror the name/model validation pattern):
    - `instructions`: if present, must be a string; **allow empty** (unlike name); cap at `MAX_INSTRUCTIONS_LEN` (20000).
    - `variables`: if present, must be an array; each item `{ name, value }` where **name** matches `^[a-zA-Z][a-zA-Z0-9_]{0,63}$` and is **unique** (case-sensitive) across the array, **value** is a string capped at `MAX_VAR_VALUE_LEN` (2000); cap the array at `MAX_VARIABLES` (50). Reject any violation with **400** + a stated reason. Unknown keys stay ignored.
  - [x] `POST /agents` create sets `instructions: ""`, `variables: []`. `GET /agents/:id` returns them. **Preserve** name/model behavior + the whole Epic 1/2/3.1/3.2 surface. No `app.ts`/`server.ts` change.

- [x] **Task 3: Web client** (AC: #1, #2)
  - [x] `apps/web/src/lib/agents.ts` — add `AgentVariable` + `instructions: string`/`variables: AgentVariable[]` to the `Agent` type and `instructions?`/`variables?` to `AgentPatch`. (Keep `getAgent`/`updateAgent`/`Result` + the `Array.isArray` list guard.)

- [x] **Task 4: Instructions editor component** (AC: #1, #2)
  - [x] New **`apps/web/src/lib/components/InstructionsEditor.svelte`** — a **mono** editor that renders `{vars}` as tokens:
    - **Overlay-highlighter technique:** a transparent `<textarea>` (real editing/caret, `color: transparent; caret-color: var(--text-primary)`, `font-family: var(--font-mono)`, 13px/20px) over an `aria-hidden` mirror `<div>` with identical metrics/padding that renders the text with each `{name}` wrapped in a **variable-token** span (`background: var(--signal-100)`, `color: var(--text-primary)`, `border-radius: var(--radius-sm)`, mono) and plain text elsewhere. Keep the two scroll-synced. (This is the faithful way to show inline tokens while keeping a real textarea — document it.)
    - **Variable-insert popover:** typing `{` (a single `{`, not `{{`) opens a popover (`--shadow-md`) listing the agent's **defined variable names**; selecting one inserts `{name}` at the caret (completing the `{`); `Esc` closes it; keyboard-navigable. **Simplification to document:** the popover is anchored to the editor (below it), not to the caret position (caret-anchoring is later polish). If there are no variables yet, the popover shows a "No variables yet — add one in Variables" hint linking to the Variables section.
    - **Props:** `value: string`, `variableNames: string[]`, `oninput: (v: string) => void`. Emits on every keystroke (the page debounces the save).
  - [x] Parse helper (co-located or in `$lib`): extract `{name}` tokens via `/\{([a-zA-Z][a-zA-Z0-9_]{0,63})\}/g`; expose the referenced names so the page can compute undefined ones. Unit-test the parser.

- [x] **Task 5: Instructions + Variables sections on the definition surface** (AC: #1, #2)
  - [x] In `apps/web/src/routes/(app)/agents/[id]/+page.svelte`, add (after the Model `<Section>`, mirroring the 3.2 autosave wiring):
    - **`<Section label="Instructions">`** — the `InstructionsEditor` bound to `agent.instructions`, debounced ~400ms → `persist({ instructions })` (mirror `onNameInput`, but **allow empty** — do not skip blank). Below it, the **undefined-variable caution hint**: compute `referenced − defined`; if non-empty, show an inline caution (a `caution-500` dot + the word "caution" + "N undefined variable(s): `{a}`, `{b}` — define them in Variables") whose link focuses/opens the Variables section. Never a banner; never colour-only.
    - **`<Section label="Variables">`** — add/edit/remove named variables: a row per variable (name input + value input + Remove), and an **Add variable** action. Names are validated client-side to the same pattern; a structural change (add/remove) saves immediately, a value edit debounces ~400ms → `persist({ variables })`. Persistent labels (not placeholder-only). (Skills — section 3 — is Story 3.4 and slots between Instructions and Variables later; do NOT build it here.)
  - [x] The variable-insert popover's list and the caution-hint's "defined" set both come from `agent.variables`. Keep the config pane single-column < 1024px (already handled by 3.2's layout).

- [x] **Task 6: Tests + verification** (AC: all)
  - [x] **Unit (control-api, Vitest, in-memory repo + real session):** create → `instructions: ""`, `variables: []`; `GET /agents/:id` returns them; PATCH `instructions` persists (incl. empty string) + caps at 20000; PATCH `variables` persists a valid array, **rejects** a bad name / duplicate name / over-cap array / non-string value with **400**; **401** without a session. Assert control-api is the only writer (AD-7).
  - [x] **Unit (web, Vitest):** the token parser extracts referenced names, ignores malformed `{ }`, and (with a defined set) yields the correct undefined set.
  - [x] **Playwright e2e (live stack, serial — append to `tests/agents.spec.ts` for guaranteed ordering):** open an agent → Instructions section; type text containing `{portfolio}` → a **variable-token** renders for it **and** an undefined-variable **caution hint** appears; add a variable named `portfolio` in the Variables section → the caution hint **clears**; typing `{` opens the **variable-insert popover** (now listing `portfolio`); the indicator shows `Saving… → Saved` and the instructions + variable **persist across reload**.
  - [x] `svelte-check` 0 · `pnpm -r build` · `pnpm lint` · control-api + web unit · e2e incl. **Epic 1/2/3.1/3.2 regressions** all green.

### Review Findings (joint 3.2 + 3.3 code review, 2026-08-01)

_Blind Hunter + Edge Case Hunter + Acceptance Auditor over `6770576..HEAD`. 1 high, 5 med, 3 low → patch; 5 deferred. XSS in the editor mirror was checked and is NOT present (Svelte text interpolation escapes). No noise dismissed._

- [x] [Review][Patch][High] `parseVariables` 500s (not 400) on a null/non-object array item — `PATCH /agents/:id` with `{"variables":[null]}` passes `Array.isArray`, then `v.name` dereferences null → uncaught TypeError → 500. Guard `item === null || typeof item !== "object"` before dereferencing. [apps/control-api/src/agents/routes.ts]
- [x] [Review][Patch][Med] Autosave has no in-flight/ordering guard (Task 6 "coalesce in-flight saves") — overlapping PATCHes (immediate model + debounced name/instructions/vars) can resolve out of order; a stale response overwrites `agent` (model/state flip back) and the shared `save` indicator races. Add a monotonic request seq; ignore responses older than the latest issued. [apps/web/src/routes/(app)/agents/[id]/+page.svelte persist()]
- [x] [Review][Patch][Med] `load()` has no id-guard — navigating `/agents/A`→`/agents/B` fast (the `[id]` page re-runs `$effect` without unmount) can let `load(A)` resolve after `load(B)`, seeding A's name/instructions/vars while the route is B; a subsequent edit saves A's data onto B. Capture `id` at call start; bail if `page.params.id` changed before applying. [apps/web/.../[id]/+page.svelte load()]
- [x] [Review][Patch][Med] Variable-insert popover is mouse-only, not keyboard-navigable (3.3 AC1) — the textarea's `onblur` closes the popover before Tab can reach an option; no arrow/Enter handling; `role="listbox"` with `<button role="option">` is malformed ARIA. Keep it open while focus is within it, add arrow+Enter selection, fix the ARIA. [apps/web/src/lib/components/InstructionsEditor.svelte]
- [x] [Review][Patch][Med] Popover correctness bugs — (a) the empty-state "add one in Variables" `<a>` lacks `onmousedown preventDefault`, so the blur unmounts it before the click lands (dead link); (b) `insertVariable` inserts `name}` blindly at the caret even if the caret moved off the `{` (stray `}`); (c) typing `{{` leaves the popover open. [InstructionsEditor.svelte]
- [x] [Review][Patch][Med] Silent truncation → data loss on reload — server caps instructions at 20000, variable value at 2000, name at 200, returns the truncated agent, but the local editor state isn't reconciled; over-cap content shows locally, is stored truncated, and vanishes on reload. Apply matching client-side `maxlength` (or reconcile from the response) so local == persisted. [apps/web/.../[id]/+page.svelte + InstructionsEditor.svelte]
- [x] [Review][Patch][Low] Editor mirror/textarea desync when the textarea shows a scrollbar or is user-resized — the textarea's wrap width shrinks by the scrollbar; the `overflow:hidden` mirror keeps full width, so tokens/caret drift. Add `scrollbar-gutter: stable` to both boxes (or `resize:none`). [InstructionsEditor.svelte]
- [x] [Review][Patch][Low] `removeVariable` doesn't clear the pending value-edit debounce (`varsTimer`) — a prior debounced `persistVars` fires ~400ms later, issuing a duplicate `{variables}` PATCH. Clear the timer on remove. [apps/web/.../[id]/+page.svelte]
- [x] [Review][Patch][Low] Blank/duplicate variable name silently drops the row's value with a misleading "Saved" — `validVars()` sends only well-formed unique rows; an unnamed/duplicate row looks saved but is discarded on reload. Add a per-row cue (e.g. "name required" / "duplicate") so the unsaved state is visible. [apps/web/.../[id]/+page.svelte]
- [x] [Review][Defer][Low] Autosave indicator never returns to idle, is one shared field for all edits, and `aria-live="polite"` re-announces on every debounced keystroke — deferred (cosmetic/polish; distinct per-field status + idle-fade is a nicer-to-have).
- [x] [Review][Defer][Low] Save-failure "retry" is inert copy, not a button — deferred; the next keystroke re-saves, so there is a recovery path (a real Retry affordance is polish).
- [x] [Review][Defer][Low] Domain vs repo/web nullability divergence (`model?`/`variables?` optional in domain vs `string|null`/required in repo+web) — deferred, type-hygiene only; no runtime bridge exists yet.
- [x] [Review][Defer][Low] ModelSelector cosmetics — `orphanValue.replace("/", " / ")` splits only the first slash; unknown provider kinds are dropped; two same-kind connections merge ambiguously — deferred (only the 3 known kinds exist today; multi-slash model ids are uncommon).
- [x] [Review][Defer][Low] Login limiter keys on client-controllable `x-forwarded-for` (surfaced by the test's per-session IP) — deferred, pre-existing (not this diff); add to deferred-work for an auth-hardening pass.

## Dev Notes

**Third Epic 3 story — the Instructions editor + Variables. Build: instructions/variables persistence, the mono `InstructionsEditor` (token highlighting + `{`-popover + undefined-var caution hint), and the Variables section. Do NOT build: Skills (3.4), Cost caps (3.5), Activate (5.1), or any Test-run/streaming behavior (Epic 4). No new external tech — the editor is hand-rolled (textarea + overlay highlighter); Drizzle migration + guarded Hono PATCH + SvelteKit, all established in 3.1–3.2.**

### Architecture / constraints
- **AD-7 single-writer:** `control-api` is the **sole writer** — the editor autosaves via `PATCH /agents/:id` (never writes the DB). Mirror the 3.2 server-authoritative `persist()`. [ARCHITECTURE-SPINE.md AD-7]
- **AD-8 lifecycle:** the agent stays **Draft**; instructions/variables are **not** part of the Activate gate (model + both caps only — Story 5.1). [ARCHITECTURE-SPINE.md AD-8]
- **AD-9 job spec (deferred consumer):** instructions already exist in `JobSpecSchema`; **variables are a new definition field that must be snapshotted into the immutable job spec at run start** — but the orchestrator/harness that assemble the job spec are **Epic 4**, so **do NOT change `packages/contracts` or bump `CONTRACT_VERSION` in 3.3** (there is no consumer yet). Leave a note: Epic 4 threads `variables` (and instruction/variable resolution) into the job spec. [ARCHITECTURE-SPINE.md AD-9; packages/contracts JobSpecSchema]
- **Conventions:** UTC timestamps, semantic Warm Ink tokens only, **mandatory mono** for the editor + `{variable}` names, status never colour-only (dot + word), verb-first sentence-case copy, visible focus ring, no motion beyond the run pulse (the token/popover must not animate). [ARCHITECTURE-SPINE.md#Conventions; DESIGN.md#Typography, #Motion]

### UX specifics (DESIGN.md / EXPERIENCE.md — Warm Ink baseline wins on conflict)
- **Instructions editor:** "a **mono text area**. Typing `{` opens a variable-insert popover; inserted `{vars}` render as `{components.variable-token}`. An undefined `{var}` referenced in text surfaces a **caution hint linking to the Variables section**." Editor mono = IBM Plex Mono 13px/20px (`--font-mono`, mono ≥ 12px floor). [EXPERIENCE.md#Component-Patterns; DESIGN.md#Typography]
- **variable-token:** `fontFamily: IBM Plex Mono`, `background: --signal-100`, `foreground: --text-primary`, `radius: --radius-sm`; **rectangular (4px), never a pill** (pill is reserved for the live agent-status chip). "Signal-tinted because it is a live binding the system resolves." [DESIGN.md#components.variable-token, #Shapes]
- **Popover elevation:** `--shadow-md` is the builder-popover convention (skill picker / model dropdown); `Esc` closes popovers. [DESIGN.md#Elevation; EXPERIENCE.md#Interaction-Primitives]
- **Caution hint:** caution hue is `--caution-500`. Render like the Error pattern — **inline, cause→consequence→recovery, a dot + text, never a full banner**; sentence case, no exclamation/emoji. [DESIGN.md (caution-500); EXPERIENCE.md#State-Patterns, #Voice]
- **Autosave / sections:** `Saving… → Saved` in `--text-tertiary` micro-cap; collapsible sections with 11px tracked micro-cap labels; no manual Save. Canonical order Model → Instructions → Skills → Variables → Cost caps → Allowlist (3.3 renders Model, **Instructions**, **Variables**; Skills slots in at 3.4). [EXPERIENCE.md#Component-Patterns, #State-Patterns; DESIGN.md#components.agent-editor-pane]
- **Spec gaps (do not over-invent):** the popover's exact item template / caret-anchoring and the Variables section internals are **not** specified — implement the minimal faithful version (list of defined variables; name+value rows) and document the choices. The undefined-var hint is **advisory** (no hard Test block). [UX digest]

### Files being modified (READ current state — preserve behavior)
- **`apps/control-api/src/db/schema.ts` (UPDATE):** add `instructions` + `variables` to `agents`. Preserve columns + migrations `0000`–`0004` (new `0005`).
- **`packages/domain/src/index.ts` (UPDATE):** add `AgentVariable` + `Agent.variables?`. `instructions` already present.
- **`apps/control-api/src/agents/repo.ts` (UPDATE):** `AgentRow`/`AgentPatch` gain instructions+variables; thread `toRow`/`applyPatch`/`create`/`update` (Drizzle + memory).
- **`apps/control-api/src/agents/routes.ts` (UPDATE):** PATCH validates instructions (allow empty, cap) + variables (name pattern/unique, value cap, array cap); create defaults. Keep name/model + the 3.1 `null`-body/name-cap hardening.
- **`apps/web/src/lib/agents.ts` (UPDATE):** `Agent`/`AgentPatch` gain instructions+variables.
- **`apps/web/src/routes/(app)/agents/[id]/+page.svelte` (UPDATE):** add Instructions + Variables sections + their autosave; keep Model section, header name/model autosave, StatusDot, responsive split, notFound/error/Retry.
- **`apps/web/tests/agents.spec.ts` (UPDATE):** append the 3.3 e2e (one file → guaranteed serial ordering; the 3.1 empty-state must stay first).
- **NEW:** `apps/web/src/lib/components/InstructionsEditor.svelte`, a token-parser module + its test, `apps/control-api/drizzle/0005_*.sql`.

### Previous-story intelligence (Epics 1–3.2)
- **Autosave pattern (3.2) to mirror** — `persist(patch)` sets `save="saving"` → `updateAgent` → on ok `agent = r.value; save="saved"` else `"error"`; text debounced ~400ms, discrete changes immediate. `Section` API: `<Section label="…">children</Section>` (`open` bindable, default true). `getAgent`/`updateAgent` are server-authoritative (return the server's agent). [3-2]
- **Repo/route pattern** — factory routes over an injected repo (interface + Drizzle + memory); PATCH validates each field, `undefined` = not sent, unknown keys ignored, cap lengths; tests use `app.request` with a real login session. Last migration `0004` → this adds `0005`. [3-1, 3-2]
- **E2E** — serial (`workers:1`); ALL agent e2e live in `tests/agents.spec.ts` so the fresh-DB empty-state assertion runs first; rows are `a.agent` links. Model-happy-path needs a real key (unit-tested), but instructions/variables need **no** provider, so the 3.3 flow is fully e2e-able. [3-2]
- **Known deferrals (do not reopen):** same-ms ordering, `state` CHECK constraint, vacuous single-writer test (`deferred-work.md`); native-select model deviation (3.2).

### Testing standards
- **Unit (control-api):** create defaults; GET returns instructions/variables; PATCH instructions (empty + cap); PATCH variables valid + 400 on bad-name/dup/over-cap/non-string-value; guard 401. In-memory repo, no live DB.
- **Unit (web):** token parser (referenced names, malformed ignored, undefined-set computation).
- **E2E (Playwright, live stack, serial):** type `{portfolio}` → token + caution; define `portfolio` → caution clears; `{` opens popover; autosave → persists across reload.
- `svelte-check` 0, build 6/6, lint clean, Epic 1/2/3.1/3.2 regressions green.
- **DoD:** mono editor renders `{var}` tokens; `{`-popover inserts variables; undefined `{var}` → caution hint linking to Variables (advisory); Variables section defines/edits/removes; instructions+variables persist via control-api only (AD-7); agent stays Draft; regressions intact; only permitted sections modified. NO skills/caps/activate/test-run behavior; NO contract/version change (Epic 4).

### Project Structure Notes
- New (control-api): migration `0005`. New (web): `InstructionsEditor.svelte`, a token-parser module + test. Modified: control-api `schema.ts`/`repo.ts`/`routes.ts`/`agents.test.ts`, domain `index.ts`, web `agents.ts`/`agents/[id]/+page.svelte`/`tests/agents.spec.ts`. No other apps/packages touched. Contracts intentionally untouched (Epic 4). [ARCHITECTURE-SPINE.md#Structural-Seed, AD-7, AD-9]

### References
- [Source: _bmad-output/planning-artifacts/epics.md#Epic-3 / Story-3.3; FR-1]
- [Source: ARCHITECTURE-SPINE.md AD-7, AD-8, AD-9, #Conventions]
- [Source: ux-designs/ux-turanga-2026-07-30/DESIGN.md#components.variable-token/#agent-editor-pane, #Typography, #Elevation, #Shapes, #Motion]
- [Source: ux-designs/ux-turanga-2026-07-30/EXPERIENCE.md#Component-Patterns, #State-Patterns, #Interaction-Primitives, #Accessibility, #Voice, Key-Flow-1]
- [Source: packages/domain (Agent.instructions), packages/contracts (JobSpecSchema.instructions)]
- [Source: _bmad-output/implementation-artifacts/3-2-agent-definition-model.md + 3-1-create-agent.md (repo/route/guard/autosave/Section patterns); deferred-work.md]

## Dev Agent Record

### Agent Model Used
claude-opus-4-8[1m]

### Debug Log References
- **Login rate-limiter tripped the unit suite (the real, useful find).** Adding 6 more `appWithSession` helpers pushed control-api tests past ~20 logins; the login brute-force limiter (`apps/control-api/src/auth/routes.ts`, keyed on `x-forwarded-for` → shared `"local"` bucket) then returned **429**, so those sessions had no cookie and `POST /agents` 401'd (surfacing as `created` = undefined). Fixed test-side by giving each `appWithSession` a distinct `x-forwarded-for` (real clients have distinct IPs). No production change.
- svelte-check flagged `internal = $state(value)` capturing the prop's initial value — that's intentional (seed, then sync via `$effect`); marked `// svelte-ignore state_referenced_locally`.
- Web had no unit runner (`test` was svelte-check). Added a plain `vitest.config.ts` (no SvelteKit plugin, node env) + `vitest` devDep so the pure-TS variable parser runs under `pnpm -r test`; `check` still runs svelte-check.

### Completion Notes List
- **Task 1** — `instructions text not null default ''` + `variables jsonb $type<AgentVariable[]> not null default []` on `agents`; migration `0005`. Domain gains `AgentVariable` + `Agent.variables?`. `AgentRow`/`AgentPatch` + `toRow`/`applyPatch`/`create`/`update` (Drizzle + memory) thread both fields.
- **Task 2** — `PATCH /agents/:id` validates `instructions` (string, empty allowed, cap 20000) and `variables` (array; each `{name,value}` with name `^[a-zA-Z][a-zA-Z0-9_]{0,63}$`, unique, value string cap 2000; array cap 50) → 400 on any violation. `POST` defaults `instructions:""`, `variables:[]`.
- **Task 3** — web `Agent`/`AgentPatch` gain `instructions` + `variables` (+ `AgentVariable`).
- **Task 4** — `InstructionsEditor.svelte`: overlay-highlighter (transparent mono textarea over an aria-hidden mirror that draws `{name}` as signal-tinted tokens, scroll-synced); `{`-popover (`--shadow-md`) listing defined variables, inserts `{name}` at the caret, Esc closes, empty-state links to Variables. `$lib/variables.ts` token parser (`referencedVariables`/`undefinedVariables`) + 6 unit tests.
- **Task 5** — Instructions + Variables `<Section>`s on the definition surface. Instructions autosaves debounced (empty allowed); an inline `caution-500` dot+word hint lists undefined `{vars}` and links to `#variables-section`. Variables section adds/edits/removes name+value rows; structural changes save immediately, value edits debounce; only well-formed unique-named rows are persisted (incomplete rows stay editable).
- **Task 6** — control-api unit +8 (create defaults; instructions persist/empty/cap + non-string 400; variables persist/durable + bad-name/dup/over-cap/non-string-value/non-array 400 + value cap; 401) → **46/46**. Web unit +6 (parser). E2E +1: token renders, caution appears→clears on define, `{`-popover lists the variable, autosave persists instructions + variable across reload → **12/12**.
- **Verification** — `pnpm -r build` 6/6, `pnpm -r test` all green (control-api 46, web 6, domain/contracts/harness), `pnpm lint` clean, `svelte-check` 0, live-stack Playwright 12/12 against a fresh docker stack (`down -v` → rebuild control-api (migration 0005) → healthy → e2e → `down -v`).

**Documented deviations / decisions:** (1) tokens are rendered via the overlay-highlighter technique (a textarea can't style substrings) — faithful to "mono text area … `{vars}` render as tokens". (2) The `{`-popover is anchored to the editor, not the caret (caret-anchoring is later polish). (3) The undefined-variable hint is advisory (does not block Test), per the UX spine. (4) `packages/contracts`/`CONTRACT_VERSION` intentionally NOT changed — variables snapshot into the job spec at run start, which is Epic 4 (no consumer yet); flagged as an AD-9 follow-up.

### File List
- NEW `apps/control-api/drizzle/0005_fast_stephen_strange.sql` (+ `drizzle/meta`)
- NEW `apps/web/src/lib/variables.ts`
- NEW `apps/web/src/lib/variables.test.ts`
- NEW `apps/web/src/lib/components/InstructionsEditor.svelte`
- NEW `apps/web/vitest.config.ts`
- MOD `packages/domain/src/index.ts` (AgentVariable, Agent.variables)
- MOD `apps/control-api/src/db/schema.ts` (instructions, variables)
- MOD `apps/control-api/src/agents/repo.ts` (fields + update threading)
- MOD `apps/control-api/src/agents/routes.ts` (instructions/variables validation + create defaults)
- MOD `apps/control-api/src/agents/agents.test.ts` (+8 tests; distinct-IP login helper)
- MOD `apps/web/src/lib/agents.ts` (instructions/variables on Agent + AgentPatch)
- MOD `apps/web/src/routes/(app)/agents/[id]/+page.svelte` (Instructions + Variables sections + autosave)
- MOD `apps/web/package.json` (test → vitest; vitest devDep)
- MOD `apps/web/tests/agents.spec.ts` (+ instructions/variables e2e)

### Change Log
- 2026-08-01 — Story 3.3 implemented: mono instructions editor with `{variable}` tokens + insert popover, Variables section, undefined-variable caution hint, instructions/variables persistence + autosave via control-api (AD-7). Status → review.
