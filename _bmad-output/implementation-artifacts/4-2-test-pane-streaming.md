---
baseline_commit: 8c6e50c6fb23a47ed92a76f71c098b86a0980eb8
---
# Story 4.2: Test pane — streaming transcript and metrics

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As the builder,
I want to watch a test run live,
so that I can judge the agent before trusting it.

## Acceptance Criteria

1. **Given** the agent-definition test pane, **when** a test is run (**Run test** button or **`Cmd/Ctrl+Enter`** from anywhere in the editor; `Esc` closes popovers; the running pulse is the only looping motion), **then** turns **stream in**; the in-flight turn shows the **pulsing running dot**; on completion it resolves to a **succeeded/failed** dot (dot + word, never colour-only) with **mono metrics** (latency ms, tokens; cost is metered in Story 4.5). [Source: epics.md#Story-4.2 FR-4, UX-DR7/11/14; DESIGN.md#components.test-pane/#agent-status-dot, #Typography; EXPERIENCE.md#Component-Patterns, Key-Flow-1; E4-AD-7]
2. **Given** the five UI states, **when** the pane is loading / empty / erroring / succeeding, **then** each renders per the state patterns: **empty** = "No test runs." + **Run test**; **error** = cause→consequence→recovery inline (dot + text, no red banner); a **refusal row** renders inline if one occurs (none are emitted until 4.3/4.5 — the row is built so later stories slot in). [Source: epics.md#Story-4.2 UX-DR13; EXPERIENCE.md#State-Patterns, #Voice]
3. **Given** a transcript, **when** `Clear` is used, **then** the session transcript resets. [Source: epics.md#Story-4.2; EXPERIENCE.md#Component-Patterns ("Clear resets the transcript")]

## Tasks / Subtasks

- [x] **Task 1: Async run + in-memory run hub (control-api)** (AC: #1)
  - [x] `apps/control-api/src/runs/hub.ts` — a `RunHub` (in-memory, single control-api process; MVP): `open`/`publish`/`complete`/`subscribe(runId, fromIndex, onMsg, onDone) → unsubscribe` (replays the buffered messages from `fromIndex`, then live), keeping a per-run ordered buffer + terminal status, evicted a ~30s TTL after completion. `open()` was added so an in-flight run has hub state before its first publish (closes the `start()`→first-message race).
  - [x] `apps/control-api/src/runs/orchestrator.ts` — injects the hub; **publishes each control message right after `appendMessage`**, and `hub.complete(runId, terminalStatus)` in the `finally`. Refactored into `validateAndCreate` + a private `execute(runId, jobSpec)`; `launch()` (await-to-terminal — 4.1 tests) and `start()` (fire-and-forget; returns the running run immediately) share it. The concurrency slot is reserved in `validateAndCreate` and released in `execute`'s finally (closes the check→increment window).

- [x] **Task 2: SSE relay endpoint (control-api)** (AC: #1, #2)
  - [x] `apps/control-api/src/runs/routes.ts` — `GET /runs/:id/events` (behind `requireSession`) using Hono's `streamSSE`: real 404 if the run is unknown; `hub.subscribe(id, 0, …)` bridges the hub's sync callbacks to the async writer via an ordered queue → `message` events + a terminal `done` event, then close + unsubscribe (also on `onAbort`). If the hub doesn't know the run (terminal + evicted), replays the persisted transcript. **`POST /runs`** now calls `orchestrator.start(...)` and returns the running run immediately (201).
  - [x] Hub wired in `app.ts` (default, shared with the default orchestrator) + `server.ts` (real), passed to both the orchestrator and the routes (`runHub` AppDep).

- [x] **Task 3: Harness emits metrics** (AC: #1)
  - [x] `apps/agent-harness/src/main.ts` — emits a **`metrics`** control message (`latencyMs` + `tokens` from the `GuardModelResponse`, `costMinor: 0`) after the model call **regardless of success** (the Guard measures latency even for a failed call, E4-AD-10 — tokens is 0 when the call didn't complete), then the agent `turn`, then `done`.

- [x] **Task 4: Web run client + SSE** (AC: all)
  - [x] `apps/web/src/lib/runs.ts` — `startRun(agentId, taskInput): Result<Run>` (POST `/runs`), `Run`/`RunMessage` types mirroring the control-api shapes, and `runEventsUrl(id)`. Reuses the `base` + `credentials` pattern from `$lib/agents`.
  - [x] Streaming uses the browser **`EventSource`** with `{ withCredentials: true }` against `runEventsUrl(id)`; parses each `message`/`done` event's JSON into `RunMessage`; owns the `close()` on `done` so the browser doesn't auto-reconnect; a mid-stream drop (no `done`) surfaces the error state.

- [x] **Task 5: The test pane UI** (AC: all)
  - [x] Replaced the placeholder in `+page.svelte`'s right pane with the real **test pane** (`--bg-canvas`, hairline `border-left`): a chat-style task input ("What should it do?") + a verb-first **`Run test`** button; **`Cmd/Ctrl+Enter` from anywhere** (via `<svelte:window>`, guarded on a loaded agent) runs the current input. On run: `startRun` → `EventSource` → streaming **mono** turns; in-flight shows the **pulsing `--state-running` dot + "running"** (1600ms, the only motion); `done` resolves to a **run-status dot + word** with a **mono/tabular metrics** line (`428 ms · 1,284 tokens`, middot so cost slots in at 4.5); an inline **refusal row** is built (not yet emitted). Five states: empty ("No test runs." + Run test) / running / succeeded|failed|killed / **error** (cause→consequence→recovery, dot + text, no banner). **`Clear`** resets the pane client-side.
  - [x] `apps/web/src/lib/components/RunStatusDot.svelte` maps `running|succeeded|failed|killed` → dot + word + lifecycle tokens; the running variant pulses (respects `prefers-reduced-motion`). Added the missing `--state-killed` token (→ `--state-idle`). Config-pane autosave, the `<1024px` Test toggle, and 3.2–3.5 all preserved.

- [x] **Task 6: Tests + verification** (AC: all)
  - [x] **Unit (control-api):** `hub.test.ts` — replay-from-index then live, unsubscribe stops delivery, `complete` fires `onDone`, late-subscriber-within-TTL gets buffer + done, unknown run → null, TTL eviction. Orchestrator: `start()` returns running + completes in the background; publishes each message + completes once; `start()` enforces the cap up front; 4.1 `launch()` tests unchanged.
  - [x] **Gated integration test** updated for the async `POST /runs`: asserts the returned `running`, then polls `GET /runs/:id` to terminal (still `RUN_SANDBOX_IT`). Verified live.
  - [x] **Playwright e2e** appended to `tests/agents.spec.ts`: empty → task + Run test → streamed user turn → **failed** run-status dot + word + agent turn + mono metrics → **Clear** → **Cmd/Ctrl+Enter** re-runs. The 3.2 test's placeholder assertion updated to the empty state.
  - [x] `svelte-check` 0/0 · `pnpm -r build` 6/6 · `pnpm lint` clean · all unit suites green · **16/16 e2e** on a fresh live stack · gated sandbox integration green · no leaked containers.

## Dev Notes

**Second Epic 4 story — make the run visible. Turn 4.1's synchronous run into a live-streaming test pane: an in-memory run hub + an SSE relay (E4-AD-7) + the web test pane (streaming turns, the running pulse, run-status dots, mono metrics, Clear, five states). Do NOT build: live Data-Connection reads / allowlist / credentialed egress (4.3), skill/permission enforcement (4.4), per-run cost key + kill-on-429 + real cost metering (4.5 — cost shows as omitted/`—`), the filter hook (4.6), or the draggable pane divider (deferred in 3.2). The refusal row + killed dot are RENDERED (so later stories emit into them) but nothing generates them in 4.2.**

### Architecture (the E4 spine governs)
[Source: _bmad-output/planning-artifacts/architecture/epic-4-execution-plane/ARCHITECTURE-SPINE.md]
- **E4-AD-7:** a `runs` table (orchestrator sole-writer) + a **control-api SSE stream** relaying a run's control-channel messages to the web test pane; terminal transcript + metrics persist on the Run. The hub is the live relay; the repo is the persisted truth (SSE falls back to it for terminal/evicted runs).
- **E4-AD-10:** the harness emits `turn` + `done`; **cost/refusals are the Guard's** authoritative outputs — the harness relaying **latency + tokens** (which the Guard returned in `GuardModelResponse`) is a display metric; **cost stays 0 until the Guard owns it (4.5)**.
- **AD-8 lifecycle:** run states `created → running → (succeeded | failed | killed)`, mutated only by the orchestrator (AD-7). The pane renders running (pulse) / succeeded / failed / killed.
- **Inherited (still true):** the sandbox is `--network=none` with the per-run UDS as its only egress (4.1); no secret enters the sandbox (AD-10); Test runs a **Draft** agent (AD-8 — Test is an execution mode, not gated on Active).

### UX specifics (DESIGN.md / EXPERIENCE.md — Warm Ink baseline wins)
- **`test-pane`:** `--bg-canvas`, `border-left: 1px solid var(--border-subtle)` (hairline, never shadow). A **chat-style transcript**; each turn shows role + **mono metrics**; the in-flight turn shows the **pulsing `--state-running` dot** — the only looping motion (**1600ms**). Resolves to `--state-succeeded`/`--state-failed`/`--state-killed` (dot + word). [DESIGN.md#components.test-pane, #Motion; EXPERIENCE.md#Component-Patterns]
- **Run affordance:** verb-first **`Run test`**; **`Cmd/Ctrl+Enter` runs from anywhere in the editor**; `Esc` closes popovers. [EXPERIENCE.md#Voice, #Interaction-Primitives]
- **Metrics:** IBM Plex Mono + `tabular-nums`, **≥ 12px**; canonical string `1,284 tokens · $0.0041` and latency `428 ms` / copy "Succeeded in 428 ms." — render **latency + tokens** now with the `·` middot so **cost slots in at 4.5** without layout change. [DESIGN.md#Typography, prose L127; EXPERIENCE.md Key-Flow-1, #Accessibility]
- **Status never colour-only** (dot + word); focus ring visible; **no motion beyond the pulse**; sentence case, no exclamation/emoji ("Succeeded in 428 ms." not "Done!"). [EXPERIENCE.md#Accessibility, #Voice]
- **Empty** = "No test runs." + **Run test** (no illustration); **Error** = cause→consequence→recovery, dot + text, **no red banner**; **refusal row** = destination/reason inline. [EXPERIENCE.md#State-Patterns, #Voice]

### Files being modified (READ current state — preserve behavior)
- **`apps/control-api/src/runs/orchestrator.ts` (UPDATE):** inject the hub + publish/complete; add `start()`; keep `launch()` (tests). Preserve the 4.1 fail-closed order, timeouts, concurrency cap, reap+teardown.
- **`apps/control-api/src/runs/routes.ts` (UPDATE):** `POST /runs` → `start` (returns running); add `GET /runs/:id/events` (SSE). Keep `GET /runs/:id`, `GET /runs`.
- **`apps/control-api/src/app.ts` + `server.ts` (UPDATE):** build + inject the hub.
- **`apps/agent-harness/src/main.ts` (UPDATE):** emit the `metrics` message. Keep the bare-loop + JOB_SPEC + guard-UDS + no-network behavior.
- **`apps/web/src/routes/(app)/agents/[id]/+page.svelte` (UPDATE):** the test pane (right side). **Preserve** the two-pane split, `<1024px` Test toggle, all config sections + autosave (3.2–3.5), header, notFound/error/Retry.
- **`apps/web/tests/agents.spec.ts` (UPDATE):** append the 4.2 e2e (one file; the 3.1 empty-state stays first).
- **`apps/control-api/src/runs/sandbox.integration.test.ts` (UPDATE):** poll for terminal (async POST).
- **NEW:** `apps/control-api/src/runs/hub.ts` (+ test), `apps/web/src/lib/runs.ts`, `apps/web/src/lib/components/RunStatusDot.svelte`.

### Previous-story intelligence (4.1 + Epic 3)
- **4.1 orchestrator** is fail-closed with a wall-clock deadline, concurrency cap, and always-reap; `appendMessage` is a DB-level jsonb append. The consume loop is where the hub publish hooks in. `ControlChannelMessageSchema` = `turn | metrics | refusal | done`. Runs are short (seconds); a real completion needs a provider key (none → `failed` with the model error visible — that's the e2e path). [4-1]
- **Web patterns:** discriminated `Result<T>`, `base = VITE_CONTROL_API_URL ?? http://localhost:8080`, `credentials:'include'`; Warm Ink tokens; `@lucide/svelte`; runes; the detail page already wires `showTest`/the split + `Cmd`? (only autosave so far — add the Cmd/Ctrl+Enter run handler). e2e is serial, all agent specs in `tests/agents.spec.ts`; a run needs no provider to demonstrate streaming (fails with a visible error). [3-2..3-6, 4-1]
- **EventSource + CORS:** control-api `cors({ origin: webOrigin, credentials: true })` already covers `/runs/*`; `EventSource(url, { withCredentials: true })` sends the session cookie. SSE responses need `text/event-stream` + no-cache — `streamSSE` handles it.
- **Known deferrals (do not reopen):** the 4.1 review defers (guard socket reaper, tenancy, secrets-in-prod, transcript caps), the Epic 3 deferrals. [deferred-work.md]

### Testing standards
- **Unit (control-api):** RunHub replay/live/TTL/unsubscribe; orchestrator `start` (async) vs `launch` (sync), publish + complete once. In-memory; no Docker.
- **Integration (gated):** poll the async run to terminal (still `RUN_SANDBOX_IT`).
- **E2E (Playwright, live, serial):** empty → Run test / Cmd+Enter → streamed user turn → failed run-status + agent turn + mono metrics → Clear.
- `svelte-check` 0, build 6/6, lint clean, Epic 1–3 + 4.1 regressions green.
- **DoD:** a test streams live (turns appear incrementally, the running dot pulses, resolves to a run-status dot + word with mono latency+tokens); the five states render; Clear resets; POST /runs is async + the SSE relays via the hub; only 4.2 scope (cost/allowlist/skills/kill/filter are marked seams).

### Project Structure Notes
- New (control-api): `runs/hub.ts` (+ test); the SSE route + hub wiring. New (web): `lib/runs.ts`, `components/RunStatusDot.svelte`. Modified: orchestrator/routes/app/server, harness `main.ts`, the detail page, `tests/agents.spec.ts`, the integration test. No migration; contracts unchanged (metrics message already exists). [E4 spine Structural Seed; AD-7]

### References
- [Source: _bmad-output/planning-artifacts/epics.md#Epic-4 / Story-4.2; FR-4, UX-DR7/11/13/14]
- [Source: architecture/epic-4-execution-plane/ARCHITECTURE-SPINE.md — E4-AD-7, E4-AD-10, E4-AD-2; inherited AD-1/7/8/9/10]
- [Source: ux-designs/ux-turanga-2026-07-30/DESIGN.md#components.test-pane/#agent-status-dot, #Typography, #Motion, #Elevation; EXPERIENCE.md#Component-Patterns, #State-Patterns, #Interaction-Primitives, #Accessibility, #Voice, Key-Flow-1/2]
- [Source: packages/contracts (ControlChannelMessage: turn/metrics/refusal/done); apps/control-api/src/runs (4.1 orchestrator/repo/routes); apps/agent-harness/src/main.ts]
- [Source: _bmad-output/implementation-artifacts/4-1-sandbox-bare-loop.md; project-context.md; deferred-work.md]

### Review Findings (code review 2026-08-02)

- [x] [Review][Patch] Running window shows "No test runs." with no pulse — gate the empty copy on `runState === "empty"` so a running-with-no-messages-yet state reaches the pulse [apps/web/src/routes/(app)/agents/[id]/+page.svelte:360] — FIXED
- [x] [Review][Patch] Concurrency slot leak — reserve inside a try/catch that releases on failure, and drop start()'s redundant `runsRepo.get` (return the row already in hand) [apps/control-api/src/runs/orchestrator.ts:63] — FIXED (+ unit test)
- [x] [Review][Patch] SSE fallback can emit a non-terminal `done` — coerce a `created`/`running` persisted status to `failed` in the repo-replay path so an orphaned run resolves cleanly [apps/control-api/src/runs/routes.ts:74] — FIXED
- [x] [Review][Patch] Start-run continuation ignores Clear/navigate — a `runGen` token bumped in runTest/clearTest(/load); the post-`await` IIFE + the SSE listeners bail when stale [apps/web/src/routes/(app)/agents/[id]/+page.svelte:77] — FIXED
- [x] [Review][Patch] `hub.complete` has no `s.done` guard — early-return when already done and clear the prior `evictTimer` before setting a new one [apps/control-api/src/runs/hub.ts:56] — FIXED (+ unit test)
- [x] [Review][Patch] `Cmd/Ctrl+Enter` on a narrow viewport runs with the pane collapsed — `runTest` now sets `showTest = true` [apps/web/src/routes/(app)/agents/[id]/+page.svelte:123] — FIXED
- [x] [Review][Patch] `killed` dot renders neutral grey, not caution — `--state-killed: var(--caution-500)` per DESIGN.md, both light + dark blocks [apps/web/src/lib/design/warm-ink/colors.css:102] — FIXED
- [x] [Review][Defer] Some test-pane error strings are cause-only, not cause→consequence→recovery (AC2) [apps/web/src/lib/runs.ts:47] — deferred, low-value copy polish (partly shared with $lib/agents)

## Dev Agent Record

### Agent Model Used
claude-opus-4-8[1m]

### Debug Log References
- EventSource fires `error` when the server closes the stream normally (SSE auto-reconnect). Guarded with a `doneReceived` flag + owning `es.close()` on `done` so a clean completion isn't shown as an error and the browser doesn't reconnect.
- `<svelte:window>` cannot live inside an `{#if}` block (Svelte compile error) — moved to component top level and guarded the handler on a loaded agent.
- The first e2e cut asserted a metrics line on the failed run, but the harness only emitted metrics on success → no line. Changed the harness to emit metrics regardless of success (the Guard measures latency for a failed call too); the metrics line now renders on the failed path.
- No `--state-killed` design token existed; added it (→ `--state-idle`, a neutral stop) in both light + dark blocks.

### Completion Notes List
- Turned the 4.1 synchronous run into a live-streaming test pane: an in-memory `RunHub` (publish/complete/subscribe + replay-from-index + ~30s TTL) relays the orchestrator's control-channel messages to a Hono `streamSSE` endpoint, which the web watches via `EventSource`. The repo stays the persisted truth; the SSE falls back to it for terminal/evicted runs.
- Orchestrator refactored into `validateAndCreate` + a shared `execute`; `launch()` (sync, tests) and `start()` (async, POST /runs) both run the same fail-closed order, timeouts, concurrency cap, and always-reap + teardown from 4.1. The hub is published to right after each `appendMessage` and completed once in the finally.
- Scope held to 4.2: cost stays 0 (Guard meters it in 4.5), the refusal row + killed dot are rendered but nothing emits them yet, and no allowlist/skills/kill/filter work. Inherited security invariants unchanged (`--network=none` + per-run UDS, no secret in the sandbox, Docker socket only in control-api).
- Verified end-to-end on a live `dev-insecure` stack: a run streams the user turn, then resolves to a `failed` dot (no provider key → model error) with an agent turn + mono metrics; Clear + Cmd/Ctrl+Enter work; the container is reaped (no leaks).

### File List
**New**
- apps/control-api/src/runs/hub.ts
- apps/control-api/src/runs/hub.test.ts
- apps/web/src/lib/runs.ts
- apps/web/src/lib/components/RunStatusDot.svelte

**Modified**
- apps/control-api/src/runs/orchestrator.ts
- apps/control-api/src/runs/routes.ts
- apps/control-api/src/app.ts
- apps/control-api/src/server.ts
- apps/control-api/src/runs/runs.test.ts
- apps/control-api/src/runs/sandbox.integration.test.ts
- apps/agent-harness/src/main.ts
- apps/web/src/routes/(app)/agents/[id]/+page.svelte
- apps/web/src/lib/design/warm-ink/colors.css
- apps/web/tests/agents.spec.ts

### Change Log
| Date | Change |
| --- | --- |
| 2026-08-01 | Story 4.2 implemented: RunHub + SSE relay (async POST /runs), harness metrics, web run client + EventSource, streaming test pane (running pulse, run-status dots, mono metrics, five states, Clear, Cmd/Ctrl+Enter). All gates green incl. 16/16 e2e live. Status → review. |
| 2026-08-02 | Code review: 7 patches applied (running-window pulse gap, concurrency-slot leak on create failure, non-terminal SSE `done` coercion, start-run generation token vs Clear/navigate, idempotent `hub.complete`, Cmd+Enter reveals collapsed pane, `killed`→caution per DESIGN.md) + 2 unit tests; 1 deferred, 2 dismissed. Re-verified: build 6/6, control-api 79 unit, svelte-check 0/0, lint clean, 7/7 agents e2e + gated integration live, no leaked containers. Status → done. |
