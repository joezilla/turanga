---
baseline_commit: 13c611c74c273657f73f72ccf313757918c3300e
---
# Story 3.6: Manage agents centrally and guard connection removal

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As the builder,
I want to manage all agents and see connection dependents,
so that I don't break a running agent by removing a connection.

## Acceptance Criteria

1. **Given** the agents list, **when** viewed, **then** it shows every agent with its **Lifecycle State** (dot + word) and — **for Active agents** — a **cost-meter placeholder** (mono/tabular `today $0.00 / $<per-day cap>`; live spend is Epic 4). [Source: epics.md#Story-3.6 FR-15; DESIGN.md#components.cost-meter ("per Active agent in the agents list"), #Typography (mono cap amounts)]
2. **Given** a model-provider connection **referenced by one or more agents** (an agent whose selected `model` is `providerKind/…`), **when** it is removed, **then** the **dependent agents are surfaced before the removal is confirmed** (in the confirm affordance, naming the consequence). [Source: epics.md#Story-3.6 FR-15; 2-3 (guard deferred to 3.6 "once agents can reference connections"); EXPERIENCE.md#Interaction-Primitives ("removing a connection in use first surfaces the dependent agents"); ARCHITECTURE-SPINE.md AD-7]

## Tasks / Subtasks

- [x] **Task 1: Provider dependents endpoint (control-api)** (AC: #2)
  - [x] Add `GET /connections/providers/:id/dependents` → `{ agents: [{ id, name, state }] }`: look up the provider by id (404 if unknown) to get its **kind**, then list agents and return those whose `model` starts with `"<kind>/"` (an agent references the provider it draws its model from). Behind the existing `requireSession` guard. [Source: connections/routes.ts, agents/repo.ts; ARCHITECTURE-SPINE.md AD-7]
  - [x] Inject `agentsRepo` into `connectionRoutes(...)` (it's already constructed in `app.ts`/`server.ts`); compute dependents via `agentsRepo.list()` + filter (no new repo method needed). Verify `connectionsRepo` exposes a `getProvider(id)` (or equivalent) to resolve the kind; if not, add a minimal read. **Preserve** the existing provider routes (list/connect/rotate-key/delete) + the whole Epic 1/2/3.1–3.5 surface.

- [x] **Task 2: Web client** (AC: #2)
  - [x] `apps/web/src/lib/connections.ts` — add `providerDependents(id): Result<{ id: string; name: string; state: string }[]>` (GET the endpoint above, `credentials:'include'`, discriminated result). Keep the existing provider/data-connection clients.

- [x] **Task 3: Guard provider removal with dependents** (AC: #2)
  - [x] In `apps/web/src/routes/(app)/settings/providers/+page.svelte`, enhance the existing arm→confirm Remove flow: when the user **arms** Remove for a provider, fetch its dependents; the confirm affordance then **names the consequence and lists the dependent agents** — e.g. "Remove OpenAI? 2 agents use it: Portfolio, Inbox — they'll have no model." (verb-first `Remove` to proceed, `Cancel` to back out). If there are **no** dependents, keep the current simple "Remove {name}?" confirm. Removal still goes through the existing `removeProvider` → `DELETE /connections/providers/:id`. Keep the error card + "No providers connected." behaviors. [Source: EXPERIENCE.md#Voice (cause→consequence→recovery), #Interaction-Primitives]
  - [x] **Data connections (Gmail) are out of scope for the guard:** no agent references a data connection yet (no agent→data-connection link exists — a later story). Leave the Data connections **Revoke** as-is; add a one-line code comment noting the dependent guard lands when agents can attach data connections.

- [x] **Task 4: Agents list — Lifecycle State + cost-meter placeholder** (AC: #1)
  - [x] In `apps/web/src/routes/(app)/agents/+page.svelte`, keep the existing per-row **name + `StatusDot`** (Lifecycle State, dot + word). Add — **only when `agent.state === "active"`** — a **cost-meter placeholder** at the end of the row: mono/tabular `today $0.00 / $<per-day cap>` using `formatMinor(agent.costCap.perDay.minor)` when a per-day cap is set (else `today $0.00 / —`). Live spend is Epic 4 (the `$0.00` is a static placeholder — comment it). Draft agents show **no** meter. Preserve the empty state, `/`-focus filter, loading/error/Retry, and row navigation to `/agents/:id`. [Source: DESIGN.md#components.cost-meter; EXPERIENCE.md Flow-1 step-7]

- [x] **Task 5: Tests + verification** (AC: all)
  - [x] **Unit (control-api, Vitest, in-memory repos + real session):** `GET /connections/providers/:id/dependents` — returns agents whose `model` matches the provider kind (`openai/…` → an OpenAI provider), **excludes** non-matching agents, `[]` when none, **404** for an unknown provider id, **401** without a session. (Seed agents via `POST /agents` + `PATCH { model }`.)
  - [x] **Playwright e2e (live stack, serial — append to `tests/agents.spec.ts`):** create an agent and set its model to `openai/gpt-4o` (via `page.request.patch` with the session cookie, since no provider is connected to select from in e2e); connect a **bogus** OpenAI provider on the providers page (created with `error` status); **arm Remove** → the confirm **surfaces the dependent agent** (names it); **Cancel** leaves it; **Remove** deletes the provider. Also assert the **agents list** shows the agent with its **draft** status and **no** cost meter (meter is Active-only).
  - [x] `svelte-check` 0 · `pnpm -r build` · `pnpm lint` · control-api unit · e2e incl. **Epic 1/2/3.1–3.5 regressions** all green.

### Review Findings (joint 3.4 + 3.5 + 3.6 code review, 2026-08-01)

_Blind Hunter + Edge Case Hunter + Acceptance Auditor over `ef6c5c3..HEAD`. 7 patch, 5 deferred, 3 dismissed. Auditor confirmed broad AC compliance (rectangular chips, default-deny scope, off-by-default send, mono caps, advisory dependents guard, AD-7, contracts untouched)._

- [x] [Review][Patch][Med] Debounced saves fire against the wrong agent after fast navigation — the section debounce timers (name/instructions/vars/**caps**) aren't cleared on an `id` change, and `persist` uses the current route `id`; edit a cap then open a different agent within ~400ms → the pending timer PATCHes agent B with agent A's cost cap. Clear all pending timers when `id` changes (and/or capture the target id at schedule time). [apps/web/src/routes/(app)/agents/[id]/+page.svelte]
- [x] [Review][Patch][Med] Cost-cap inline error is not associated with its field nor announced (3.5 AC2 requires "associated + announced") — the input has `aria-invalid` but no `aria-describedby`, and the error has no `id`/`role="alert"`. Add `id` + `aria-describedby` + a polite alert region. [apps/web/src/lib/components/CostCapsEditor.svelte]
- [x] [Review][Patch][Med] Provider-dependents fetch failure fails open — `armRemove` only sets `dependents` on `r.ok`; on a transient error it shows the plain "Remove {name}?" with no consequence, defeating the guard. Track a fetch-failed state and say so ("Couldn't check which agents use it — remove anyway?") instead of a clean confirm. [apps/web/src/routes/(app)/settings/providers/+page.svelte]
- [x] [Review][Patch][Med] CostCapsEditor `$effect` re-seeds the *other* field on every keystroke and leaves a stale error — because `onCapsChange` sets `costCap` synchronously, the adopt-external effect runs on each edit, overwriting an in-progress (invalid) entry in the non-focused field and leaving its `*Error` + `aria-invalid` stale. Only adopt when the persisted side actually changed (track last-adopted), and clear that field's error when re-seeding. [apps/web/src/lib/components/CostCapsEditor.svelte]
- [x] [Review][Patch][Low] `parseMoney` accepts any 3-letter uppercase currency (and mismatched per-run/per-day) despite MVP USD-only; the web always renders `$`, so a non-USD stored cap misrenders. Restrict `currency` to `"USD"` (MVP) with a stated 400. [apps/control-api/src/agents/routes.ts]
- [x] [Review][Patch][Low] `parseCostCap` accepts an array body (`typeof [] === "object"`) → `{ costCap: [] }` returns 200 and silently clears both caps. Reject non-plain-object / array with 400. [apps/control-api/src/agents/routes.ts]
- [x] [Review][Patch][Low] Skill picker: `Esc` only closes from the search input, and focus is dropped to `<body>` after attach — move Esc handling to the popover container and restore focus to the "Add skill" button on close/attach. [apps/web/src/lib/components/SkillsEditor.svelte]
- [x] [Review][Defer][Low] Dependents matched by provider **kind**, not connection id — with two same-kind providers, removing either falsely warns "they'll have no model." Refining needs the agent's `model` to carry a connection id (a design change); deferred (typically one provider per kind at MVP).
- [x] [Review][Defer][Low] `SkillId` (web) duplicates domain `BuiltinSkill`, and control-api's `BUILTIN_SKILLS` is a third copy — three sources of truth for the four skill ids. Deferred (web is intentionally decoupled from `@turanga/domain`); fold into the shared-type-consolidation cleanup.
- [x] [Review][Defer][Low] Partial `costCap` PATCH nulls the omitted side (whole-object replace) — fine for the in-app editor (always sends both) but a partial writer loses the other cap silently. Deferred; document costCap as a replace-whole field.
- [x] [Review][Defer][Low] Dependents string concatenates all agent names unbounded and scans the full agent list per arm — fine at MVP scale; cap/paginate later.
- [x] [Review][Defer][Low] A `$0.00` (minor 0) cap is accepted and formatted identically to an unset cap — a zero ceiling is a legitimate (if useless) value; revisit when caps are enforced (Epic 4).

## Dev Notes

**Last Epic 3 story — central management + the connection-removal guard. Build: the provider-dependents endpoint + client, the enhanced provider-removal confirm that surfaces dependent agents, and the agents-list cost-meter placeholder for Active agents. Do NOT build: the live cost-meter spend (Epic 4), Activate/Deactivate (Story 5.1), the Allowlist, a data-connection dependent guard (no agent→data-connection link exists yet), or Delete-agent. No schema change — this story reads existing `model` + `costCap`. No new external tech.**

### Architecture / constraints
- **AD-7 single-writer:** `control-api` owns Agent + Connection state; the dependents query is a read across both (control-api owns both). Removal still goes through the existing guarded `DELETE`. [ARCHITECTURE-SPINE.md AD-7]
- **Dependency model:** an agent references a model-provider connection through its selected `model` = `"<providerKind>/<modelId>"` (the `ModelSelector` emits `${kind}/${m}`, Story 3.2). So dependents of a provider = agents whose `model` starts with `"<kind>/"`. This is the "once agents can reference connections" link that Story 2.3 deferred here. [2-2/2-3, 3-2]
- **AD-8:** the agents list shows resting states **Draft**/**Active**; only Active agents get the meter. Activate itself is Story 5.1 — no agent is Active yet, so the meter is scaffolding that renders once 5.1 lands. [ARCHITECTURE-SPINE.md AD-8]
- **Advisory guard, not a hard block:** surfacing dependents is a safety prompt before a destructive action (EXPERIENCE.md#Interaction-Primitives) — the builder can still proceed (`Remove`). It is not an enforcement boundary. [EXPERIENCE.md#Interaction-Primitives]
- **Conventions:** status never colour-only (dot + word) — reuse `StatusDot` for listed dependents if shown; cap amounts in mono/tabular; verb-first sentence-case copy; `Esc` closes dialogs; visible focus ring; no motion. [ARCHITECTURE-SPINE.md#Conventions; DESIGN.md; EXPERIENCE.md#Accessibility]

### UX specifics (DESIGN.md / EXPERIENCE.md — Warm Ink baseline wins on conflict)
- **Removal guard:** "**Destructive/irreversible actions** (Remove connection, Delete agent, Deactivate, Revoke) confirm in a dialog naming the consequence; **removing a connection in use first surfaces the dependent agents**." The existing providers page uses an **inline arm→confirm** (not a modal dialog) — acceptable; keep that pattern and inject the dependents + consequence into it (a modal is not required by the spine, only "naming the consequence"). [EXPERIENCE.md#Interaction-Primitives L83]
- **Copy:** cause→consequence→recovery; the affirmative verb is **`Remove`** (provider) — "Remove anyway" is *not* verbatim in the spine, so phrase it as `Remove` + the consequence. Sentence case, no exclamation/emoji. [EXPERIENCE.md#Voice]
- **`cost-meter`:** "Live meter (mono/tabular) … per Active agent in the agents list: `today $0.0413 / $5.00`." Mono ≥ 12px, `tabular-nums`. Neutral styling (no colour) until near a cap; live spend + the near-cap/killed states are Epic 4. [DESIGN.md#components.cost-meter, #Typography]
- **Connection status** stays dot + word (existing). Agents-list rows keep dot + word for Lifecycle State. [DESIGN.md#Colors L98–99; EXPERIENCE.md#Accessibility]
- **Spec gaps (do not over-invent):** the spine does not detail how the dependents list renders inside the confirm — keep it minimal (name the agents inline). No "Remove anyway" label. No modal is mandated.

### Files being modified (READ current state — preserve behavior)
- **`apps/control-api/src/connections/routes.ts` (UPDATE):** add the dependents endpoint; take an injected `agentsRepo`. Preserve list/connect/rotate-key/delete.
- **`apps/control-api/src/app.ts` (UPDATE):** pass `agentsRepo` into `connectionRoutes(...)`. Preserve all wiring.
- **`apps/control-api/src/connections/repo.ts` (READ; maybe UPDATE):** confirm a way to read one provider (kind) by id; add a minimal `getProvider(id)` only if missing.
- **`apps/web/src/lib/connections.ts` (UPDATE):** add `providerDependents(id)`.
- **`apps/web/src/routes/(app)/settings/providers/+page.svelte` (UPDATE):** enhance the arm→confirm Remove to fetch + surface dependents. Preserve connect/rotate/error-card/empty-state.
- **`apps/web/src/routes/(app)/agents/+page.svelte` (UPDATE):** add the Active-only cost-meter placeholder. Preserve empty/loading/error, filter, `StatusDot`, row nav.
- **`apps/web/tests/agents.spec.ts` (UPDATE):** append the 3.6 e2e (one file → serial ordering; the 3.1 empty-state stays first). May also touch `providers.spec.ts` only if a regression assertion needs it — prefer agents.spec.
- **NO** migration, domain, or contracts change.

### Previous-story intelligence (Epics 1–3.5)
- **Providers page (2.1):** already has `confirmRemoveId` arm→confirm with a `.danger` Remove + `.ghost` Cancel, an error card, and "No providers connected." Reuse this; add a dependents fetch on arm. `removeProvider(id)` → `DELETE /connections/providers/:id`. [2-1]
- **Agents list (3.1):** rows are `a.agent` links with name + `StatusDot`; `listAgents()` returns full agents incl. `model` + `costCap` (3.5). `StatusDot` maps draft/active. `formatMinor` from `$lib/money.ts` formats cents → `"5.00"`. [3-1, 3-3, 3-5]
- **control-api route factories:** `connectionRoutes(connectionsRepo, gateway)` is mounted in `app.ts` behind `requireSession`; agents use `ulid`, `list()` returns newest-first with `model`. Tests use `app.request` with a real login session; the login limiter keys on `x-forwarded-for` — give each `appWithSession` a distinct IP (already done in agents.test). [2-1, 3-4]
- **E2E:** serial (`workers:1`), all agent e2e in `tests/agents.spec.ts`; `page.request` shares the browser's session cookie (use it to PATCH an agent's model, since no provider is connectable in e2e). Bogus-key provider connect yields an `error`-status provider that still exists (removable). [2-1, 3-2]
- **Known deferrals (do not reopen):** same-ms ordering, `state` CHECK, vacuous single-writer test, native-select model deviation, autosave-indicator polish, Retry button, domain/repo nullability, `x-forwarded-for` limiter, skills/caps enforcement (Epic 4) (`deferred-work.md`).

### Testing standards
- **Unit (control-api):** dependents endpoint — matches by kind, excludes non-matching, `[]` when none, 404 unknown provider, 401 no session. In-memory repos.
- **E2E (Playwright, live stack, serial):** set an agent's model via `page.request`; connect a bogus provider; arm Remove → dependents surfaced (agent named); Cancel keeps it; Remove deletes. Agents list shows draft status + no meter.
- `svelte-check` 0, build 6/6, lint clean, Epic 1/2/3.1–3.5 regressions green.
- **DoD:** agents list shows every agent + Lifecycle State + (Active-only) cost-meter placeholder; removing a provider referenced by agents surfaces the dependents before confirm; reads existing model/costCap (no schema change); regressions intact; only permitted surfaces modified. NO live-meter/Activate/allowlist/data-connection-guard/delete-agent.

### Project Structure Notes
- Modified (control-api): `connections/routes.ts`, `app.ts` (+ maybe `connections/repo.ts`), `connections/connections.test.ts` (or a new dependents test). Modified (web): `lib/connections.ts`, `settings/providers/+page.svelte`, `(app)/agents/+page.svelte`, `tests/agents.spec.ts`. No new packages; no migration; contracts/domain untouched. [ARCHITECTURE-SPINE.md#Structural-Seed, AD-7]

### References
- [Source: _bmad-output/planning-artifacts/epics.md#Epic-3 / Story-3.6 + Story-2.3 (guard deferral); FR-15]
- [Source: ARCHITECTURE-SPINE.md AD-7, AD-8, #Conventions]
- [Source: ux-designs/ux-turanga-2026-07-30/DESIGN.md#components.cost-meter/#connection-card/#agent-status-dot, #Elevation (confirm dialog --shadow-md), #Typography]
- [Source: ux-designs/ux-turanga-2026-07-30/EXPERIENCE.md#Interaction-Primitives (dependents guard), #Voice, #State-Patterns, #Accessibility, Flow-1]
- [Source: _bmad-output/implementation-artifacts/2-1-model-providers.md + 3-1-create-agent.md + 3-5-cost-caps.md (providers-page/agents-list/money patterns); deferred-work.md]

## Dev Agent Record

### Agent Model Used
claude-opus-4-8[1m]

### Debug Log References
- Injecting `agentsRepo` into `connectionRoutes` required moving its construction above the `connectionRoutes(...)` call in `app.ts`.
- Added a distinct `x-forwarded-for` per session to `connections.test.ts`'s `appWithSession` (as agents.test already does) so the added dependents tests don't push the run past the login rate limiter.

### Completion Notes List
- **Task 1** — `GET /connections/providers/:id/dependents` (behind requireSession): resolves the provider's kind via `connectionsRepo.getProvider` (404 if unknown), then returns agents whose `model` starts with `"<kind>/"` (id, name, state). `connectionRoutes(repo, gateway, agentsRepo)` now takes `agentsRepo`; `app.ts` constructs `agentsRepo` first and passes it in. No new repo method — filters `agentsRepo.list()`.
- **Task 2** — web `providerDependents(id)` client (discriminated result; `Array.isArray` guard) + `DependentAgent` type.
- **Task 3** — providers page: `armRemove(id)` fetches dependents on arm; the confirm now names the consequence and lists the dependent agents ("N agents use it (…) — they'll have no model") when any, else the simple "Remove {name}?". Removal still goes through `removeProvider`. Data-connections Revoke left as-is with a comment noting the guard lands when agents can attach data connections.
- **Task 4** — agents list: each row keeps name + `StatusDot`; **Active** agents additionally show a mono/tabular cost-meter placeholder `today $0.00 / $<per-day cap>` (live spend is Epic 4). Draft agents show no meter. Empty/filter/nav preserved.
- **Task 5** — control-api unit +4 (dependents: matches by kind, excludes others, `[]` when none, 404 unknown, 401) → **59/59**. E2E +1: set an agent's model via `page.request`, connect a bogus provider, arm Remove → dependent surfaced, Cancel keeps, Remove deletes; agents list shows draft status + no meter → **15/15**.
- **Verification** — `pnpm -r build` 6/6, `pnpm -r test` all green (control-api 59), `pnpm lint` clean, `svelte-check` 0, live-stack Playwright 15/15 against a fresh docker stack. No schema/migration/domain/contracts change.

**Documented deferrals/decisions:** the dependency link is agent→model-provider (via `model` = `"<kind>/…"`); **data connections have no agent link yet**, so their Revoke has no dependent guard (deferred to when agents attach data connections). The guard is **advisory** (the builder can still Remove), per the spine. The cost-meter is a **placeholder** (live spend + near-cap/killed states are Epic 4); no agent is Active until Story 5.1, so it renders only once Activate lands.

### File List
- MOD `apps/control-api/src/connections/routes.ts` (dependents endpoint + agentsRepo param)
- MOD `apps/control-api/src/app.ts` (construct agentsRepo first; pass into connectionRoutes)
- MOD `apps/control-api/src/connections/connections.test.ts` (+4 dependents tests; distinct-IP login)
- MOD `apps/web/src/lib/connections.ts` (providerDependents + DependentAgent)
- MOD `apps/web/src/routes/(app)/settings/providers/+page.svelte` (armRemove + dependents in confirm)
- MOD `apps/web/src/routes/(app)/settings/connections/+page.svelte` (comment: guard lands later)
- MOD `apps/web/src/routes/(app)/agents/+page.svelte` (Active-only cost-meter placeholder)
- MOD `apps/web/tests/agents.spec.ts` (+ removal-guard / agents-list e2e)

### Change Log
- 2026-08-01 — Story 3.6 implemented: provider-dependents endpoint + removal guard surfacing dependent agents before confirm, and the agents-list Active cost-meter placeholder. Epic 3 complete. Status → review.
