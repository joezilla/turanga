---
baseline_commit: 8fa5c471e48fff1bda3f9d51f820aa70b86483eb
---
# Story 5.3: Run history and observability

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As the builder,
I want to review what an agent did and what was blocked,
so that I can always answer "what happened."

## Acceptance Criteria

1. **Given** an agent with past runs, **when** its history is viewed, **then** each Run shows its **transcript, metrics, and any Guard/permission refusals**. [Source: epics.md#Story-5.3 AC1, NFR-4, FR-3/FR-8/FR-18, UX-DR7, UX-DR23, E4-AD-7, E4-AD-10]
2. **Given** a killed or failed run, **when** reviewed, **then** the **outcome and cause** (cap breach, blocked egress, error) are **legible**. [Source: epics.md#Story-5.3 AC2, NFR-4, AD-8, E4-AD-5/E4-AD-8, EXPERIENCE.md#Voice-and-Tone]

## Tasks / Subtasks

- [x] **Task 1: Run-summary read model (control-api, read-only per AD-7)** (AC: #1)
  - [x] `apps/control-api/src/runs/repo.ts` — add a lightweight `RunSummary` type (`id, agentId, status, reason, costMicros, taskInput, createdAt, endedAt` — **everything except the heavy `transcript`**) and a `listSummary(agentId?, limit?): Promise<RunSummary[]>` method to `RunsRepo` + both impls (drizzle: `select` only the summary columns, `orderBy(desc(createdAt), desc(id))`, `where agentId` when given, bound by `DEFAULT_LIST_LIMIT = 100`; memory: map the newest-first `order` to summaries). **Keep the existing `list()`** (still used by the repo unit tests) — `listSummary` is additive.
  - [x] `apps/control-api/src/runs/routes.ts` — change `GET /runs` to return **summaries**: `c.json({ runs: await repo.listSummary(c.req.query("agentId")) })`. This drops the full transcript from the LIST payload (the review view fetches the full run via the existing `GET /runs/:id`). **Verified safe:** `GET /runs` has no current web consumer and no HTTP-shape test asserts its body (only the repo `list()` unit test exists, which is untouched). `GET /runs/:id` (full run incl. transcript + reason) and `GET /runs/:id/events` (SSE) are unchanged. Session-guarded via `/runs*` in app.ts.
  - [x] Read-only (AD-7: orchestrator is the sole writer of Run state). No schema change (the `runs` table already carries `status`, `reason`, `costMicros`, `transcript`, `createdAt`, `endedAt`); no write path.
  - [x] Single-user MVP: `GET /runs` / `GET /runs/:id` have **no agent-ownership check** (any session reads any run). Do NOT add one — it's the deferred multi-tenancy item; note it in code only if a comment already flags it.

- [x] **Task 2: Run-history web clients + a timestamp helper** (AC: #1, #2)
  - [x] `apps/web/src/lib/runs.ts` — add `RunSummary` (mirror the server shape: `id, agentId, status: RunStatus, reason: string | null, costMicros: number, taskInput: string, createdAt: string, endedAt: string | null`) and `listRuns(agentId): Promise<RunSummary[]>` — `GET ${base}/runs?agentId=…` with `credentials: "include"`; **best-effort → `[]`** on `!r.ok`/parse failure (a read blip must not white-screen the history — the 5.2 pattern). Reuse the existing `getRun(id)` (already returns the full `Run` incl. `transcript` + `reason`) for the single-run review — do NOT add a new detail client.
  - [x] Add `apps/web/src/lib/datetime.ts` — `formatTimestamp(iso: string): string` rendering a UTC ISO-8601 string as a readable local absolute time (e.g. `Intl.DateTimeFormat`/`toLocaleString("en-US", { dateStyle, timeStyle })`); guard an empty/invalid input to `""`. Mirror `money.ts` as the small-`$lib`-helper precedent. (Timestamps render in mono per DESIGN.md's IDs/metrics convention.) Add a matching `datetime.test.ts`.

- [x] **Task 3: Widen `RunStatusDot` to the full run lifecycle** (AC: #1)
  - [x] `apps/web/src/lib/components/RunStatusDot.svelte` — the prop is currently `Exclude<RunStatus, "created">`; a history row can be `created` (a run that never reached running). Widen the prop to the full `RunStatus` and map `created` to a **neutral** appearance (dot + the word `created`, a neutral token like `--state-idle`/`--text-tertiary` — never color-only, UX-DR11/NFR-6). Keep `running` pulsing + the existing succeeded/failed/killed mapping. The test pane passes only the non-`created` states, so its behavior is unchanged.

- [x] **Task 4: Extract a shared `RunTranscript` renderer (DRY the transcript rows)** (AC: #1)
  - [x] Add `apps/web/src/lib/components/RunTranscript.svelte` — props `{ transcript: RunMessage[] }` — renders the control-channel rows the review + test pane share: **`turn`** (role + `turn-text`), **`refusal`** (caution dot + a **kind-aware label** — `egress → "Blocked egress"`, `permission → "Permission denied"` — plus the `detail`; this makes "any Guard/permission refusals" legible per AC1 and adds the `kind` the test pane currently drops), and **`metrics`** rows inline (`{latencyMs} ms · {tokens} tokens · {formatMicros(costMicros)}`, `.mono-num`) so a multi-call run's per-call metrics are all visible (observability). Reuse the exact existing classes (`.turn`, `.turn-role`, `.turn-text`, `.refusal`, `.metrics`) + tokens (`--state-killed` for the refusal dot). `done` renders nothing (the terminal state is shown by the caller's status dot).
  - [x] `apps/web/src/routes/(app)/agents/[id]/+page.svelte` — replace the **inline `turn`/`refusal` loop** in the test pane with `<RunTranscript transcript={transcript} />`, **preserving all live behavior** (SSE streaming, `runGen` guard, the resolution block with `RunStatusDot` + last-metrics, `runReason`, the cost-meter, the empty/running/error states, Clear/Cmd+Enter, the `<1024px` Test toggle). The test pane keeps its resolution/last-metrics summary; only the turn/refusal rows move into the component. The existing test-pane e2e proves no regression.

- [x] **Task 5: Run-history LIST route + entry point** (AC: #1, #2)
  - [x] `apps/web/src/routes/(app)/agents/[id]/runs/+page.svelte` (NEW) — on mount, `listRuns(id)`; render newest-first rows, each a link to `/agents/{id}/runs/{run.id}` showing: `RunStatusDot status={run.status}` (dot + word — the **outcome**, AC2), `formatTimestamp(run.createdAt)` (mono), `formatMicros(run.costMicros)` (mono), and a one-line `taskInput` preview (truncated). For a `killed`/`failed` row, the **reason is legible** — show a truncated `run.reason` on the row (AC2) with the full text on the review page. **Empty state:** "No runs yet." + a link back to the agent / *Run test* (EXPERIENCE.md:52, fact + one action). A load failure shows a stated, retryable error (best-effort client returns `[]` → treat as empty, but a distinct error path is fine). Loading state per the app convention.
  - [x] **Entry point:** add a **"Run history"** link in the agent detail header (`agents/[id]/+page.svelte`, near the StatusDot / Test toggle) → `/agents/{id}/runs`. This is the ONLY change to the detail page beyond Task 4's transcript swap — the Build surface stays intact (the chosen "dedicated per-agent route" approach — no tab-layout restructure).
  - [x] Back navigation: the runs list links back to `/agents/{id}` (the agent).

- [x] **Task 6: Single-run REVIEW route** (AC: #1, #2)
  - [x] `apps/web/src/routes/(app)/agents/[id]/runs/[runId]/+page.svelte` (NEW) — on mount, `getRun(runId)`; render the persisted run:
    - **Header (AC2 — outcome + cause legible):** `RunStatusDot status={run.status}` (outcome) + `formatTimestamp(createdAt)`/`endedAt`. For `killed`/`failed`, render `run.reason` prominently as the **cause** — the canonical copy already produced by the orchestrator ("Killed — per-day cost cap reached ($5.00).", "Sandbox couldn't be established: …", "Run exceeded the 120s time limit.", "Sandbox exited N without a done message."). Voice: stated plainly, cause→consequence, never celebrated (EXPERIENCE.md:49-51, UX-DR16).
    - **The task:** show `run.taskInput`.
    - **Transcript (AC1):** `<RunTranscript transcript={run.transcript} />` — turns, per-call metrics, and refusal rows (with kind) — the "what it did and what was blocked" record (NFR-4).
    - **Cost summary:** `formatMicros(run.costMicros)` (mono) for the run's total.
    - **Not-found:** `getRun` returns `null` (404 or unreachable) → a stated "That run doesn't exist." with a link back to `/agents/{id}/runs`.
  - [x] Back navigation to `/agents/{id}/runs`.

- [x] **Task 7: Tests + verification** (AC: all)
  - [x] **control-api unit:** `listSummary(agentId)` returns newest-first summaries scoped to the agent, bounded, **without a `transcript` field**; excludes other agents' runs; `get()`/`list()` unchanged. (Extend `runs.test.ts`; distinct `x-forwarded-for` per `appWithSession` is N/A here — these are repo-level.)
  - [x] **web unit:** `datetime.test.ts` — `formatTimestamp` on a known ISO string + empty/invalid → `""`.
  - [x] **Playwright e2e (live stack, serial — append to `tests/agents.spec.ts`, distinct-XFF `signIn` per Story 5.2):** create an agent, set model+caps, run a Test (dev has no provider key → the run resolves **failed**). Then: click **Run history** → the run is **listed** with its status dot + word, a mono timestamp, and cost; the list is newest-first. Open the run → the **review** shows the outcome dot, the **legible cause** (`run.reason` for the failed run — assert the reason text is visible, AC2), the task input, and the **transcript** (at least the user turn; a metrics line if the Guard reported one) (AC1). Assert the **empty state** ("No runs yet.") on a fresh agent with no runs. (A `killed`-by-cap-breach review needs real spend > cap — a real model call — so the cap-breach *cause* string is unit-proven via the orchestrator's `killReason`, already covered by 4.5's tests; the failed-cause legibility is the deterministic e2e, mirroring the run happy-path gated/manual pattern.)
  - [x] `svelte-check` 0 · `pnpm -r build` 6/6 · `pnpm lint` · all unit suites · e2e incl. Epic 1–5.2 regressions green · `docker compose down -v` teardown. **Run `pnpm -r build` after adding tests, before any Docker build** (tsc catches type errors `pnpm -r test` may miss — prior-story lesson). Clean e2e procedure: `down -v` → `up -d` → **poll `POST /auth/login` (distinct XFF) until 200** → **pre-warm Vite** (`npm run dev` + hit `/login`,`/agents`) → run once.

## Dev Notes

**Last Epic 5 story — the observability read surface. This is almost entirely a WEB-read story: the backend already persists everything (E4-AD-7 — "on completion the terminal status + full transcript + summed metrics + refusals persist on the Run for later viewing") and already exposes `GET /runs?agentId=` + `GET /runs/:id`. What's missing is purely the web: a `listRuns` client, a history LIST surface, and a single-run REVIEW view that RE-RENDERS a past run's persisted transcript — the test pane never replays a persisted run today. No new write path, no schema change, no new AD.**

**User decision (load-bearing, resolved):** run history lives at **dedicated per-agent routes** — `/agents/:id/runs` (list) + `/agents/:id/runs/:runId` (review), reached via a "Run history" link in the detail header. The large, working agent-definition page is left intact (only the header link + the Task-4 transcript-component swap touch it) — lowest regression risk to 3.x/4.x/5.1. (No UX-DR defines a history surface, so this was an open UX call; a Build|Runs tab-layout and an in-page panel were the alternatives.)

### Architecture (the spines govern — binding)
- **E4-AD-7 — the runs table IS the read model for history:** written only by the orchestrator; "the terminal status + full transcript + summed metrics + refusals persist on the Run for later viewing. Spend shown is read from litellm, never recomputed." 5.3 is that "later viewing." [Source: epic-4-execution-plane/ARCHITECTURE-SPINE.md#E4-AD-7]
- **E4-AD-10 — provenance:** the harness emits `turn`+`done`; the Guard reports `metrics`+`refusal`+kill; the orchestrator merges both into the Run. So a persisted `transcript` already contains the turns, per-call metrics, and refusal records the history view renders. [Source: ...#E4-AD-10]
- **AD-7 — single writer / read-only elsewhere:** the orchestrator is the sole writer of Run state; 5.3 adds only **read** endpoints/queries + web views. [Source: architecture-turanga-2026-07-31/ARCHITECTURE-SPINE.md#AD-7]
- **AD-8 — run lifecycle** `created → running → (succeeded | failed | killed)`: the outcome vocabulary the review + list render (dot + word). [Source: ...#AD-8]
- **Error/refusal shape (parent spine Consistency Conventions):** "Guard/permission refusals are structured records attached to the Run (destination attempted, reason) — never silent." They live in the transcript as `type:"refusal"` (`kind: egress|permission` + human `detail`); the killed/failed **cause** is the row-level `reason`. [Source: ...#Consistency-Conventions, NFR-4]

### Requirements
- **NFR-4 (Observability) — the spine of both ACs:** "Every Run records its transcript, metrics, and any Guard/permission refusals, so the builder can always answer 'what did it do and what was blocked.'" [Source: prd.md#NFR-4]
- **FR-3 / FR-8 / FR-18:** an out-of-scope skill op, a non-allowlisted egress, and an un-granted send are each **refused and recorded on the Run** — that's what the review surfaces as refusal rows. [Source: prd.md#FR-3,8,18]
- **FR-4:** a Run produces a transcript + per-turn metrics (latency ms, tokens, cost) "rendered as specified in the UX spine." [Source: prd.md#FR-4]
- **NFR-6:** status never color-only (dot + word); numbers/IDs/timestamps mono/tabular. [Source: prd.md#NFR-6]

### UX (binding — reuse the test-pane render, don't reinvent)
- **No UX-DR defines a history surface** — the EXPERIENCE.md IA lists only `/agents/:id` for the agent. So the review REUSES the test-pane transcript rendering (the chosen dedicated route is a spec-silent extension, allowed).
- **UX-DR7 (test pane render):** "persistent chat transcript; … resolves to succeeded/failed dot + mono metrics (latency ms, tokens, cost)." The review mirrors this for a persisted run. [Source: epics.md#UX-DR7]
- **UX-DR23 / DESIGN.md:127,130 (refusals visible):** "blocked-egress refusals surfaced in the test/run view with destination + reason (NFR-4)"; refusals appear inline as **refusal rows** — "the guard, made legible." The `RunTranscript` refusal row shows the kind + detail. [Source: epics.md#UX-DR23, DESIGN.md]
- **UX-DR11 (status dot):** dot + word, never color-only; running pulses; `killed` reads caution (a guardrail stopped it), distinct from `failed` (errored). [Source: epics.md#UX-DR11, DESIGN.md:20-21,98]
- **Voice (AC2 legibility):** state the cause plainly — "Killed — per-day cost cap reached ($5.00)." / "Blocked egress to api.example.com — not on this agent's allowlist." — never "Uh oh!". Errors read cause→consequence→recovery (UX-DR16). [Source: EXPERIENCE.md:49-51]
- **Empty state:** "No runs yet." + one action (Run test / back to agent). [Source: EXPERIENCE.md:52]

### Existing code seam (concrete anchors — read before touching)
- `apps/control-api/src/runs/repo.ts` — `RunRow` (:8-18), `list(agentId?, limit?)` (drizzle :70 / memory :111), `DEFAULT_LIST_LIMIT=100` (:31-32), `toRow` (:37). **Add `RunSummary` + `listSummary` beside them; keep `list`.**
- `apps/control-api/src/runs/routes.ts:140` — `GET /runs` → switch to `listSummary`. `GET /runs/:id` (:65, full) + `/runs/:id/events` (:66, SSE) unchanged. Session-guard in `app.ts:62-63`.
- `apps/web/src/lib/runs.ts` — `RunMessage` union (:10-14), `Run` (:16-25), `getRun` (:83, full run — **reuse for the review**), `getAgentCost`/`getAgentsCost` (best-effort precedents). **Add `RunSummary` + `listRuns`.** `base = VITE_CONTROL_API_URL`.
- `apps/web/src/routes/(app)/agents/[id]/+page.svelte` — the test pane: transcript loop `turn`+`refusal` (:442-455 — **move into `RunTranscript`**), the resolution block `RunStatusDot`+last-metrics (:457-464, **keep**), `run-reason` (:465-467), cost-meter (:468-474), error state (:478-483), SSE `runTest()` (:77-131), `runGen` guard, `onDestroy(closeStream)`. The refusal row currently drops `kind` (:449-453) — `RunTranscript` adds the kind label. **Header** (:329-360) gets the "Run history" link.
- `apps/web/src/lib/components/RunStatusDot.svelte` — prop `Exclude<RunStatus,"created">` (:8), color map (:10-18), dot+word markup (:21-24), `.pulse` (:34-46). **Widen to full `RunStatus`.**
- `apps/web/src/routes/(app)/` route tree — `agents/[id]/+page.svelte` exists; **new** `agents/[id]/runs/+page.svelte` + `agents/[id]/runs/[runId]/+page.svelte`. The `settings/` folder shows the nested-route precedent (but we are NOT adding a `+layout.svelte` — dedicated sibling routes, per the user decision).
- `apps/web/src/lib/money.ts` — `formatMicros` (micros→"$0.0413"), `formatMinor`; the `$lib`-helper precedent for the new `datetime.ts`. `.mono-num` is `app.css:22`.

### Project Structure Notes
- Backend: one repo type + one repo method + one route change (list → summary). No migration, no writes.
- Web: 2 new routes + 2 new `$lib` modules (`datetime.ts`, `components/RunTranscript.svelte`) + a widened `RunStatusDot` + a header link + the test-pane transcript swap. The web still does **not** depend on `@turanga/domain` (browser-bundle constraint) — everything here is display logic; `RunSummary` is a local mirror like the existing `Run`/`RunMessage`.
- Polling: **none** for history — past runs are static; the LIST loads on mount (a still-`running` run simply shows `running` — the live view is the test pane's SSE, E4-AD-7). This differs from 5.2's live meter (which needed a poll) — deliberately simpler here.
- `runs.transcript` has no growth cap (deferred item) — fine for MVP single-call runs; the review renders whatever is persisted.

### Testing standards
- Vitest for control-api (repo, both impls) + web (`datetime`). Playwright serial e2e against the live docker stack; **distinct `x-forwarded-for` per `signIn`** (Story 5.2) + the `down -v`→`up -d`→login-probe→pre-warm-Vite clean-pass procedure. `pnpm -r build` after adding tests, before any Docker build.
- AC2's `killed`/cap-breach *cause* is unit-covered by 4.5's orchestrator tests (the `killReason` strings); the review just renders `run.reason`. The deterministic e2e proves `failed`-cause legibility (dev runs fail without a provider key).

### References
- [Source: _bmad-output/planning-artifacts/epics.md#Story-5.3, #UX-DR7, #UX-DR11, #UX-DR23]
- [Source: _bmad-output/planning-artifacts/prds/prd-turanga-2026-07-31/prd.md#NFR-4, #FR-3, #FR-4, #FR-8, #FR-18, #NFR-6]
- [Source: _bmad-output/planning-artifacts/architecture/architecture-turanga-2026-07-31/ARCHITECTURE-SPINE.md#AD-7, #AD-8, #Consistency-Conventions]
- [Source: _bmad-output/planning-artifacts/architecture/epic-4-execution-plane/ARCHITECTURE-SPINE.md#E4-AD-7, #E4-AD-10, #E4-AD-5, #E4-AD-8]
- [Source: _bmad-output/planning-artifacts/ux-designs/ux-turanga-2026-07-30/EXPERIENCE.md (Voice/State/empty), DESIGN.md (test-pane, refusal rows, killed vs failed)]
- [Source: _bmad-output/implementation-artifacts/5-2-operate-active-agents-live-status-spend.md — best-effort clients, RunStatusDot, e2e XFF/warmup, web-mirrors-domain]
- [Source: _bmad-output/implementation-artifacts/4-2-test-pane-streaming.md, 4-5-cost-metering-kill-on-breach.md — the transcript/metrics/refusal/killed-reason render being reused]
- [Source: _bmad-output/implementation-artifacts/deferred-work.md — GET /runs ownership (single-user MVP, do not close), transcript growth cap]

## Dev Agent Record

### Agent Model Used
claude-opus-4-8[1m]

### Debug Log References
- **Backend was almost entirely present (E4-AD-7).** Added only a `RunSummary` type + `listSummary(agentId?)` (a transcript-less projection: drizzle selects the summary columns, memory drops `transcript`) and pointed `GET /runs` at it. `GET /runs` had no web consumer and no HTTP-shape test, so switching the list to summaries was safe; `list()` stays for the repo unit test; `GET /runs/:id` (full run) is unchanged and powers the review.
- **The web `Run` type was missing `costMicros`** — the detail page computed run cost from the `metrics` messages, so the field was never mirrored. Added it (the server always returned it); `RunSummary = Omit<Run,"transcript">` then carries it. svelte-check caught this.
- **New route params need a sync:** `page.params.runId` didn't type-resolve until `svelte-kit sync` regenerated the `[id]/runs/[runId]` route types. Ran it, then svelte-check was 0/0.
- **`RunTranscript` + the test pane:** the test pane shows metrics only in its *resolution* summary (last-metrics), not inline. So the shared component takes `showMetrics` (default **false** → test pane behavior unchanged; the review passes **true** for per-call metrics). Extracted the `turn`/`refusal` rows out of the test pane into the component (removing the now-unused `.turn*` styles + splitting the `.refusal, .run-error` rule so svelte-check doesn't flag an unused selector). The refusal row now also shows the `kind` label ("Blocked egress"/"Permission denied") — additive; the existing refusal e2e asserts on `.refusal` substrings, so it still passes.
- **Lint:** the memory `listSummary` `{ transcript: _t, ...s }` destructure tripped `no-unused-vars` — rewrote it as an explicit summary object.
- **e2e (23/23):** the same two documented pristine-DB tests flaked after the control-api image `--build` (test #1 signIn bounced to `/login?` — a warmup race, first login, fresh XFF key, NOT the limiter and NOT my code; all 21 feature tests incl. 5.3 passed). A second clean cycle (`down -v` → `up -d`, no rebuild, restarts control-api → resets warmup + limiter → login-probe → Vite already warm) gave a clean **23/23**.

### Completion Notes List
- **This was a web-read story — the runs table already persists everything (E4-AD-7/E4-AD-10).** No schema change, no new write path, no new AD; control-api gained only a read projection.
- **AC1 (transcript + metrics + refusals).** New per-agent routes `/agents/:id/runs` (history list) + `/agents/:id/runs/:runId` (review), reached via a "Run history" link in the detail header. The review renders the persisted run via `getRun` — the replay path that did **not** exist before (the test pane never re-rendered a persisted run). The transcript renders through a shared `RunTranscript` (turns, per-call metrics, and refusal rows with an egress/permission **kind label** — "the guard, made legible").
- **AC2 (outcome + cause legible).** Both the list row and the review show the `RunStatusDot` outcome (dot + word), and for a `killed`/`failed` run the orchestrator's `reason` (cap-breach / blocked-egress / sandbox / timeout copy), stated plainly per EXPERIENCE.md voice. `RunStatusDot` was widened to the full lifecycle (a `created` run reads neutral).
- **Reuse over reinvention:** the test pane's transcript rows are now the shared `RunTranscript` (its live SSE/resolution/cost-meter/empty/error behavior is untouched and e2e-proven); `formatMicros`/`RunStatusDot`/Warm-Ink tokens are reused; a small `$lib/datetime.ts` (`formatTimestamp`) mirrors the `money.ts` helper precedent.
- **Scope held:** run history loads on mount (no poll — past runs are static; the live view is the test pane's SSE); single-user MVP means no run-ownership check (deferred multi-tenancy — not closed); `runs.transcript` growth cap stays deferred.
- **AC2 e2e note:** a dev run fails without a provider key, so the deterministic e2e proves the **outcome** legibility (failed dot + word) + the transcript/task render; the `killed`/cap-breach **cause** strings are unit-proven (orchestrator `killReason`, 4.5) and carried by `listSummary` (`reason`) — a real cap breach needs a real model call (gated/manual), mirroring the run happy-path pattern.
- **Verification:** `pnpm -r build` 6/6 · `svelte-check` 0/0 · `pnpm lint` clean · unit — domain 3, web 19, contracts 9, egress-guard 23, agent-harness 4, control-api 104 (+1 skipped) · **23/23 Playwright e2e** on a fresh live stack incl. the new run-history test · `docker compose down -v` teardown.

### File List
**Modified**
- apps/control-api/src/runs/repo.ts
- apps/control-api/src/runs/routes.ts
- apps/control-api/src/runs/runs.test.ts
- apps/web/src/lib/runs.ts
- apps/web/src/lib/components/RunStatusDot.svelte
- apps/web/src/routes/(app)/agents/[id]/+page.svelte
- apps/web/tests/agents.spec.ts

**Added**
- apps/web/src/lib/datetime.ts
- apps/web/src/lib/datetime.test.ts
- apps/web/src/lib/components/RunTranscript.svelte
- apps/web/src/routes/(app)/agents/[id]/runs/+page.svelte
- apps/web/src/routes/(app)/agents/[id]/runs/[runId]/+page.svelte

### Change Log
| Date | Change |
| --- | --- |
| 2026-08-03 | Story 5.3 implemented (closes Epic 5): a run-summary read projection (`listSummary` + `GET /runs` → summaries), a per-agent run-history surface (`/agents/:id/runs` list + `/agents/:id/runs/:runId` review, "Run history" header link), a shared `RunTranscript` renderer (turns + per-call metrics + kind-labelled refusal rows) reused by the test pane, `RunStatusDot` widened to the full lifecycle, and a `formatTimestamp` helper. Read-only over the existing runs table (E4-AD-7) — no schema change. Verified: build 6/6, svelte-check 0/0, lint clean, all unit suites, 23/23 e2e on a fresh live stack, no regressions. Status → review. |
