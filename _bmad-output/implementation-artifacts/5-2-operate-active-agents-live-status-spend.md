---
baseline_commit: 33deffc8b0bf59ff3dbc19a1028b5d29bd24f3e2
---
# Story 5.2: Operate active agents — live status and spend

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As the builder,
I want to see all my agents' live status and spend,
so that I can trust what's running without babysitting it.

## Acceptance Criteria

1. **Given** Active agents, **when** the agents list is viewed, **then** each shows **live Lifecycle State (dot + word)** and a **live cost meter (daily spend vs per-day cap)** in **mono/tabular**. [Source: epics.md#Story-5.2 AC1, FR-15, FR-12, UX-DR4, UX-DR11, UX-DR20, DESIGN.md#cost-meter]
2. **Given** an active run, **when** it executes, **then** it runs under the **same Sandbox, Guard, and caps as Test**, with **refusals and metrics recorded**. [Source: epics.md#Story-5.2 AC2, NFR-1, NFR-2, NFR-4, E4-AD-8, E4-AD-10]

## Tasks / Subtasks

- [x] **Task 1: Batch daily-spend read (control-api, read-only per AD-6/AD-7)** (AC: #1)
  - [x] `apps/control-api/src/runs/repo.ts` — add `sumTodayMicrosByAgent(): Promise<Record<string, number>>` to the `RunsRepo` interface and both impls. **Drizzle:** one query — `select({ agentId: runs.agentId, total: sql\`coalesce(sum(${runs.costMicros}), 0)\` }).from(runs).where(gte(runs.createdAt, startOfUtcToday())).groupBy(runs.agentId)` → fold rows into a `Record<agentId, Number(total)>`. **Memory:** iterate the in-memory rows, filter `createdAt >= startOfUtcToday()`, accumulate per `agentId`. Reuse the existing `startOfUtcToday()` helper — **same UTC-midnight window as `sumTodayMicros`** so the list and the agent-detail meter show the identical "today" number (no split-brain). Agents with no runs today are simply absent from the map (the caller defaults them to 0).
  - [x] `apps/control-api/src/runs/routes.ts` — add a **batch** endpoint `GET /agents/cost` → `c.json({ costs: await repo.sumTodayMicrosByAgent() })`. It lives in the runs routes (which own `RunsRepo`) alongside the existing per-agent `GET /agents/:id/cost`, and is already session-guarded by `app.use("/agents/*", requireSession)`. **Register `/agents/cost` BEFORE `/agents/:id/cost`** is not required (distinct path, `cost` is a static segment not an `:id` param) — but verify Hono routes `GET /agents/cost` to the batch handler and not the `:id` one; if there's any ambiguity, keep the batch path unambiguous.
  - [x] Cost stays **read-only everywhere** (AD-6: "nobody writes spend — litellm owns it, all others read"; the runs-table `cost_micros` is the summed Guard metrics, drift-free vs the persisted Run summary per FR-12). Do NOT recompute or write spend here.

- [x] **Task 2: Batch cost client (web)** (AC: #1)
  - [x] `apps/web/src/lib/runs.ts` — add `getAgentsCost(): Promise<Record<string, number>>` — GET `${base}/agents/cost` with `credentials: "include"`; on `!r.ok` or a parse failure return `{}` (best-effort, mirroring the existing per-agent `getAgentCost` which returns `null` on failure — the list must never white-screen because a spend read failed). Returns the `{ costs }` map's `costs`, or `{}`.
  - [x] Keep the existing per-agent `getAgentCost` (still used by the detail page) untouched.

- [x] **Task 3: Live agents-list meter + live status (web)** (AC: #1)
  - [x] `apps/web/src/routes/(app)/agents/+page.svelte` — replace the hardcoded `today $0.00` placeholder (currently `<span class="meter">today $0.00 / {meterCap(agent)}</span>`) with the **real** meter:
    - Add `let costs = $state<Record<string, number>>({})`. In `load()` (or a companion `loadCosts()`), after fetching agents, also call `getAgentsCost()` and assign `costs`. A spend-read failure must NOT clear the agent list or surface an error — leave `costs` as-is / `{}` and render `today $0.0000` (a 0 read is indistinguishable from "no spend yet", which is fine).
    - Render the meter for **Active agents only** (unchanged gating: `{#if agent.state === "active"}`): `today {formatMicros(costs[agent.id] ?? 0)} / ${formatMinor(agent.costCap.perDay.minor)}` when `agent.costCap.perDay` is set; if an Active agent has no per-day cap (shouldn't happen — Activate is gated on it in 5.1 — but be defensive), show `today {formatMicros(costs[agent.id] ?? 0)}` with no denominator. Import `formatMicros, formatMinor` from `$lib/money` and `getAgentsCost` from `$lib/runs`.
    - **Mono/tabular:** the `.meter` rule already sets `font-family: var(--font-mono)` + `font-variant-numeric: tabular-nums` — keep it (or switch to the shared `.mono-num` class from `app.css` for consistency). `formatMicros` renders ≥4dp (e.g. `$0.0413`), matching DESIGN.md:72's `"today $0.0413 / $5.00"`.
  - [x] **Make it live (polling, not SSE).** The list currently fetches once on mount. Add a **visibility-aware poll**: an interval (**every 5s**) that re-runs the combined agents + costs refresh **only while the document is visible** (`document.visibilityState === "visible"`) and pauses when hidden; refresh once immediately on `visibilitychange → visible`. Clean up the interval + listener in `onDestroy` (and/or the effect's teardown). Polling refreshes **both** the cost map (ticking meter) **and** the agents array — so **Lifecycle State is live too** (an agent activated/deactivated on the detail page, or a run that changed nothing structural, reflects within one poll). Guard against overlapping in-flight polls (skip if a refresh is already running) and against clobbering the user's `filter` (filter is client-side over the refreshed array — preserve it).
    - Rationale for polling over SSE: no per-agent live-cost SSE stream exists (SSE is per-run in the test pane, E4-AD-7); no AD mandates SSE for the list; the runs-table sum only advances when a run reaches terminal, so sub-second liveness buys nothing. A 5s visible-only poll gives the "ticking, capped meter" feel (EXPERIENCE.md:105) at trivial cost. **SSE fan-out for the list is explicitly deferred** (note in deferred-work.md).
  - [x] **Near-cap tone (DESIGN.md:72 "Neutral until near a cap").** Add a small **web-local** helper (no domain rule — pure display) e.g. `meterTone(spendMicros, perDayCap: Money | null): "neutral" | "warn"` → `warn` when `perDayCap` is set and `spendMicros / 10_000 >= 0.8 * perDayCap.minor` (spend micros → cents is ÷10,000; **do NOT compare micros to cents directly** — the unit gap is 10,000×). Apply a warning color class to the meter text when `warn` (use a Warm Ink caution/near-cap token; **never color-only** — the numbers still read literally, satisfying NFR-6 / UX-DR15). Keep it minimal; the killed-state tone (DESIGN.md:72, `--state(agent-killed)` when a cap stops a run) is a detail refinement — a plain neutral/warn split is sufficient for AC1.

- [x] **Task 4: Assert the active-run invariant (AC2 — guardrail, no new machinery)** (AC: #2)
  - [x] **There is no separate production-run path in MVP** (confirmed 5.1 Task 3 + E4-AD-8): the single run establishment (mint per-run key → register run with Guard → create `--network=none` sandbox → stream; Guard is sole source of `metrics`+`refusal`, orchestrator merges + persists) is **state-agnostic** — it does not branch on `agent.state`. AC2 is therefore a **verification/assertion** concern: prove the guarantee holds for an Active agent, not build a new enforcement.
  - [x] Add a **control-api / orchestrator unit test** that runs an **Active** agent through the existing run path and asserts: (a) the run is established via the same Sandbox + Guard registration as a Draft (the code path does not read `agent.state` to decide sandboxing/guard/caps — grep/assert no `state`-conditional in the run establishment); (b) the Guard-reported `metrics` and any `refusal` are recorded on the persisted Run (NFR-4); (c) the run's summed cost lands in `cost_micros` and thus appears in `sumTodayMicros` / the batch `sumTodayMicrosByAgent` for that agent (closing the loop with AC1 — a completed Active run's spend shows on the list meter). Prefer extending the existing orchestrator/runs tests over inventing a new harness.
  - [x] Add a short **code comment** at the run-establishment site noting the invariant ("run path is state-agnostic — Draft and Active runs use identical Sandbox/Guard/caps; enforced by Story 5.2 AC2 test") so a future edit that adds a state branch trips the reviewer.

- [x] **Task 5: Tests + verification** (AC: all)
  - [x] **control-api unit:** `sumTodayMicrosByAgent` returns a per-agent map summed since UTC midnight (multi-agent, multi-run fixture; excludes yesterday's runs; agents with no runs today absent → default 0); `GET /agents/cost` → `{ costs }`, session-guarded (401 without a session). Give each `appWithSession` a distinct `x-forwarded-for` (the login rate-limiter, per prior stories). Plus the Task 4 active-run invariant test.
  - [x] **Web:** no new domain rule to unit-test; `meterTone` unit test (neutral vs warn boundary at 80% of per-day cap; unit conversion micros→cents; null cap → neutral) if it's a pure exported function.
  - [x] **Playwright e2e (live stack, serial — append to `tests/agents.spec.ts`):** create an agent → it's Draft → the list row shows the status dot + word **"draft"** and **no meter** (meter is Active-only). Then, on an agent set **Active** (activate via the API once a model+caps are set — or, since no provider is connectable in e2e, PATCH state is refused by 5.1's design, so drive activation through the `/activate` endpoint only if a connected provider exists; otherwise assert the **Draft** presentation deterministically and cover the Active meter via a seeded/stubbed path). Deterministic assertions without a connected provider: **(a)** a Draft agent shows dot+word, no meter; **(b)** the meter markup renders `today $…` mono/tabular for an Active agent **if** one can be made Active in the harness; **(c)** the list **polls** — assert the meter/status refreshes without a manual reload (e.g. change something via `page.request` and see the list reflect it within the poll window). Keep e2e to what's deterministic; a full live-spend tick needs a real model call (gated/manual, mirroring the run happy-path e2e).
  - [x] `svelte-check` 0 · `pnpm -r build` 6/6 · `pnpm lint` · all unit suites · e2e incl. Epic 1–5.1 regressions green · `docker compose down -v` teardown. **Run `pnpm -r build` after adding tests, before any Docker build** (tsc catches type errors `pnpm -r test` may not — prior-story lesson).

## Dev Notes

**Second Epic 5 story — the operability surface. Almost all the data plumbing already exists from Epic 4/5.1; 5.2 is predominantly a web/read task plus one batch endpoint. The agents list already renders a `StatusDot` (live from `agent.state`) and a hardcoded `today $0.00 / {cap}` meter *placeholder* for Active agents — 5.1 explicitly deferred the live meter here to 5.2. This story (a) wires that meter to real daily spend, (b) makes the list live via polling (so both the meter *and* the lifecycle dot update without a reload), and (c) asserts AC2's invariant that active runs use the identical Sandbox/Guard/caps as Test.**

**User decision (load-bearing fork, resolved):** the daily-spend meter sources its "today" number from the **runs-table sum** (`sumTodayMicros` / a new batch `sumTodayMicrosByAgent`), NOT LiteLLM `teamSpendMicros`. Rationale: immediate + drift-free against the persisted Run summary (satisfies FR-12's no-drift), and **identical to the number the agent-detail meter already shows** — a split-brain where the list and detail disagree on "today" would erode trust. The caveat (its UTC-midnight window can differ from LiteLLM's enforced per-agent 1-day budget window) is accepted; re-sourcing the meter from `teamSpendMicros` to match the *enforced* window **stays deferred** (deferred-work.md item from the 4.5 review — do NOT close it in 5.2).

### Architecture (the spines govern — binding)
- **AD-6 — LiteLLM owns spend, everyone else reads:** "nobody writes spend — litellm owns it, all others read." The meter is a **read** of the runs-table summary (itself the summed Guard-reported metrics). 5.2 writes nothing to spend and recomputes nothing. [Source: architecture-turanga-2026-07-31/ARCHITECTURE-SPINE.md#AD-6]
- **AD-7 — single writer:** control-api is the sole writer of Agent state; the orchestrator is the sole writer of Run state. 5.2 adds only **read** endpoints/queries. [Source: ...#AD-7]
- **AD-8 — lifecycle:** resting Agent states are Draft/Active (Test is an execution mode, not a resting state). The list renders the *resting* state (dot + word); the run lifecycle is separate and shown in the test pane. [Source: ...#AD-8]
- **E4-AD-10 — event provenance:** the harness emits only `turn`+`done`; the **Guard** reports `metrics` (cost/tokens) + `refusal` + 429-kill to the orchestrator, which merges both into the Run + SSE stream. "Cost and refusal truth is the Guard/litellm, never the harness." This is what makes AC2's "refusals and metrics recorded" already true for *any* run. [Source: epic-4-execution-plane/ARCHITECTURE-SPINE.md#E4-AD-10]
- **E4-AD-8 — one establishment order for every run:** mint per-run key → register run with Guard → create `--network=none` sandbox → stream. There is **no branch on agent state** — that's precisely why an Active run is guaranteed the same Sandbox/Guard/caps as Test (AC2). [Source: ...#E4-AD-8]
- **E4-AD-7 — run state persists; test pane streams via SSE relay:** SSE is the *test-pane* mechanism; the **agents list has no SSE** and none is mandated — a plain read/poll of the cost endpoint is consistent with the spine. [Source: ...#E4-AD-7]

### Requirements
- **FR-15:** "The agents view lists every Agent with its Lifecycle State and live cost meter (for Active agents)." — AC1 verbatim. [Source: prd.md#FR-15]
- **FR-12:** "The live meter reflects both the current Run's spend (vs per-run cap) and the day's cumulative spend (vs per-day cap), visible **wherever the Agent is operated**… The meter's reported spend for a completed Run matches the sum of its Run metrics (no silent drift)." — the list is a place the agent is operated → the **day's cumulative** half of the meter belongs here (per-run belongs to the detail/test pane). The no-drift clause is *why* we chose the runs-table sum. [Source: prd.md#FR-12]
- **FR-6:** state shown as dot + word, never color alone; a Draft cannot execute a production run. [Source: prd.md#FR-6]
- **NFR-1 (isolation), NFR-2 (egress fail-closed), NFR-4 (observability):** AC2's guarantees — already delivered by Epic 4's single run path; 5.2 asserts them for an Active agent. **NFR-6:** numbers mono/tabular, status never color-only. [Source: prd.md#NFR-1,2,4,6]

### UX (binding)
- **UX-DR4 (agents list surface):** "lists agents with lifecycle status (dot + word) and **live cost meter for Active agents**; empty state 'No agents yet.' + Create agent; `/` focuses filter." — all already present except the *live* meter. [Source: epics.md#UX-DR4]
- **UX-DR20 (live meter):** "current run vs per-run cap; day vs per-day cap — surfaced in agent-definition **and the agents list, mono/tabular**." The list shows the **day** half. [Source: epics.md#UX-DR20]
- **UX-DR11 (status dot):** 6–7px dot + word; running pulses 1600ms; never color-only. The list uses the resting-state `StatusDot` (draft/active) — no run-status pulse on the list. [Source: epics.md#UX-DR11]
- **DESIGN.md:72:** the exact list-meter shape — **"per Active agent in the agents list: 'today $0.0413 / $5.00'. Neutral until near a cap."** `formatMicros` gives the ≥4dp numerator; `formatMinor` the 2dp denominator. [Source: DESIGN.md#cost-meter]
- **DESIGN.md:105 / Do-Don't:** cost + cap amounts always render in IBM Plex Mono with `tabular-nums`. **DESIGN.md:101:** any button (n/a here — list is display-only, rows are links) is ink, not teal. [Source: DESIGN.md]

### Existing code seam (concrete anchors — read before touching)
- `apps/control-api/src/runs/repo.ts:28` — `sumTodayMicros(agentId)` (drizzle :89 / memory :129) + `startOfUtcToday()` (:32). **Add `sumTodayMicrosByAgent` beside it.**
- `apps/control-api/src/runs/routes.ts:38` — `GET /agents/:id/cost` → `{ todayMicros }`. **Add `GET /agents/cost` → `{ costs }` beside it.** `RunsRepo` is injected here (agents routes do NOT have it — keep the batch endpoint in runs routes).
- `apps/control-api/src/db/schema.ts:73` — `runs` table; `cost_micros integer NOT NULL DEFAULT 0` (:79) = summed run cost in micro-USD; persisted only at terminal via `orchestrator.finish()` → `setStatus(..., { costMicros })` (orchestrator.ts:120). **In-flight runs contribute 0 until terminal** — accepted for the list meter (a streaming run's live per-call cost is a detail/test-pane concern).
- `apps/web/src/routes/(app)/agents/+page.svelte:8` `meterCap()` + `:102` the `today $0.00` placeholder + `:207` the `.meter` mono/tabular styles. **This is the file AC1 mostly edits.** Fetch-once on mount today (`$effect → load()`), no polling.
- `apps/web/src/lib/runs.ts:56` — `getAgentCost(id)` (per-agent, best-effort → null). **Add `getAgentsCost()` (batch → `{}` on failure) beside it.** SSE `EventSource` pattern (the RunHub) lives here + in the detail page — the template if SSE is ever needed, but 5.2 uses polling.
- `apps/web/src/lib/money.ts` — `formatMinor` (cents→"1,234.56", **no $**) and `formatMicros` (micros→"$0.0413", **includes $**). Caps are `Money.minor` = cents; spend is micros; **÷10,000 to compare**.
- `apps/web/src/lib/components/StatusDot.svelte` — draft/active dot + word (already on the list, live from `agent.state`). No change needed; polling makes it "live."
- `apps/web/src/lib/agents.ts` — `Agent` type carries **no spend field**; the list joins spend from the separate batch call (do NOT add a spend field to `Agent` — keep the cost read out-of-band, consistent with AD-6/AD-7 read-model separation).

### Project Structure Notes
- Backend: one new repo method + one new read route, both beside their Story-4.5 siblings. No schema/migration change (the `runs.cost_micros` column + `startOfUtcToday` already exist). No writes → no AD-7/AD-6 concern.
- Web: edits concentrate in `agents/+page.svelte` (meter + polling) + one client fn in `runs.ts` + optional `meterTone` helper. `StatusDot`, `money.ts`, `Agent` type unchanged. The web still does **not** depend on `@turanga/domain` (browser-bundle constraint from 5.1) — `meterTone` is web-local display logic, nothing to mirror.
- Polling is visibility-aware and self-cleaning (`onDestroy`) — no background timer leaks; no new dependency.

### Testing standards
- Vitest for control-api (unit, both repo impls) + web (`meterTone` if pure). Playwright serial e2e against the live docker stack; distinct `x-forwarded-for` per `appWithSession` for the login limiter. After a `--build` e2e run, the two empty-DB tests can flake on stack warmup — clean pass procedure: `docker compose down -v` → `up -d` (no build) → poll `/health` → run e2e once (prior-story infra note).

### References
- [Source: _bmad-output/planning-artifacts/epics.md#Story-5.2, #UX-DR4, #UX-DR11, #UX-DR20]
- [Source: _bmad-output/planning-artifacts/prds/prd-turanga-2026-07-31/prd.md#FR-15, #FR-12, #FR-6, #NFR-1, #NFR-2, #NFR-4, #NFR-6]
- [Source: _bmad-output/planning-artifacts/architecture/architecture-turanga-2026-07-31/ARCHITECTURE-SPINE.md#AD-6, #AD-7, #AD-8]
- [Source: _bmad-output/planning-artifacts/architecture/epic-4-execution-plane/ARCHITECTURE-SPINE.md#E4-AD-7, #E4-AD-8, #E4-AD-10, #E4-AD-5]
- [Source: _bmad-output/planning-artifacts/ux-designs/ux-turanga-2026-07-30/DESIGN.md#cost-meter, #agent-status-dot]
- [Source: _bmad-output/implementation-artifacts/5-1-activate-deactivate-gating.md — StatusDot, web-mirrors-domain, deferred-to-5.2 meter]
- [Source: _bmad-output/implementation-artifacts/deferred-work.md — teamSpendMicros enforced-window item (stays deferred), /agents/:id/cost ownership check (single-user MVP)]

## Dev Agent Record

### Agent Model Used
claude-opus-4-8[1m]

### Debug Log References
- **Live meter source = runs-table (user decision).** `sumTodayMicrosByAgent()` (one `GROUP BY agent_id` query, same `startOfUtcToday()` window as `sumTodayMicros`) → new read-only `GET /agents/cost` → `{ costs }`. Identical "today" number to the detail meter (no split-brain). LiteLLM enforced-window refinement stays deferred.
- **Live = polling, not SSE.** The list `$effect` loads once then polls every 5s **only while `document.visibilityState === "visible"`** (paused when hidden; immediate refresh on becoming visible). Background `refresh()` never toggles the loading flag nor surfaces a transient error (a blip keeps the last-known list/costs), and guards against overlapping polls. The effect's teardown clears the interval + `visibilitychange` listener (Svelte 5 effect cleanup = the onDestroy path). Both the cost map **and** the agents array refresh, so the lifecycle dot is live too.
- **Unit gap.** `meterTone` converts spend micros → cents (÷10,000) before comparing to `perDayCap.minor`; unit-tested against the 10,000× trap. Warn tone uses the theme-aware `--caution-500` (never color-only — numbers still read literally).
- **e2e infra (two flakes, both resolved procedurally, not code):** (1) the full serial suite makes 22 logins > control-api's `RL_MAX=20`/60s per-key login throttle → the last test's signIn got 429'd. Fixed by giving each e2e `signIn` a distinct `x-forwarded-for` (network-level via `page.setExtraHTTPHeaders`), the same mitigation used for unit `appWithSession`. (2) The two pristine-DB-dependent tests flake on cold-start. Clean-pass procedure: `docker compose down -v` → `up -d` → **poll `POST /auth/login` (distinct XFF) until 200** (control-api migrate+seed done, not just `/health`) → **pre-warm Vite** (`npm run dev` + hit `/login`,`/agents`) so the first test doesn't pay route-compile → run once → **22/22**.

### Completion Notes List
- **AC1 (live status + spend on the agents list).** The hardcoded `today $0.00` placeholder is now the real meter: `today {formatMicros(spend)} / ${formatMinor(perDay)}`, mono/tabular (matching DESIGN.md:72 `today $0.0413 / $5.00`), Active-only, neutral→caution at 80% of the per-day cap. Spend comes from the batch `getAgentsCost()` (best-effort `{}` on failure — the list never white-screens). A visibility-aware 5s poll makes both the meter and the `StatusDot` lifecycle live without a reload.
- **AC2 (active runs = same Sandbox/Guard/caps as Test).** No new machinery: the run establishment is state-agnostic (nothing in `validateAndCreate`/`execute` branches on `agent.state`). Locked in with an INVARIANT comment at the establishment site + two orchestrator tests — an Active agent runs under the same Guard registration + sandbox with its refusal recorded, and its Guard-reported metrics/cost persist on the Run and roll into `sumTodayMicros`/`sumTodayMicrosByAgent` (closing the AC2→AC1 loop).
- **Read-only, single-source (AD-6/AD-7).** control-api only added read endpoints/queries; no schema change (the `runs.cost_micros` column + `startOfUtcToday` already existed); the web joins spend out-of-band (no spend field added to the `Agent` type).
- **Deferred, untouched:** SSE fan-out for the list; the LiteLLM-enforced-window meter source; the `/agents/*/cost` per-agent ownership check (single-user MVP). Added an SSE-deferral note to deferred-work.md.
- **Verification:** `pnpm -r build` 6/6 · `svelte-check` 0/0 · `pnpm lint` clean · unit — domain 3, web 17, contracts 9, egress-guard 23, agent-harness 4, control-api 103 (+1 skipped) · **22/22 Playwright e2e** on a fresh live stack incl. the new polling test · `docker compose down -v` teardown.

### File List
**Modified**
- apps/control-api/src/runs/repo.ts
- apps/control-api/src/runs/routes.ts
- apps/control-api/src/runs/orchestrator.ts
- apps/control-api/src/runs/runs.test.ts
- apps/control-api/src/app.test.ts
- apps/web/src/lib/runs.ts
- apps/web/src/lib/money.ts
- apps/web/src/lib/money.test.ts
- apps/web/src/routes/(app)/agents/+page.svelte
- apps/web/tests/agents.spec.ts
- apps/web/tests/providers.spec.ts
- apps/web/tests/health.spec.ts
- _bmad-output/implementation-artifacts/deferred-work.md

### Change Log
| Date | Change |
| --- | --- |
| 2026-08-03 | Story 5.2 implemented: batch daily-spend read (`sumTodayMicrosByAgent` + read-only `GET /agents/cost`), the live agents-list meter (real `today $X / $cap`, mono/tabular, Active-only, near-cap caution tone) refreshed by a visibility-aware 5s poll that also makes the lifecycle dot live, and the AC2 state-agnostic run-path invariant (comment + two orchestrator tests). e2e `signIn` given per-test `x-forwarded-for` to survive the login throttle across the full serial suite. Verified: build 6/6, svelte-check 0/0, lint clean, all unit suites, 22/22 e2e on a fresh live stack, no regressions. Status → review. |
