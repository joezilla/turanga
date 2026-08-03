---
baseline_commit: b3cbb1bab62c1812a24b4917ef6140c1c31df5f4
---
# Story 5.1: Activate and Deactivate with gating

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As the builder,
I want to deliberately promote an agent to production,
so that going live is an intentional, safe act.

## Acceptance Criteria

1. **Given** an agent missing a model or either cap, **when** Activate is viewed, **then** it is **disabled with a stated reason**. [Source: epics.md#Story-5.1 AC1, FR-5, UX-DR24]
2. **Given** a fully-configured Draft agent, **when** Activate is used, **then** its state becomes **Active** and it is eligible for production runs under its Guard and caps. [Source: epics.md#Story-5.1 AC2, FR-5, FR-6, AD-8]
3. **Given** an Active agent, **when** Deactivate is used, **then** it **returns to Draft** and is no longer eligible for production runs. [Source: epics.md#Story-5.1 AC3, FR-5, AD-8]

## Tasks / Subtasks

- [x] **Task 1: The shared activation-gate rule (domain)** (AC: #1, #2)
  - [x] `packages/domain/src/index.ts` — add a pure helper `activationBlockers(agent: { model: string | null; costCap: CostCap }, modelProviderConnected: boolean): string[]` returning the human reasons an agent can't be activated, in a stable order: no model → `"Select a model."`; model set but its provider isn't connected → `"The selected model's provider isn't connected — reconnect it in Settings."`; no per-run cap → `"Set a per-run cost cap."`; no per-day cap → `"Set a per-day cost cap."`. Returns `[]` when activatable. This single rule is the source of truth for both the server enforcement (Task 2) and the disabled-with-reason UI (Task 4) — no drift.

- [x] **Task 2: Server-side transitions + gate (control-api, the authoritative writer, AD-7)** (AC: #1, #2, #3)
  - [x] `apps/control-api/src/agents/repo.ts` — add `state?: LifecycleState` to `AgentPatch` + `applyPatch` + the drizzle `update` set (the column already exists). This is written ONLY by the activate/deactivate routes below — the general `PATCH /agents/:id` route must NOT accept `state` (a deliberate action, not a field edit).
  - [x] `apps/control-api/src/agents/routes.ts` — thread `connectionsRepo` into `agentRoutes(agentsRepo, connectionsRepo)` and add two deliberate endpoints (session-guarded via the existing `/agents/*`):
    - `POST /agents/:id/activate` — load the agent (404 if missing); compute `modelProviderConnected` (the model `"<prefix>/<id>"` has a **connected** provider whose kind or connection-name matches `<prefix>`, from `connectionsRepo.list()`); `const blockers = activationBlockers(agent, modelProviderConnected)`; if `blockers.length` → **`400 { error: blockers[0], blockers }`** (fail-closed — never activate a mis-configured agent, FR-5); else `repo.update(id, { state: "active" })` → `{ agent }`.
    - `POST /agents/:id/deactivate` — load (404); `repo.update(id, { state: "draft" })` → `{ agent }`. Idempotent-friendly (deactivating a Draft is a harmless no-op that returns Draft).
  - [x] `apps/control-api/src/app.ts` — pass `connectionsRepo` to `agentRoutes` (it's already constructed for `connectionRoutes`).
  - [x] **Editing stays allowed in both states** (FR-11: caps editable while Active) — do NOT lock the definition PATCH when Active. Activate is a state marker + the gate; it does not freeze the agent.

- [x] **Task 3: (No production-run path changes)** (AC: #2, #3)
  - [x] Confirm — and note in code/comments — that **Test runs are NOT gated on Active** (Test is an execution mode that runs a Draft, established in 4.2). There is **no production-run scheduler in MVP**, so "eligible for production runs" is a state marker (the gate + lifecycle), not a new run path. FR-6 ("a Draft cannot execute a production run") holds vacuously — no production-run path exists to reach from Draft. Do NOT add run-time state gating to the orchestrator/test pane.

- [x] **Task 4: Activate / Deactivate control (web)** (AC: all)
  - [x] `apps/web/src/lib/agents.ts` — add `activateAgent(id): Promise<Result<Agent>>` (POST `/agents/:id/activate`, discriminated result — a 400 surfaces `error` as the blocker reason) and `deactivateAgent(id): Promise<Result<Agent>>` (POST `/agents/:id/deactivate`). Reuse the `req`/`base`/`credentials` pattern.
  - [x] `apps/web/src/routes/(app)/agents/[id]/+page.svelte` — in the header (next to the `StatusDot` + save indicator), render a verb-first primary control:
    - **Draft** → an **`Activate`** button. Compute `blockers` via the domain `activationBlockers(agent, modelProviderConnected)` (derive `modelProviderConnected` from the loaded `providers`). If `blockers.length`, the button is **`disabled`** and a **stated reason** shows inline (the first blocker, or a combined "Select a model and set both cost caps to activate."), cause→consequence→recovery voice (UX-DR16). On click (enabled) → `activateAgent` → on success set `agent.state = "active"`; on a server 400 (a race — caps cleared meanwhile) show the returned reason.
    - **Active** → a **`Deactivate`** button that **confirms in a dialog naming the consequence** (EXPERIENCE.md:83 — Deactivate is a state-changing action: "Deactivate returns this agent to Draft; it won't run in production until you re-activate it."). Cancel keeps it Active; confirm → `deactivateAgent` → set `agent.state = "draft"`.
  - [x] **Primary buttons are INK, not teal** (DESIGN.md:101 — reuse `.primary` / the action-primary tokens, NOT a saturated color). The `StatusDot` already renders draft/active (dot + word) — keep it; the button reflects the transition, the dot reflects state. Autosave, the test pane, the `<1024px` Test toggle, and all 3.x/4.x behavior stay intact.

- [x] **Task 5: Tests + verification** (AC: all)
  - [x] **Domain unit:** `activationBlockers` truth table — no model / provider-not-connected / missing per-run / missing per-day / fully-configured (empty). Order is stable.
  - [x] **control-api unit (agents.test.ts):** `POST /activate` → 400 with a stated blocker when model/caps missing (and when the model's provider isn't connected); → 200 + `state:"active"` when fully configured with a connected provider; `POST /deactivate` → 200 + `state:"draft"`; the general `PATCH /agents/:id` **ignores** a `state` in the body (can't self-promote via a field edit); 404 for a missing id. Give each `appWithSession` a distinct `x-forwarded-for` (the login rate-limiter, per prior stories).
  - [x] **Playwright e2e (live stack, serial — append to `tests/agents.spec.ts`):** create an agent → open it → **Activate is disabled** with a stated reason (no model/caps); set a model (via API, no provider is connectable in e2e — set `model` + both caps via `page.request.patch`) → reload → Activate still gated on the provider-connected check (**or**, if the provider-connected check can't be satisfied in e2e, assert the disabled reason names the provider) → the deterministic path: **Deactivate an already-Active agent** (PATCH the agent to a state the API allows? no — use the activate endpoint after making it activatable, OR assert the gating + the Deactivate confirm dialog on an agent the test activates through the API). Keep the e2e to what's deterministic without a connected provider: assert **Activate disabled + stated reason** for an unconfigured agent, and the **Deactivate confirm dialog** flow for an agent set Active via the API. (A full Activate click needs a connected provider — gated/manual, mirroring the run e2e pattern.)
  - [x] `svelte-check` 0 · `pnpm -r build` 6/6 · `pnpm lint` · all unit suites · e2e incl. Epic 1–4 regressions green · `docker compose down -v` teardown.

## Dev Notes

**First Epic 5 story — the deliberate Draft↔Active lifecycle gate. Small + focused: agents already carry `state: "draft" | "active"` (Epic 3) and render it (StatusDot on the list + detail). 5.1 adds (a) the shared activation-gate rule, (b) server-authoritative Activate/Deactivate transitions with the gate enforced, and (c) the header control (Activate disabled-with-reason / Deactivate with a confirm dialog). It does NOT add a production-run scheduler — "eligible for production runs" is a state marker (there's no production-run path in MVP; Test runs a Draft, unchanged).**

**No user forks — the shape is determined by FR-5/FR-6/FR-11 + UX-DR24 + the existing lifecycle field.**

### Architecture (the spines govern — binding)
- **AD-8 lifecycle:** the AGENT moves `Draft ↔ Active` via the deliberate Activate (gated) / Deactivate transitions; the RUN lifecycle (`created → running → succeeded|failed|killed`) is separate (Epic 4). Both are mutated only by control-api.
- **AD-7:** control-api is the **sole writer of Agent state** — the gate is enforced server-side (the web mirrors it for UX, but the server is authoritative; a mis-configured agent can never be activated even via a crafted request).
- **AD-6 / Epic 4:** an Active agent "runs under its Guard and Cost Cap" — the Guard + caps already apply to every run (test or otherwise) from Epic 4; Activate doesn't change enforcement, it marks the agent eligible + records the deliberate promotion.

### PRD / FR (verbatim intent)
- **FR-5:** promote Draft → **Active** in a deliberate, explicit action; **blocked with a stated reason unless the Agent has a selected model from a connected provider AND a Cost Cap set**; on Activate the state becomes Active + eligible to run in production under its Guard + Cost Cap; **Active agents can be returned to Draft (Deactivate)**.
- **FR-6:** every Agent has exactly one Lifecycle State visible wherever it appears; **a Draft Agent cannot execute a production (Active) Run** (vacuous in MVP — no production-run path; Test runs a Draft, read-only).
- **FR-11:** an Agent **cannot be Activated without both caps set**; **caps are editable while Active**.

### UX specifics (DESIGN.md / EXPERIENCE.md — Warm Ink)
- **UX-DR24:** the **Activate control is disabled with a stated reason** until a model is selected and both caps are set; **Deactivate returns to Draft**. [epics.md:95]
- **Verbs, not nouns:** `Activate` / `Deactivate` (never Deploy/Submit). Primary buttons are **INK, not teal** (reuse `.primary` / action-primary tokens; the saturated-colour budget is for status only). [EXPERIENCE.md:48, DESIGN.md:101/141]
- **Deactivate confirms in a dialog naming the consequence** (a state-changing action). [EXPERIENCE.md:83] Activate does not need a confirm — the gate + the deliberate click is the safety.
- **Voice:** the disabled reason is cause→consequence→recovery, sentence case, no exclamation ("Set both cost caps to activate."). Agent state is **stated, never celebrated** — on Activate the dot resolves to `active` (dot + word), no fanfare. [EXPERIENCE.md:49, UX-DR16] Key-Flow: "Activate was disabled until model + both caps were set; now it's live. He clicks it → Active." [EXPERIENCE.md:105]
- The `StatusDot` component already maps `draft`/`active` → dot + word (`--state-*`); reuse it (the agents list + detail already render it). No new status visuals.

### Files being modified (READ current state — preserve behavior)
- **`packages/domain/src/index.ts` (UPDATE):** add `activationBlockers`. `LifecycleState = "draft" | "active"`, `CostCap { perRun, perDay }`, `Money` already exist.
- **`apps/control-api/src/agents/repo.ts` (UPDATE):** `AgentPatch.state?` + `applyPatch` + drizzle `update`. The `agents.state` column exists (default `"draft"`). Preserve the existing patch fields.
- **`apps/control-api/src/agents/routes.ts` (UPDATE):** `agentRoutes(agentsRepo, connectionsRepo)` + the `/activate` + `/deactivate` routes. Preserve `POST /agents`, `PATCH /agents/:id` (which must keep ignoring `state`), `GET`. The 3.6 dependents-guard logic lives in `connectionRoutes` (already has `agentsRepo`) — unaffected.
- **`apps/control-api/src/app.ts` (UPDATE):** pass `connectionsRepo` to `agentRoutes` (line ~73). `connectionsRepo` is already built for `connectionRoutes` (line ~67).
- **`apps/control-api/src/agents/agents.test.ts` (UPDATE):** the activate/deactivate + gate tests.
- **`apps/web/src/lib/agents.ts` (UPDATE):** `activateAgent` / `deactivateAgent`. The `Agent` type has `state`, `model`, `costCap`.
- **`apps/web/src/routes/(app)/agents/[id]/+page.svelte` (UPDATE):** the header control + the Deactivate confirm dialog + the disabled reason. Preserve the two-pane split, autosave, the test pane (Epic 4), the `<1024px` toggle, StatusDot.
- **`apps/web/tests/agents.spec.ts` (UPDATE):** append the gating + Deactivate-dialog e2e.

### Previous-story intelligence (Epic 3 + Epic 4)
- **Agents (3.1–3.6):** `state` defaults `"draft"` at create; `StatusDot` renders it (agents list `.status-dot`, detail header). The general `PATCH` autosaves definition fields (name/model/instructions/variables/skills/costCap) — do NOT add `state` to that path. The web detail page loads `providers` via `listProviders()` (for the ModelSelector) — reuse for the `modelProviderConnected` check. `updateAgent` returns the server-authoritative agent (trust it). The 3.6 "remove provider surfaces dependents" flow + the agents-list meter placeholder (Active-only, still Epic 5 for the live meter — that's Story 5.2, not 5.1) are established.
- **Cost caps (3.5):** `CostCap { perRun: Money|null, perDay: Money|null }`; the CostCapsEditor sets each side; "both required before Activate" is exactly this gate. `money.ts` `formatMinor`.
- **Model (3.2):** `model` is `"provider/model-id"` (or `null`); the ModelSelector offers models from connected providers. The provider-connected check maps the model prefix to a connected connection (kind or name).
- **Web patterns:** discriminated `Result<T>`, `base = VITE_CONTROL_API_URL`, `credentials:'include'`; Warm Ink tokens; `.primary` (ink) button; confirm-dialog pattern exists (the 3.6 provider-remove arm/confirm; reuse a similar inline confirm for Deactivate). e2e is serial in `tests/agents.spec.ts`; give each login a distinct client / the rate-limiter trips past ~20 logins.
- **Known deferrals (do not reopen):** the live agents-list meter (Story 5.2), run history (5.3), the Epic 4 review deferrals. No production-run scheduler in MVP.

### Security / correctness invariants (must hold)
- **Server-authoritative gate (AD-7):** the activate route enforces `activationBlockers` — a mis-configured agent (no model / no caps / provider not connected) can never be set Active, even by a crafted POST. The web disable is UX only.
- **`state` is not a self-editable field:** the general `PATCH /agents/:id` must ignore `state` (assert in a test) — promotion is only via the deliberate `/activate` (gated) route.
- **No regression to runs:** Test runs (Epic 4) are unchanged and NOT gated on Active; the orchestrator/test pane get no state check. Editing an Active agent stays allowed (FR-11).

### Testing standards
- **Unit (Vitest):** `activationBlockers` truth table (domain); the activate/deactivate routes (gate → 400 with reason; success → state flip; PATCH ignores state; 404) with `appWithSession` + distinct `x-forwarded-for`.
- **E2E (Playwright, live, serial):** Activate disabled + stated reason for an unconfigured agent; the Deactivate confirm-dialog flow (activate via API is gated on a connected provider — the disabled-reason + Deactivate-dialog paths are the deterministic no-provider coverage; a full Activate click is gated/manual like the run happy-path).
- `svelte-check` 0, build 6/6, lint clean, Epic 1–4 regressions green.
- **DoD:** Activate is disabled with a stated reason until model + both caps (+ connected provider) are set; a fully-configured Draft activates to Active (server-enforced); Deactivate returns to Draft (with a consequence-naming confirm); the general PATCH can't change state; Test runs + editing are unaffected; only 5.1 scope (the live list meter is 5.2, run history is 5.3).

### Project Structure Notes
- Modified: `packages/domain`, `apps/control-api/src/agents/{repo,routes}.ts` + `agents.test.ts`, `apps/control-api/src/app.ts`, `apps/web/src/lib/agents.ts` + the detail page + the e2e. **No DB migration** (the `state` column exists). No contracts/guard/harness changes (agent lifecycle is control-api + web only). [AD-7/AD-8]

### References
- [Source: epics.md#Epic-5 / Story-5.1 (AC1-3); FR-5, FR-6, FR-11, UX-DR24, UX-DR16]
- [Source: prds/prd-turanga-2026-07-31/prd.md — FR-5 :115-119, FR-6 :123-126, FR-11 :167-170; Lifecycle glossary :59; Epic "Lifecycle & Testing" :103-108]
- [Source: architecture/architecture-turanga-2026-07-31/ARCHITECTURE-SPINE.md — AD-7 (control-api sole writer of Agent state), AD-8 (lifecycle transitions)]
- [Source: ux-designs/ux-turanga-2026-07-30/DESIGN.md#Primary-actions-ink (:101/:128/:141); EXPERIENCE.md (:48/:49/:79/:83/:105), UX-DR24 (epics.md:95)]
- [Source: packages/domain/src/index.ts (LifecycleState, CostCap, Money); apps/control-api/src/agents/{repo,routes}.ts; apps/web/src/lib/agents.ts; apps/web/src/routes/(app)/agents/[id]/+page.svelte; apps/web/src/lib/components/StatusDot.svelte]
- [Source: _bmad-output/implementation-artifacts/3-5-*.md, 3-6-*.md, 4-2-test-pane-streaming.md, deferred-work.md; project-context.md]

## Dev Agent Record

### Agent Model Used
claude-opus-4-8[1m]

### Debug Log References
- The web deliberately mirrors types in `$lib` and does NOT depend on `@turanga/domain` (its `ulid` uses node crypto → not browser-safe; vite/rollup fails to resolve it). So `activationBlockers` is **mirrored in `$lib/agents.ts`** (matching the domain version) rather than imported — consistent with how the web already mirrors `Agent`/`RunMessage` shapes. The server (control-api) uses the authoritative `@turanga/domain` version.
- e2e `--build` warmup flake (the two empty-DB tests #19/#46) reproduced again; a clean `down -v` → poll `/health` only (no manual logins) → run once gives 21/21.

### Completion Notes List
- The deliberate Draft↔Active lifecycle gate. `activationBlockers(agent, modelProviderConnected)` (domain, + a web mirror) is the shared rule: no model / provider-not-connected / missing per-run / missing per-day, in a stable order.
- **Server-authoritative (AD-7):** `POST /agents/:id/activate` (gated — a mis-configured agent gets a 400 with the blocker reason, never activates) + `POST /agents/:id/deactivate`; `state` is in the repo patch but written ONLY by these routes — the general PATCH ignores `state` (unit-asserted: a crafted `PATCH {state:"active"}` stays Draft).
- **Web:** the header gains a verb-first control — **Activate** (Draft) disabled with the stated reason (ink `.primary`, `title` + inline `.gate-reason`) / **Deactivate** (Active) via a consequence-naming confirm dialog. Editing stays allowed in both states (FR-11). The `StatusDot` (draft/active) is unchanged.
- **No run-path change:** Test runs are not gated on Active (4.2) and there's no production-run scheduler in MVP, so "eligible for production runs" is a state marker; FR-6 holds vacuously. The orchestrator/test pane are untouched.
- **AC coverage:** AC1 (disabled + stated reason) — domain truth table + control-api gate tests + the live e2e (unconfigured → "Select a model."; model+caps set → the provider-not-connected reason). AC2/AC3 (the actual Draft→Active→Draft transitions) — control-api unit tests; the full Activate *click* + Deactivate dialog need a connected provider (not connectable in dev) → gated/manual, mirroring the run/OAuth pattern.

### File List
**Modified**
- packages/domain/src/index.ts + index.test.ts
- apps/control-api/src/agents/repo.ts
- apps/control-api/src/agents/routes.ts
- apps/control-api/src/agents/agents.test.ts
- apps/control-api/src/app.ts
- apps/web/src/lib/agents.ts
- apps/web/src/routes/(app)/agents/[id]/+page.svelte
- apps/web/tests/agents.spec.ts

### Change Log
| Date | Change |
| --- | --- |
| 2026-08-03 | Story 5.1 implemented (opens Epic 5): the shared `activationBlockers` gate rule (domain + web mirror), server-authoritative Activate/Deactivate routes (gate enforced; PATCH can't self-promote), the header Activate (disabled-with-reason) / Deactivate (confirm dialog) control. Verified: build 6/6, svelte-check 0/0, lint clean, unit (domain 3, control-api 99), 21/21 e2e on a fresh live stack incl. the gating test, no run-path regressions. Status → review. |
