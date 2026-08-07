---
baseline_commit: 516081765cf69c82f4aa7277be7873cb425367f9
---
# Story 12.6: Multi-step observability — every step and every stop on the record

Status: review

<!-- SIXTH story of Epic 12. The loop is live (12.4), repair-resilient (12.5), and already emits a per-
     step `tool` transcript event for every call, in order (Story 6.5 reused) — so "what did it call,
     what came back" is ALREADY legible. 12.6 closes the one gap: "why did it end." Today the loop's
     stopReason (final | step-limit | error) is computed but only mapped to done:succeeded/failed — a
     STEP-LIMIT truncation is reported as a plain clean finish (the exact "silent truncation" the Story
     6.5 lesson forbids). 12.6 records the stop reason distinctly: the harness carries it on the `done`
     control message (a small CONTRACT_VERSION 9→10 bump — add optional `done.reason`), the orchestrator
     persists it to `run.reason`, and the web surfaces it. The cost-cap-KILL reason is ALREADY distinct
     (the orchestrator's out-of-band kill sets status=killed + a reason and WINS the terminal); 12.6 adds
     the step-limit + error distinctness. No new observability plumbing beyond the reason field; the web
     already renders per-step tool events + run.reason. -->

## Story

As the builder,
I want to see the agent's whole reasoning trail and exactly why it stopped,
so that I can trust a multi-step run — "what did it call, what came back, and why did it end" — and a truncated run is never dressed up as a clean finish.

## Acceptance Criteria

1. **Given** a multi-step loop, **when** each step executes, **then** it emits its `tool` transcript event (count/latency/outcome/refusal — Story 6.5 reused), preserving **order** across the loop so the reason→act→observe trail is legible. *(Already delivered by 12.4/12.5 — this story confirms + guards it with a test that a multi-step run's tool events appear in emission order.)* [Source: epics.md#Story-12.6 AC1; Story 6.5]

2. **Given** a completed turn, **when** its stop reason is recorded, **then** it is one of **final answer / step-limit / cost-cap-kill**, each **distinct and explicit** — a step-limit truncation is **never** presented as a clean finish. The harness carries the loop's stop reason on the `done` control message (`done.reason`, optional); the orchestrator persists it to `run.reason` for the normal terminal; the cost-cap-kill reason continues to be set by the orchestrator's out-of-band kill (which wins the terminal). [Source: epics.md#Story-12.6 AC2; Story 6.5 lesson; Story 4.5 kill]

3. **Given** the web completed-turn view, **when** a builder inspects a turn that used tools, **then** the steps render **legibly** — the per-step `tool` events (already rendered: dot + word, mono latency) in order, **and** the stop reason when the run did not end on a clean final (step-limit / error / kill), stated with a word, never a silent truncation (NFR-6, UX-DR15/16). [Source: epics.md#Story-12.6 AC3; project-context UI conventions]

## Tasks / Subtasks

- [ ] **Task 1: Contract — carry the stop reason on `done` + bump 9→10** (AC: #2)
  - [x] `packages/contracts/src/index.ts` — added `reason: z.string().optional()` to the `done` control message; bumped `CONTRACT_VERSION` 9→10 (all 15 `z.literal` sites re-pin via the symbol); prepended the v10 version-history line.
  - [x] `packages/contracts/src/index.test.ts` — `.toBe(10)`; the done test now round-trips a `reason` AND parses without it (backward-compat); test title updated to Story 12.6.
  - [x] `apps/web/src/lib/runs.ts` — `RunMessage` mirror six `v: 9`→`v: 10`, `reason?: string` on the `done` member, "currently 10" comment.

- [x] **Task 2: Harness — emit the stop reason on `done`** (AC: #2)
  - [x] `apps/agent-harness/src/main.ts` — added a pure exported `stopReasonText(stopReason, steps)` (final→undefined, step-limit→"Reached the step limit (N steps) …", error→"The run ended before a final answer."); the tools branch sets `doneReason = stopReasonText(loop.stopReason, loop.steps)`; the `done` emit spreads `...(doneReason ? { reason: doneReason } : {})`. The no-tools single-call path emits `done` with no reason (unchanged).
  - [x] `done.status` mapping unchanged: final/step-limit → succeeded, error → failed. The **reason** is what makes a step-limit run distinct from a clean final.

- [x] **Task 3: Orchestrator — persist `done.reason` to `run.reason`** (AC: #2)
  - [x] `apps/control-api/src/runs/orchestrator.ts` — the control-channel read loop captures `parsed.data.reason` into `doneReason`; the normal-terminal `finish(...)` passes `doneReason ?? (…existing fallback…)`.
  - [x] The kill/timeout paths are **untouched** — a breach/timeout still wins the terminal with its own killed+reason; only the normal succeeded/failed terminal carries the harness's stop reason.

- [x] **Task 4: Web — surface the stop reason in the transcript** (AC: #1, #3)
  - [x] `apps/web/src/lib/components/RunTranscript.svelte` — added a `{:else if msg.type === "done" && msg.reason}` branch rendering a muted italic "Ended — {reason}" line (a clean final with no reason still renders nothing); header comment updated. No colour-only signal.
  - [x] Per-step `tool` events already render in order (unchanged); the ordering guard is a harness test (Task 5).
  - [x] `svelte-check` clean (0 errors / 0 warnings).

- [x] **Task 5: Tests + verification** (AC: all)
  - [x] **contracts unit** — `CONTRACT_VERSION === 10`; `done` round-trips a `reason` and parses without it.
  - [x] **harness unit** — `stopReasonText` unit test (final→undefined; step-limit + error distinct); `toolLoop.test.ts` order-guard (a 2-step loop emits 2 `tool` events in emission order). **harness 22** (was 20).
  - [x] **control-api unit** — a run whose `done` carries a step-limit `reason` persists it to `run.reason` (succeeded status, but the truncation recorded). **control-api 257** (was 256).
  - [x] `pnpm -r build` · `pnpm lint` (0) · `svelte-check` (0) · full `pnpm -r test` green (contracts 18, harness 22, control-api 257, guard 36, domain 5, web 22). No stray `v: 9` anywhere.
  - [ ] **e2e — the v10 harness image rebuild folds into the Story 12.4 Mortimer demo (user-gated/pending).** A v9 harness would reject a v10 spec, so any live run needs the image rebuilt. Never `down -v` the dev stack.
  - [x] Bookkeeping: boxes checked, Dev Agent Record / File List / Change Log filled, Status → review.

## Dev Notes

**Most of the observability already exists — 12.6 records the ONE missing thing: why the run ended.** The per-step `tool` events (name/op/outcome/latency/detail) are emitted by the loop executor + the repair path (12.4/12.5) in order, and `RunTranscript.svelte` already renders them legibly (dot + word, mono latency — NFR-6). The gap is the **stop reason**: `runToolLoop` computes `stopReason` (`final | step-limit | error`) but `main.ts` only maps it to `done:succeeded/failed`, so a **step-limit truncation looks identical to a clean final** — the "silent truncation" the Story 6.5 lesson forbids. 12.6 threads the stop reason to the transcript + `run.reason` + the UI.

### The distinctness, per stop kind
- **final** — a clean answer; `status:succeeded`, no reason (the transcript stays uncluttered).
- **step-limit** — a partial answer that hit the ceiling; `status:succeeded` **+ a reason** ("Reached the step limit (N steps) …"). The reason is what makes it distinct from a clean final — **do not** dress it up as a plain success.
- **cost-cap-kill** — **already distinct** and untouched: the Guard emits an out-of-band `kill`, the orchestrator sets `status:killed` + a "Killed — per-run cost cap reached (…)" reason that **wins** the terminal over the harness's `done` (`orchestrator.ts:526`). 12.6 must NOT change this path.
- **error** — a mid-loop failure; `status:failed` + a reason. (`runCause` already speaks a failed run's reason for the status dot; the transcript line adds it inline too.)

### Why a contract bump (9→10)
The harness is the only place that knows the loop's stop reason, and the transcript (`ControlChannelMessage[]`) is its only channel to the control plane. The `done` message is the natural carrier, so `done.reason?` is the clean primitive — a small, optional, backward-safe field (a non-tool/old run emits `done` with no reason and parses fine). This is the familiar sweep (like the 8→9 bump): `CONTRACT_VERSION`, the 15 `z.literal` sites (auto), the test `.toBe`, and the six `v:` mirror literals in `web/runs.ts`. **Operational note:** the agent-harness image must be rebuilt to a v10 harness before any e2e (a v9 harness rejects a v10 spec) — folds into the 12.4 Mortimer demo.

### The web is nearly free
`RunTranscript.svelte` already renders the transcript array (tool events in order). `runCause(status, reason)` (`runs.ts:149`) already renders `run.reason` for **failed/killed** runs (run-detail + chat-thread). The one gap: a **succeeded** step-limit run — `runCause` returns null for succeeded, so its reason wouldn't show. 12.6 renders the stop reason from the **`done` transcript event** (which now carries `reason`) as a small terminal line, so it surfaces regardless of the status dot. That keeps `runCause`'s status semantics intact and puts the truncation note where the trail ends.

### Architecture (binding)
- **AD-9 / AD-10** — `done.reason` is a secret-free human string (like the existing kill reason), recorded on the immutable transcript; no new side-channel.
- **AD-7** — the orchestrator remains the sole writer of `run.reason`; it derives it from the transcript `done` (control-plane), exactly as it already derives the kill reason.
- **Story 4.5 / AD-6** — the kill terminal + its reason are unchanged and still win over the harness `done`.

### Existing patterns / source (file:line)
- **The stop reason:** `toolLoop.ts` `ToolLoopResult.stopReason` (`final|step-limit|error`) + `.steps`; `main.ts` the tools branch (`:230`-ish) + the `done` emit (`:243`).
- **The contract:** `contracts/index.ts` the `done` message (`:133`), `CONTRACT_VERSION` (`:25`), the version-history block (`:6`); the 8→9 bump (Story 12.1) is the exact ritual; `web/src/lib/runs.ts` the mirror (six `v:9`, `:12-17`) + `runCause` (`:149`).
- **The orchestrator:** the control-channel read loop (`:505-513`, capture `done.reason`) + `finish(runId, status, reason, cost)` (`:344`, `:532`); the kill path that wins (`:526-531`) — untouched.
- **The web transcript:** `RunTranscript.svelte` (`done` renders nothing `:5`; tool render `:41-49`); the run-detail cause (`runs/[runId]/+page.svelte:47,109`) + chat cause (`chat/[conversationId]/+page.svelte:264`).
- Prior stories: `12-4` (the loop + stopReason), `12-5` (repair); Story 6.5 (`tool` event); [[epic-12-tool-loop]].

### Project Structure Notes
- **Edited:** `packages/contracts/src/index.ts` (+test) — `done.reason` + v10; `apps/web/src/lib/runs.ts` — mirror v10 + `done.reason`; `apps/agent-harness/src/main.ts` (+test) — emit `done.reason`; `apps/control-api/src/runs/orchestrator.ts` (+test) — persist `done.reason`; `apps/web/src/lib/components/RunTranscript.svelte` — render the stop-reason terminal line.
- **No change:** `toolLoop.ts` (the loop already returns `stopReason`), the Guard, `runCause` semantics (status-gated for failed/killed — the transcript line covers the succeeded-truncated case).
- **Scope guard:** NO new control-channel event type (reuse `done`), NO change to the kill terminal path, NO per-step index field (order is emission order), NO capability signal (12.7). This story is: `done.reason` (a v10 bump) + emit it + persist it + render it.

### Testing standards
- Vitest, co-located; `svelte-check` for web. Contracts test asserts v10 + the optional reason. Harness: unit-test a small pure "stopReason → done.reason" helper (avoid standing up full `runHarness`). Control-api: a fake runtime whose `done` line carries a reason → assert `run.reason` persists. Full verification: `pnpm -r build`, `pnpm lint`, `svelte-check`, `pnpm -r test`; the v10 harness image rebuild folds into the 12.4 e2e. Never `down -v` the dev stack.

### References
- [Source: epics.md#Epic-12 + #Story-12.6 (every step + every stop distinct; the web step view) + #Architecture-and-scope-decisions]
- [Source: architecture spine #AD-6, #AD-7, #AD-9, #AD-10 ; Story 4.5 (kill terminal) ; Story 6.5 (`tool` event + the no-silent-truncation lesson) ; project-context.md (NFR-6, UX-DR15/16)]
- [Source: toolLoop.ts (stopReason) ; main.ts (done emit) ; orchestrator.ts:505-532 (done read + finish + kill-wins) ; contracts done message + CONTRACT_VERSION ; web runs.ts/runCause + RunTranscript.svelte]
- [Source: 12-4/12-5 story files ; the 8→9 bump ritual (Story 12.1) ; [[epic-12-tool-loop]] ; [[turanga-e2e-clean-run]]]

## Dev Agent Record

### Agent Model Used

claude-opus-4-8 (Claude Opus 4.8)

### Debug Log References

- **A step-limit run is `succeeded` + a reason — the reason is the distinctness.** The `done.status` enum (succeeded/failed/killed) has no "truncated" value, and calling a step-limit run "failed" would be wrong (a partial answer stands). So it stays `succeeded` and the `reason` carries the truncation. `runCause` is status-gated (null for succeeded), so the reason surfaces via the **`done` transcript row** (RunTranscript), not the status-dot cause — which keeps `runCause`'s semantics intact.
- **Pure helper to avoid a `runHarness` test.** The `done.reason` derivation lives in `stopReasonText(stopReason, steps)` — a pure exported fn — so the mapping is unit-tested directly without standing up the full `runHarness` (env + stdout + socket). The literal union `"final" | "step-limit" | "error"` is inlined (mirrors `ToolLoopResult["stopReason"]`) so `main.ts` still imports nothing from `toolLoop.ts` (the AI SDK stays out of the module + the unit test).
- **The kill terminal already wins.** A cost-cap-kill / timeout returns from `finish(...)` earlier with its own killed+reason (orchestrator `:526-531`), so the new `doneReason` persistence only affects the normal succeeded/failed terminal — the cost-cap-kill distinctness (Story 4.5) is untouched.

### Completion Notes List

- **"Why did it end" is now on the record.** The loop's stop reason (final / step-limit / error) rides the `done` control message (`done.reason`, optional — a `CONTRACT_VERSION` 9→10 bump), the harness emits it from `runToolLoop`, the orchestrator persists it to `run.reason`, and the web renders it as a transcript "Ended — …" line. A **step-limit truncation is never a silent clean finish** — the Story 6.5 lesson, closed for the loop.
- **The per-step trail already renders in order** (12.4/12.5 emit + `RunTranscript` renders); AC1 is confirmed + guarded by a new order test. **Cost-cap-kill distinctness is untouched** (the orchestrator's out-of-band kill still wins the terminal with its own reason).
- **Backward-safe:** `done.reason` is optional — a clean final and every pre-v10 run emit `done` with no reason and parse fine. The one operational note: the agent-harness image must be rebuilt to v10 before a live run (a v9 harness rejects a v10 spec) — folds into the 12.4 Mortimer demo.
- **Verification:** contracts 18, harness 22 (+2), control-api 257 (+1), guard 36, domain 5, web 22 — all green; `pnpm -r build` + `pnpm lint` + `svelte-check` clean; no stray `v: 9`. Scope held: no new event type, no capability signal (12.7), the kill path untouched.

### File List

**Edited — contracts**
- `packages/contracts/src/index.ts` — `done.reason` optional field; `CONTRACT_VERSION` 9→10; v10 history line
- `packages/contracts/src/index.test.ts` — v10 assertion; done round-trips reason + backward-compat

**Edited — harness**
- `apps/agent-harness/src/main.ts` — `stopReasonText` pure helper; emit `done.reason` from the loop
- `apps/agent-harness/src/main.test.ts` — `stopReasonText` test
- `apps/agent-harness/src/toolLoop.test.ts` — multi-step tool-event order guard

**Edited — control-api**
- `apps/control-api/src/runs/orchestrator.ts` — capture `done.reason`, persist to `run.reason`
- `apps/control-api/src/runs/runs.test.ts` — done.reason → run.reason persistence test

**Edited — web**
- `apps/web/src/lib/runs.ts` — `RunMessage` mirror v10 + `done.reason`
- `apps/web/src/lib/components/RunTranscript.svelte` — render the stop-reason "Ended — …" line

### Change Log

| Date | Version | Description |
|------|---------|-------------|
| 2026-08-06 | 0.1 | Story 12.6 drafted. |
| 2026-08-06 | 0.2 | Story 12.6 implemented. Records the loop's terminal stop reason so a step-limit truncation is never a silent clean finish: `done.reason` added to the control contract (CONTRACT_VERSION 9→10), emitted by the harness via a pure `stopReasonText` helper (final→none, step-limit→"reached the step limit (N steps)…", error→a reason), persisted by the orchestrator to `run.reason` (the kill terminal still wins with its own reason), and rendered in the web transcript as an "Ended — …" line. Per-step tool events already render in order — guarded by a new test. Verified: contracts 18 / harness 22 / control-api 257 / full pnpm -r test + build + lint + svelte-check green; no stray v9. e2e (v10 harness rebuild) folds into the 12.4 Mortimer demo. Status → review. |
