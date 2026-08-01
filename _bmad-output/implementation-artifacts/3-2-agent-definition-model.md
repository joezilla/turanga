---
baseline_commit: 6770576e22496fb2b7c16415d6a948deb198ff63
---
# Story 3.2: Agent-definition surface and model selection

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As the builder,
I want the two-pane builder with model selection,
so that I can open an agent and start configuring it.

## Acceptance Criteria

1. **Given** an agent, **when** its definition opens (`/agents/:id`), **then** the two-pane split renders (config **left**, test pane **right**, default 60/40; collapses to a **Test** toggle and single-column config below 1024px) with **collapsible** config sections and **autosave** showing `Saving… → Saved` (no manual Save button). [Source: epics.md#Story-3.2; DESIGN.md#Layout (editor-split 60/40), #components.agent-editor-pane/#test-pane; EXPERIENCE.md#Component-Patterns, #State-Patterns (Saving/saved), #Responsive]
2. **Given** the Model section, **when** selecting a model, **then** models are **grouped by provider**; a provider with no key is **disabled** with an inline **`Connect in Settings`** link; the choice renders **`provider / model-id` in mono**. The selection is written by `control-api` only (AD-7) and persists. [Source: epics.md#Story-3.2 FR-2; DESIGN.md#components.model-selector, #Typography (mono zones); EXPERIENCE.md#Component-Patterns, Key-Flow-1; ARCHITECTURE-SPINE.md AD-7]
3. **Given** the agents list (Story 3.1), **when** a row is activated, **then** it navigates to that agent's definition surface (`/agents/:id`) — the navigation deliberately deferred from 3.1 lands here. [Source: 3-1-create-agent.md (rows display-only, "/agents/:id is Story 3.2")]

## Tasks / Subtasks

- [x] **Task 1: Persist agent `model` — table + repo update path** (AC: #2)
  - [x] Add a nullable **`model`** column (`text`) to the `agents` table in `apps/control-api/src/db/schema.ts` (holds a `"provider/model-id"` string; matches domain `Agent.model?: string`). `drizzle-kit generate` → commit migration **`0004`**. Preserve the existing `agents` columns + migrations `0000`–`0003`. [Source: ARCHITECTURE-SPINE.md AD-7; packages/domain Agent.model]
  - [x] Extend `AgentRow` (`apps/control-api/src/agents/repo.ts`) with `model: string | null` (map the column in `toRow`; insert `model: null` on create — new agents have no model until selected).
  - [x] Add `update(id, patch): Promise<AgentRow | null>` to `AgentsRepo` (Drizzle + in-memory), where `patch` is a partial `{ name?: string; model?: string | null }`. Returns the updated row, or `null` if the id doesn't exist. **Single-writer (AD-7): `control-api` is the only writer of Agent state.** Shape the method to accept future definition fields (instructions/skills/caps land in 3.3–3.5) but implement only `name` + `model` now.

- [x] **Task 2: Agent detail + autosave routes (control-api)** (AC: #1, #2)
  - [x] In `apps/control-api/src/agents/routes.ts` (already behind `requireSession` via `/agents/*`):
    - `GET /agents/:id` → `{ agent }` (200) or `{ error }` (404) when unknown.
    - `PATCH /agents/:id` → body `{ name?, model? }`. Trim + cap `name` at the existing `MAX_NAME_LEN` (reject an empty-after-trim name → keep prior/reject with 400); `model` is a trimmed non-empty `"provider/model-id"` string (cap length) or `null` to clear. Ignore unknown keys. Apply via `repo.update`; return `{ agent }` (200) or 404 if the id is unknown. Only `name`/`model` are writable in 3.2.
  - [x] No `app.ts`/`server.ts` change needed — `/agents/*` is already guarded and `agentRoutes(agentsRepo)` is already mounted. **Preserve** `GET`/`POST /agents` and the whole Epic 1/2 surface.

- [x] **Task 3: Agents list → detail navigation** (AC: #3)
  - [x] In `apps/web/src/routes/(app)/agents/+page.svelte`, make each agent row navigate to `/agents/{id}` (an `<a href>` wrapping the row, or `goto()` on click + `Enter`). Keep the name + `StatusDot`, the `/`-focus filter, and the empty/loading/error states from 3.1 intact. Rows must be keyboard-activable with a visible focus ring. [Source: EXPERIENCE.md#Accessibility (keyboard-reachable, focus ring); 3-1-create-agent.md]

- [x] **Task 4: Two-pane definition surface** (AC: #1)
  - [x] New route `apps/web/src/routes/(app)/agents/[id]/+page.svelte`:
    - On mount, load the agent (`GET /agents/:id`, discriminated client) and the configured providers (`listProviders()` from `$lib/connections`). Handle loading / not-found (agent 404 → "That agent doesn't exist." + a link back to Agents) / error.
    - **Header:** a back affordance to **Agents**, the agent **name** as an autosaving text field (persistent `<label>`, not placeholder-only), the lifecycle **`StatusDot`** (Draft), and the **autosave indicator** (`Saving… → Saved`, `--text-tertiary` micro-cap; hidden when idle; inline error on failure).
    - **Two-pane split:** config **left** (`--surface-card`), test pane **right** (`--bg-canvas`, `border-left: 1px solid var(--border-subtle)`), ~60/40. Below **1024px** (media query): config goes single-column and the test pane collapses behind a **`Test`** toggle button. (A draggable divider is nice-to-have per DESIGN; a fixed 60/40 split is acceptable for 3.2 — note if deferred.)
    - **Test pane (scaffold only):** a placeholder — "Test runs appear here." (fact; the **Run test** flow + streaming transcript are **Epic 4**, do NOT build them). No Run button, no run logic in 3.2.
  - [x] Reusable **`apps/web/src/lib/components/Section.svelte`** — a collapsible config section: an **11px tracked micro-cap** label (per DESIGN `agent-editor-pane`), a disclosure toggle (default open), keyboard-operable (`button` header with `aria-expanded`, content region). Later stories add Instructions/Skills/Variables/Cost caps/Allowlist sections using it. In 3.2 render **only the Model section** — do NOT add empty placeholder sections for later stories.

- [x] **Task 5: Model selector** (AC: #2)
  - [x] Reusable **`apps/web/src/lib/components/ModelSelector.svelte`** — bound to the configured providers + current value; emits the chosen `"provider/model-id"`.
    - **Grouped by provider:** one `<optgroup>` per provider with options rendered **`provider / model-id` in mono** (IBM Plex Mono, `tabular-nums`). Option value = the persisted `"provider/model-id"` string.
    - **Unconfigured/absent provider disabled + `Connect in Settings`:** for each known provider kind (`openai`, `anthropic`, `openai-compatible`) that is **not** connected (absent, or status `error`/`unconfigured`, or zero models), show it **disabled**; render an inline **`Connect in Settings`** link (→ `/settings/providers`) whenever ≥1 provider is unconfigured (and as the whole empty state when none are connected). Provider status is conveyed by the disabled state + a status **word** in the optgroup label (`OpenAI · connected` / `OpenAI · not connected`) — **never colour-only**. [Source: EXPERIENCE.md#Accessibility (status never colour-only)]
    - **Deviation to document:** a native `<select>`/`<optgroup>` can't render a per-option leading status **dot** or a link inside an option. We satisfy the intent with disabled optgroups + status words + the sibling `Connect in Settings` link, keeping native-select accessibility. (A custom listbox with per-option dots is a later polish, not 3.2.)
  - [x] Selecting a model triggers **autosave**: `PATCH /agents/:id { model }` → indicator `Saving… → Saved`. The persisted value re-renders as mono `provider / model-id`.

- [x] **Task 6: Web client + autosave wiring** (AC: #1, #2)
  - [x] Extend `apps/web/src/lib/agents.ts`: add `model: string | null` to the `Agent` type; add `getAgent(id): Result<Agent>` and `updateAgent(id, patch: { name?; model? }): Result<Agent>` (both `credentials:'include'`, discriminated results; errors cause→consequence→recovery).
  - [x] **Autosave semantics (resolves an AD gap — no AD defines autosave; keep it server-authoritative per AD-7):** debounce **text** edits (name) ~400ms; save the **model** select immediately on change. Sequence: set indicator `saving` → `PATCH` → on ok set `saved` (server response is source of truth; no optimistic rollback needed) → on failure show an inline retry hint. Never block editing (EXPERIENCE.md#State-Patterns). Coalesce in-flight saves (don't stack requests).

- [x] **Task 7: Tests + verification** (AC: all)
  - [x] **Unit (control-api, Vitest, in-memory repo + real session):** `GET /agents/:id` → 200 with the agent (incl. `model: null` initially), 404 unknown, **401 without a session**; `PATCH /agents/:id` sets `model` (200, persisted, returned) and `name` (trim + cap), unknown id → 404, empty-after-trim name rejected, **401 without a session**. Assert `update` is the only mutation surface (AD-7).
  - [x] **Playwright e2e (live stack, serial):** from Agents, click a created agent's row → lands on `/agents/:id` with the **two-pane** surface and a **Model** section; with no provider connected the selector shows the **disabled / `Connect in Settings`** state; edit the **name** → the indicator shows `Saving…` then `Saved`, and the new name **persists across reload** and appears back in the agents list. (Model-happy-path selection needs a real provider key, so it's covered at unit level via providers data, not e2e — document this.)
  - [x] `svelte-check` 0 · `pnpm -r build` · `pnpm lint` · control-api unit tests · e2e incl. **Epic 1/2/3.1 regressions** all green.

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

**Second Epic 3 story — open one agent and configure its model. Build: the `/agents/:id` two-pane surface, a reusable collapsible `Section`, the `ModelSelector`, autosave (name + model), and list→detail navigation. Do NOT build: Instructions (3.3), Skills (3.4), Variables (3.3), Cost caps (3.5), Allowlist, Activate/Deactivate (5.1), or any Test-run/streaming behavior (Epic 4). The test pane is a static scaffold. No new external tech — Drizzle migration + guarded Hono routes + SvelteKit, all established in Epics 1–3.1.**

### Architecture / constraints
- **AD-7 single-writer:** `control-api` is the **sole writer** of Agent state — the web never writes the DB; it `PATCH`es control-api, which persists. [ARCHITECTURE-SPINE.md AD-7]
- **AD-8 lifecycle:** the agent stays **Draft** while being configured; **Activate** (Draft→Active) is gated on *model selected + per-run and per-day caps set* and is **Story 5.1** — not here. Selecting a model is a precondition for that later gate. [ARCHITECTURE-SPINE.md AD-8]
- **AD-9 job spec:** the persisted `model` string flows unchanged into `JobSpec.model` (`packages/contracts`, already `model: z.string()`) at run start — no contract change needed now. [ARCHITECTURE-SPINE.md AD-9; packages/contracts]
- **AD-6 / AD-10:** the agent only ever names a `provider/model-id`; the provider **key lives in LiteLLM**, never on the agent record or in the browser. [ARCHITECTURE-SPINE.md AD-6, AD-10]
- **Conventions:** ULID ids, UTC ISO-8601 timestamps, semantic Warm Ink tokens only, Lucide `currentColor`, **status never colour-only** (dot + word), verb-first sentence-case copy, visible focus ring, **mandatory mono/tabular** for model ids. [ARCHITECTURE-SPINE.md#Conventions; DESIGN.md#Typography; project-context.md]

### UX specifics (DESIGN.md / EXPERIENCE.md — Warm Ink baseline wins on conflict)
- **Split:** config left / test right, default **60/40** (`spacing.editor-split`), hairline `--border-subtle` between panes (never shadow). Test pane `--bg-canvas`; config pane `--surface-card`. Below **1024px** → single-column config + a **`Test`** toggle. [DESIGN.md#Layout, #Elevation; EXPERIENCE.md#Responsive]
- **Sections:** vertical stack of collapsible sections; canonical order (later) **Model → Instructions → Skills → Variables → Cost caps → Allowlist**; labels **11px tracked micro-caps**. 3.2 renders only **Model**. [DESIGN.md#components.agent-editor-pane; EXPERIENCE.md#Component-Patterns]
- **Autosave:** `Saving… → Saved` (note the `…` ellipsis) in `--text-tertiary` micro-cap **near the section/header**; debounced; **never a manual Save button** for config; never blocks editing. [EXPERIENCE.md#State-Patterns, #Interaction-Primitives]
- **Model selector:** Select grouped by provider; renders `provider / model-id` in **mono**; unconfigured provider **disabled** with inline **`Connect in Settings`**; leading dot = provider status (→ conveyed by word here, see Task 5 deviation). `radius: --radius-md`, `height: --control-h-md`. [DESIGN.md#components.model-selector; EXPERIENCE.md Key-Flow-1: "the selector shows `openai / gpt-4o` disabled: no key yet, with `Connect in Settings`"]
- **Voice:** buttons are verbs; sentence case; specific numbers; no exclamation/emoji; empty states = "fact + one action". Form fields have **persistent labels** (not placeholder-only). [EXPERIENCE.md#Voice, #Accessibility]

### Files being modified (READ current state — preserve behavior)
- **`apps/control-api/src/db/schema.ts` (UPDATE):** add `model text` (nullable) to `agents`. Preserve all columns + migrations `0000`–`0003` (new `0004`).
- **`apps/control-api/src/agents/repo.ts` (UPDATE):** `AgentRow` gains `model`; add `update()` to interface + Drizzle + memory impls. `create` inserts `model: null`. Keep the newest-first `list()` + `get()`.
- **`apps/control-api/src/agents/routes.ts` (UPDATE):** add `GET /agents/:id` + `PATCH /agents/:id`. Reuse `MAX_NAME_LEN`. Keep `GET`/`POST /agents` and the `null`-body/name-cap hardening from the 3.1 review.
- **`apps/web/src/lib/agents.ts` (UPDATE):** `Agent.model`, `getAgent`, `updateAgent`. Keep `listAgents`/`createAgent` + the `Array.isArray` guard from the 3.1 review.
- **`apps/web/src/routes/(app)/agents/+page.svelte` (UPDATE):** rows become navigable to `/agents/:id`. **Preserve** the `Agents` heading, "No agents yet." string, `/`-focus filter, `StatusDot`, and loading/error branches (incl. the Retry added in the 3.1 review).
- **NEW:** `apps/web/src/routes/(app)/agents/[id]/+page.svelte`, `apps/web/src/lib/components/Section.svelte`, `apps/web/src/lib/components/ModelSelector.svelte`, `apps/control-api/drizzle/0004_*.sql`.

### Previous-story intelligence (Epics 1–3.1)
- **Pattern:** control-api routes are factories over an injected repo (interface + Drizzle + in-memory); guard via `requireSession`; tests use `app.request(...)` with a real session from `POST /auth/login`. Mirror for `GET`/`PATCH /agents/:id`. [2-1, 3-1]
- **Drizzle:** schema → `drizzle-kit generate` → committed migration → `migrate()` at startup; control-api owns its `control` DB. Last migration is `0003` — this adds `0004`. [3-1]
- **Web:** discriminated client results (`Result<T>`), `credentials:'include'`, `base = VITE_CONTROL_API_URL ?? http://localhost:8080`; Warm Ink tokens + `@lucide/svelte`; `$state`/`$derived`/`$effect` runes; `goto()` from `$app/navigation` for client nav (see login/topbar). `StatusDot` (dot + word) exists from 3.1 — reuse for the Draft state. The `connections` client (`listProviders()`) returns `{ provider, name, status, models[] }` — the model-selector's data source. [1-3, 2-1, 3-1]
- **Same-ms ordering / state CHECK / vacuous single-writer test** are known deferrals from the 3.1 review (`deferred-work.md`) — do NOT re-open here.
- **e2e is serial** (`workers:1`, set in 2.2) — keep it. A connected provider needs a real key, so model-happy-path selection is unit-tested via providers data, not e2e (e2e asserts the disabled/`Connect in Settings` state + name autosave).

### Testing standards
- **Unit (control-api):** GET/:id 200/404/401; PATCH model persists + returned; PATCH name trim/cap + empty-rejected; PATCH unknown → 404; guard 401↔200; in-memory repo, no live DB.
- **E2E (Playwright, live stack, serial):** list row → `/agents/:id` two-pane + Model section; no-provider → disabled + `Connect in Settings`; name edit → `Saving…`→`Saved` → persists across reload + in the list.
- `svelte-check` 0, build 6/6, lint clean, Epic 1/2/3.1 regressions green.
- **DoD:** open an agent → two-pane surface with a collapsible Model section + autosave; model persists via control-api only (AD-7); list rows navigate to detail; agent stays Draft; status shown as dot + word; regressions intact; only permitted sections modified. NO instructions/skills/variables/caps/allowlist/activate/test-run behavior.

### Project Structure Notes
- New (control-api): migration `0004`. New (web): `agents/[id]/+page.svelte`, `Section.svelte`, `ModelSelector.svelte`, `tests/agent-detail.spec.ts`. Modified: control-api `schema.ts`/`repo.ts`/`routes.ts`/`agents.test.ts`, web `agents.ts`/`agents/+page.svelte`. No other apps/packages touched. [ARCHITECTURE-SPINE.md#Structural-Seed, AD-7]

### References
- [Source: _bmad-output/planning-artifacts/epics.md#Epic-3 / Story-3.2; FR-2]
- [Source: ARCHITECTURE-SPINE.md AD-6, AD-7, AD-8, AD-9, AD-10, #Conventions, #Structural-Seed]
- [Source: ux-designs/ux-turanga-2026-07-30/DESIGN.md#Layout, #components.agent-editor-pane/#test-pane/#model-selector, #Typography, #Elevation]
- [Source: ux-designs/ux-turanga-2026-07-30/EXPERIENCE.md#Component-Patterns, #State-Patterns, #Interaction-Primitives, #Responsive, #Accessibility, Key-Flow-1]
- [Source: packages/domain (Agent.model, LifecycleState), packages/contracts (JobSpec.model)]
- [Source: _bmad-output/implementation-artifacts/3-1-create-agent.md + 2-1-model-providers.md (repo/route/guard/drizzle/client patterns); deferred-work.md]

## Dev Agent Record

### Agent Model Used
claude-opus-4-8[1m]

### Debug Log References
- `svelte-check`: `page.params.id` is typed `string | undefined` in SvelteKit → coerced with `?? ""`. Self-closing `<optgroup … />` warning → expanded to `<optgroup></optgroup>`.
- **E2E test isolation:** the agents-list row changed from `<li class="agent">` to `<li><a class="agent">` (navigation), so the 3.1 selectors (`li.agent`) were updated to `a.agent`. All agent e2e were consolidated into **one** file (`tests/agents.spec.ts`) so the serial run guarantees the 3.1 empty-state assertion executes first on a fresh DB before any test creates agents — a standalone `agent-detail.spec.ts` would have sorted alphabetically *before* `agents.spec.ts` and polluted that assertion (shared DB, no per-test reset).

### Completion Notes List
- **Task 1** — `model text` (nullable) added to `agents`; migration `0004_strong_nekra.sql`. `AgentRow` gains `model: string | null`; `AgentsRepo.update(id, patch)` (partial `{name?, model?}`) on Drizzle (`.returning()`) + memory (`applyPatch`, only-defined-keys). `create` inserts `model: null`.
- **Task 2** — `GET /agents/:id` (200 / 404) and `PATCH /agents/:id` (name trim+cap, empty-name→400; model trim+cap or `null` to clear, else 400; unknown keys ignored; 404 unknown id). No `app.ts`/`server.ts` change — `/agents/*` already guarded and mounted.
- **Task 3** — agents-list rows are now `<a class="agent" href="/agents/{id}">` (keyboard-activable, hover = one surface step up, visible focus ring). 3.1 empty/loading/error/filter states preserved.
- **Task 4** — `agents/[id]/+page.svelte`: two-pane split (config `--surface-card` left / test `--bg-canvas` right, 60/40 grid, hairline divider), header (back arrow, autosaving name field with persistent label, Draft `StatusDot`, autosave indicator, Test toggle), test pane scaffold ("Test runs appear here."). Below 1024px → single-column config + Test toggle reveals the pane. Reusable `Section.svelte` (collapsible, 11px tracked micro-cap label, `aria-expanded` button). Only the Model section is rendered (later sections are 3.3–3.5).
- **Task 5** — `ModelSelector.svelte`: native `<select>` grouped by provider (`<optgroup>`), options `provider / model-id` in mono/tabular; each known kind unconfigured → disabled optgroup + a sibling `Connect in Settings` link (→ /settings/providers); a dot+word **legend** conveys provider status (never colour-only). An orphaned previously-selected model stays visible/selected.
- **Task 6** — `agents.ts`: `Agent.model`, `getAgent`, `updateAgent`. Autosave (AD-7 server-authoritative): name debounced ~400ms (blank not saved — control-api would 400), model saved immediately; indicator `Saving… → Saved`, inline error on failure; the PATCH response is the source of truth.
- **Task 7** — control-api unit +10 (GET/:id 200/404/401; PATCH model persist/trim/cap/clear; PATCH name trim/empty-400; omitted-field-untouched; unknown→404; 401) → **40/40**. E2E: list→detail nav, two-pane + Model section, no-provider disabled + `Connect in Settings`, name autosave → Saved → persists across reload + in the list → **11/11**.
- **Verification** — `pnpm -r build` 6/6, `pnpm -r test` all green (control-api 40), `pnpm lint` clean, `svelte-check` 0, live-stack Playwright 11/11 against a fresh docker stack (`down -v` → rebuild control-api (migration 0004) → healthy → e2e → `down -v`).

**Documented deviations:** (1) native `<select>` can't render per-option status dots or in-option links → intent satisfied via disabled optgroups + a dot+word legend + a sibling `Connect in Settings` link (a custom listbox is later polish). (2) The DESIGN draggable divider is deferred — a fixed 60/40 grid split is used (noted as acceptable in the story). (3) E2E consolidated into `agents.spec.ts` rather than a new `agent-detail.spec.ts` (test-ordering / DB-isolation, see Debug Log).

### File List
- NEW `apps/control-api/drizzle/0004_strong_nekra.sql` (+ `drizzle/meta` snapshot/journal)
- NEW `apps/web/src/routes/(app)/agents/[id]/+page.svelte`
- NEW `apps/web/src/lib/components/Section.svelte`
- NEW `apps/web/src/lib/components/ModelSelector.svelte`
- MOD `apps/control-api/src/db/schema.ts` (agents.model)
- MOD `apps/control-api/src/agents/repo.ts` (AgentRow.model, AgentPatch, update())
- MOD `apps/control-api/src/agents/routes.ts` (GET/:id, PATCH/:id, model on create)
- MOD `apps/control-api/src/agents/agents.test.ts` (+10 tests)
- MOD `apps/web/src/lib/agents.ts` (Agent.model, getAgent, updateAgent)
- MOD `apps/web/src/routes/(app)/agents/+page.svelte` (rows navigate to /agents/:id)
- MOD `apps/web/tests/agents.spec.ts` (selector fix + appended detail test)

### Change Log
- 2026-08-01 — Story 3.2 implemented: /agents/:id two-pane definition surface, collapsible Model section, provider-grouped model selector, name+model autosave via control-api (AD-7), list→detail navigation. Status → review.
