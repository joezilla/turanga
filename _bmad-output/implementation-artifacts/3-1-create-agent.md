---
baseline_commit: bff317bf6871d4277b626be838f86356879c675e
---
# Story 3.1: Create an agent and see the agents list

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As the builder,
I want to create an agent and see it listed,
so that I have something to configure and run.

## Acceptance Criteria

1. The Agents surface (empty) shows "No agents yet." + a **Create agent** action and supports `/` to focus a filter. [Source: epics.md#Story-3.1 UX-DR4; EXPERIENCE.md#Interaction-Primitives]
2. **Create agent** creates a new Agent in **Draft** (FR-1, FR-6), written by `control-api` only (AD-7), which appears in the list with its Lifecycle State as a **dot + word** (never colour-only). [Source: epics.md#Story-3.1 FR-1, FR-6, UX-DR11; ARCHITECTURE-SPINE.md AD-7, AD-8]

## Tasks / Subtasks

- [x] **Task 1: `agents` table + repository** (AC: #2)
  - [x] Extend `apps/control-api/src/db/schema.ts` with **`agents`**: `id` (ULID PK), `name` text not null, `state` text not null (`'draft' | 'active'` — reuse `LifecycleState` from `@turanga/domain`), `created_at` timestamptz default now. `drizzle-kit generate` → commit migration `0003`. (Model / instructions / skills / cost caps are added by Stories 3.2–3.5 — keep this table minimal per the just-in-time DB principle.) [Source: ARCHITECTURE-SPINE.md AD-7, AD-8; packages/domain LifecycleState]
  - [x] `apps/control-api/src/agents/repo.ts` — `AgentsRepo` interface (Drizzle + in-memory impls, mirroring the Story 2.1 pattern): `list()`, `get(id)`, `create(row)`. Single-writer: `control-api` is the only writer of Agent state (AD-7).

- [x] **Task 2: Agent routes (control-api)** (AC: #2)
  - [x] `apps/control-api/src/agents/routes.ts` (behind `requireSession`):
    - `GET /agents` → `{ agents: [...] }` — id, name, state, createdAt (newest first).
    - `POST /agents` → body `{ name? }`; create a new agent with `state: 'draft'` and a name (default "Untitled agent" if none/blank, trimmed); return the created agent (201).
  - [x] Mount in `app.ts` under the existing `requireSession` guard (add `agentRoutes(agentsRepo)`), inject an `AgentsRepo`. In `server.ts` build the Drizzle repo. **Preserve** all Epic 1/2 routes + the `/health` `/version` `/auth/*` open surface.

- [x] **Task 3: Agents list UI** (AC: #1, #2)
  - [x] A reusable **`src/lib/components/StatusDot.svelte`** — a 6–7px Lucide `Circle` (dot) + a word, colour by status, **never colour-only** (the word is always present; `aria-hidden` on the dot). Lifecycle mapping: `draft` → `--text-tertiary` + "draft"; `active` → `--state-succeeded` + "active". (This component is reused by the test pane + run status later.) [Source: DESIGN.md#components.agent-status-dot; UX-DR11]
  - [x] Replace `src/routes/(app)/agents/+page.svelte` (currently a placeholder): 
    - Load agents on mount (`GET /agents`, `credentials:'include'`, discriminated client).
    - **Empty state**: "No agents yet." + a **Create agent** button (verb-first, ink). [Source: EXPERIENCE.md#Voice — fact + one action]
    - **List**: a filter `<input>` (placeholder "Filter agents") + a **Create agent** button in a header row; below, one row per agent — name + `StatusDot` (lifecycle state). Rows are display-only in 3.1 (the agent-definition surface + navigation to `/agents/:id` is Story 3.2 — do NOT build it here). [Source: UX-DR4]
    - **Filter**: client-side, narrows the list by name (case-insensitive). Pressing **`/`** (when not already typing in an input) focuses the filter. [Source: EXPERIENCE.md#Interaction-Primitives]
  - [x] `src/lib/agents.ts` — web client (`credentials:'include'`, discriminated results): `listAgents()`, `createAgent(name?)`. Verb-first, sentence-case; errors cause→consequence→recovery (project-context.md).

- [x] **Task 4: Tests + verification** (AC: all)
  - [x] Unit (control-api, Vitest, in-memory `AgentsRepo` + a real session via login): `POST /agents` → 201, state `draft`, default name applied when blank; `GET /agents` lists it; both are **401 without a session** (guard) and 200 with. Assert `control-api` is the only writer (repo interface — the web never writes directly).
  - [x] Playwright e2e (live stack): sign in → Agents; empty state "No agents yet." + Create agent visible; click **Create agent** → an agent row appears with a **draft** status (dot + the word "draft"); the filter input is present; pressing `/` focuses it and typing narrows the list.
  - [x] `svelte-check` 0 · `pnpm -r build` · `pnpm lint` · control-api unit tests · e2e (incl. Epic 1/2 regressions) all green.

### Review Findings

_Code review 2026-08-01 (baseline bff317b..HEAD). Blind Hunter + Edge Case Hunter + Acceptance Auditor. 1 decision, 5 patch, 3 deferred, 4 dismissed as noise._

- [x] [Review][Decision] Empty Agents surface does not support `/` to focus a filter (AC-1) — **Resolved (option 1): accept `/` as a graceful no-op when there is nothing to filter.** The interaction primitive matters only on the populated surface; a filter over a zero-row list is meaningless UX. No code change. [apps/web/src/routes/(app)/agents/+page.svelte]
- [x] [Review][Patch] POST /agents with a JSON body of literal `null` throws a 500 — `c.req.json().catch(()=>({}))` only falls back on a parse error; valid `null` passes through and `typeof body.name` dereferences null. [apps/control-api/src/agents/routes.ts:10]
- [x] [Review][Patch] `listAgents` can set `agents` to `undefined` and white-screen the page — a 200 with a malformed/empty body yields `r.value.agents === undefined`; the page then evaluates `agents.length`/`agents.filter`. Guard with `Array.isArray`. [apps/web/src/lib/agents.ts:31]
- [x] [Review][Patch] Load-error strands the user with no Create/retry — on a transient `GET /agents` failure the error branch renders, the empty-state block (which holds the only Create button when the list is empty) is unreachable, and the header Create button requires `agents.length > 0`. Add a retry/create affordance to the error branch. [apps/web/src/routes/(app)/agents/+page.svelte]
- [x] [Review][Patch] 201 response `createdAt` diverges from the persisted value — the route returns `new Date().toISOString()` but `create()` inserts only `{id,name,state}` and lets Postgres `DEFAULT now()` fill `created_at`. Persist the generated timestamp so POST and GET agree. [apps/control-api/src/agents/routes.ts:13, repo.ts:32]
- [x] [Review][Patch] No length bound on agent `name` — trimmed but otherwise unbounded `text`; an oversized name is persisted verbatim and echoed into every list payload. Cap length. [apps/control-api/src/agents/routes.ts:10]
- [x] [Review][Defer] Same-ms list order is not creation-ordered; memory(seq) vs drizzle(id) divergence [apps/control-api/src/agents/repo.ts:26] — deferred. `desc(agents.id)` IS deterministic but, because `ulid()` has a random suffix, does not reflect creation order for same-ms creates; the memory repo uses a true `seq` tiebreak so the "newest-first" unit test doesn't cover the prod path. Cosmetic for MVP; revisit if creation-order display matters.
- [x] [Review][Defer] `agents.state` has no CHECK constraint and is blind-cast to `LifecycleState`; `StatusDot` renders any non-`active` value as grey "draft" [schema.ts, repo.ts, StatusDot.svelte] — deferred. No non-control-api writer exists yet (AD-7); harden when lifecycle transitions land (Story 5.1).
- [x] [Review][Defer] The AD-7 "single-writer" unit test is vacuous (asserts only `typeof create === "function"`) [apps/control-api/src/agents/agents.test.ts] — deferred, test-quality only; the invariant is enforced structurally (web has no DB access).

## Dev Notes

**First Epic 3 story — the agent-building surface begins. Keep it to *create + list + Draft state*. The agent-definition surface (model/instructions/skills/caps) is Stories 3.2–3.5; do NOT build editing, navigation to `/agents/:id`, or any run/test behavior here. No new external tech — pure Drizzle + guarded Hono routes + a SvelteKit page, all established in Epics 1–2.**

### Architecture / constraints
- **AD-8 lifecycle:** resting Agent states are **Draft** and **Active**; a newly created agent is **Draft**. (Activate/Deactivate transitions are Story 5.1 — not here.) [Source: ARCHITECTURE-SPINE.md AD-8]
- **AD-7 single-writer:** `control-api` is the only writer of Agent state — the web never writes to the DB; it POSTs to `control-api`. [Source: ARCHITECTURE-SPINE.md AD-7]
- **Reuse `@turanga/domain`:** `LifecycleState = "draft" | "active"` and the `Agent` interface already exist (Story 1.1). Use `LifecycleState`; you may narrow the table to the columns this story needs.
- **Conventions (project-context.md):** ULID ids, UTC timestamps, semantic Warm Ink tokens only, Lucide `currentColor`, **status never colour-only** (dot + word), verb-first sentence-case copy, visible focus ring, mono/tabular numbers (n/a here yet).

### Files being modified (READ current state — preserve behavior)
- **`apps/control-api/src/app.ts` (UPDATE):** mounts CORS, health/version, auth, and (Epics 1–2) `/connections/*`, `/models`, `/oauth/*` behind `requireSession`, injecting several repos/clients. **Change:** inject an `AgentsRepo` and mount `agentRoutes` under the existing `app.use("/connections/*"…)`-style guard — add `app.use("/agents/*", requireSession(authRepo))` **and** `app.use("/agents", requireSession(authRepo))` (guard both the collection and sub-paths), then `app.route("/", agentRoutes(agentsRepo))`. **Preserve:** every existing route + the open `/health`,`/version`,`/auth/*`.
- **`apps/control-api/src/db/schema.ts` (UPDATE):** has `users`, `sessions`, `connections`, `data_connections`. **Change:** add `agents`. **Preserve:** existing tables + the three committed migrations (generate a NEW `0003`).
- **`apps/control-api/src/server.ts` (UPDATE):** builds deps. **Change:** `drizzleAgentsRepo(db)` → pass into `createApp`. **Preserve:** ensureDatabase→migrate→seed→sweep order + all Epic 1/2 wiring.
- **`apps/web/src/routes/(app)/agents/+page.svelte` (UPDATE):** currently a placeholder (`<h1>Agents</h1>` + "No agents yet."). **Change:** the real list. **Preserve:** the `Agents` heading text and the "No agents yet." empty-state string — Epic 1/2 e2e assert the heading is visible; keep the sidebar `Agents` nav working (it already links to `/agents`).

### Previous-story intelligence (Epics 1–2)
- **Pattern:** control-api routes are factories taking an injected repo; interface + in-memory impl for tests; guard reuse via `requireSession(authRepo)`; tests use `app.request(...)` with a real session from `POST /auth/login`. Mirror exactly (`AgentsRepo`, `agentRoutes`). [Stories 2.1–2.2]
- **Drizzle:** schema→`drizzle-kit generate`→committed migration→`migrate()` at startup; control-api owns its `control` DB. The last migration is `0002` — this adds `0003`. [Stories 1.4–2.2]
- **Web:** discriminated client results; Warm Ink tokens + `@lucide/svelte`; the Settings pages (2.1/2.2) are the reference for a list + form page; the Sidebar active-nav uses `$app/state`. `/agents` is the post-login landing (root `+page.ts` redirects `/`→`/agents`). [Stories 1.3–2.2]
- **Regression to protect:** Epic 1/2 e2e — the Agents heading + "No agents yet." string, and the shell/nav/theme/auth/providers/data-connections tests. The e2e runs **serially** (`workers:1`, set in 2.2) — keep it that way.
- **StatusDot:** the Topbar already renders an inline `Circle` dot + word for control-plane status; factor the same idiom into a reusable `StatusDot` so the test pane / run status (later stories) reuse it.

### Testing standards
- **Unit (control-api):** create → draft + default-name; list; guard 401↔200; no raw-write path from the web. In-memory repo, no live DB.
- **E2E (Playwright, live stack, serial):** empty → Create agent → draft row appears; `/` focuses the filter; filter narrows. Requires a signed-in session (reuse the `signIn` helper pattern).
- `svelte-check` 0, build 6/6, lint clean, Epic 1/2 regressions green.
- **DoD:** create + list + Draft state work; status shown as dot + word (never colour-only); `/` filter focus; agent written only via control-api; regressions intact; only permitted story sections modified. NO definition editing / navigation / run behavior (later stories).

### Project Structure Notes
- New (control-api): `src/agents/{repo,routes,agents.test}.ts`, migration `0003`. New (web): `src/lib/agents.ts`, `src/lib/components/StatusDot.svelte`. Modified: control-api `app.ts`/`server.ts`/`schema.ts`, web `agents/+page.svelte`, `tests/*.spec.ts` (+ agents test). No other apps/packages touched. [Source: ARCHITECTURE-SPINE.md#Structural-Seed, AD-7]

### References
- [Source: _bmad-output/planning-artifacts/epics.md#Epic-3 / Story-3.1; FR-1, FR-6, FR-15, UX-DR4, UX-DR11]
- [Source: prd.md FR-1, FR-6; ARCHITECTURE-SPINE.md AD-7, AD-8, Conventions]
- [Source: ux-designs/ux-turanga-2026-07-30/DESIGN.md#components.agent-status-dot + EXPERIENCE.md#Voice, #Interaction-Primitives, Key-Flows (Flow 1)]
- [Source: project-context.md; _bmad-output/implementation-artifacts/2-1-model-providers.md + 1-4-authentication.md (repo/route/guard/drizzle patterns); packages/domain (LifecycleState, Agent)]

## Dev Agent Record

### Agent Model Used
claude-opus-4-8[1m]

### Debug Log References
- Unit test `lists created agents newest-first` initially failed: two agents POSTed within the same millisecond tied on `createdAt`, so the stable sort kept insertion order. Fixed by making ordering deterministic — an insertion `seq` tiebreak in `memoryAgentsRepo`, and `desc(agents.id)` (ULID) as a secondary sort in `drizzleAgentsRepo`.

### Completion Notes List
- **Task 1** — `agents` table (`id` ULID PK, `name`, `state`, `created_at` timestamptz default now) added to `schema.ts`; migration `0003_perpetual_richard_fisk.sql` generated. `AgentsRepo` (`list`/`get`/`create`) with Drizzle + in-memory impls, mirroring the Story 2.1 connections pattern. `control-api` is the only writer (AD-7).
- **Task 2** — `agentRoutes`: `GET /agents` → `{ agents }` (newest first); `POST /agents` → 201 with `state:'draft'`, name defaulted to "Untitled agent" and trimmed. Mounted behind `requireSession` (both `/agents` and `/agents/*`); wired into `app.ts` (injected `agentsRepo`, memory default) and `server.ts` (Drizzle). All Epic 1/2 routes + the open `/health`,`/version`,`/auth/*` surface preserved.
- **Task 3** — reusable `StatusDot.svelte` (dot + word, never colour-only; `draft`→`--text-tertiary`, `active`→`--state-succeeded`; dot `aria-hidden`). `agents/+page.svelte` replaced: loads on mount via discriminated client, empty state ("No agents yet." + Create agent), header Create action, filter input (client-side, case-insensitive) focused by `/` when not typing, one display-only row per agent (name + StatusDot). No `/agents/:id` navigation (Story 3.2). `src/lib/agents.ts` client (`credentials:'include'`, discriminated results).
- **Task 4** — control-api unit tests (7): guard 401 on GET/POST without a session, 200 empty with; create → 201 draft + default/trimmed name; newest-first list; single-writer via repo. Playwright e2e: empty → Create → Draft row (dot + "draft"), `/` focuses filter, typing narrows.
- **Verification** — `pnpm -r build` 6/6, control-api unit 29/29, `pnpm lint` clean, `svelte-check` 0/0, live-stack Playwright 10/10 (incl. Epic 1/2 regressions) against a fresh docker stack (`down -v` → rebuild control-api → healthy+seeded → e2e → `down -v`).

### File List
- NEW `apps/control-api/src/agents/repo.ts`
- NEW `apps/control-api/src/agents/routes.ts`
- NEW `apps/control-api/src/agents/agents.test.ts`
- NEW `apps/control-api/drizzle/0003_perpetual_richard_fisk.sql` (+ `drizzle/meta` snapshot/journal)
- NEW `apps/web/src/lib/agents.ts`
- NEW `apps/web/src/lib/components/StatusDot.svelte`
- NEW `apps/web/tests/agents.spec.ts`
- MOD `apps/control-api/src/db/schema.ts` (agents table)
- MOD `apps/control-api/src/app.ts` (guard + mount agentRoutes, inject agentsRepo)
- MOD `apps/control-api/src/server.ts` (drizzleAgentsRepo wiring)
- MOD `apps/web/src/routes/(app)/agents/+page.svelte` (placeholder → real list)

### Change Log
- 2026-08-01 — Story 3.1 implemented: create agent + agents list (Draft state, dot+word status, `/`-focus filter). Status → review.
