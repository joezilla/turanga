---
baseline_commit: 209d41f0db4a5498dfe09f5be5836f60f7ca776b
---
# Story 6.5: Tool invocation observability

Status: review

<!-- Fifth and FINAL story of Epic 6 — closes the epic. Story 6.4 made tools callable through the
     Guard, but a SUCCESSFUL tool call is invisible (it folds into the model context; only refusals
     surface, as a generic `refusal`). This story makes every tool invocation a RECORDED, structured
     event on the Run — count, latency, outcome, refusals — attributed per tool, and surfaces it in the
     UI. It is the exact enabler deferred from 6.4. Tools are OBSERVED ONLY: recorded, NOT metered
     against the cost cap and NOT killed on breach (decision 2026-08-03; the E4-AD-10 cost ledger is
     the hook if enforcement is ever wanted). This requires a CONTRACT_VERSION bump (5→6) to add a
     structured `tool` control-channel message — the same kind of bump Story 6.1 did (4→5). -->

## Story

As the builder,
I want to see how my tools are being used,
so that I can trust what's running and answer "what did it call, and what was blocked" — without cost surprises being the only signal.

## Acceptance Criteria

1. **Given** runs that invoked tools, **when** a tool's activity is viewed, **then** each shows **invocation statistics — count, latency, outcome, and any refusals — recorded per tool and on the Run** (NFR-4). Every tool call (success, tool-error, or refusal) is a structured record on the Run transcript, attributed to its tool + operation; the per-tool aggregate is viewable. [Source: epics.md#Story-6.5, NFR-4]
2. **Given** tool calls, **when** they execute, **then** they are **observed only** — recorded, **not metered against the cost cap and not killed on breach** (decision 2026-08-03; the E4-AD-10 ledger is the hook if enforcement is wanted later). The tool record carries NO cost and never touches the breach/kill path. [Source: epics.md#Story-6.5, decision 2026-08-03, E4-AD-10]

## Tasks / Subtasks

- [x] **Task 1: The structured `tool` control message + CONTRACT_VERSION bump (contracts)** (AC: #1, #2)
  - [x] `packages/contracts/src/index.ts` — add a `tool` variant to the `ControlChannelMessageSchema` discriminated union (index.ts:51-63), the recorded observability event the harness emits per invocation:
    ```ts
    z.object({
      type: z.literal("tool"),
      v: z.literal(CONTRACT_VERSION),
      toolId: z.string(),
      toolName: z.string(),   // denormalized for display (the harness has it from JobTool)
      operation: z.string(),
      outcome: z.enum(["ok", "error", "refused"]), // ok=success, error=tool isError/transport, refused=Guard denial
      latencyMs: z.number(),
      detail: z.string().optional(), // the refusal/error reason (never a secret — the Guard composed it)
    })
    ```
    NO cost field on this message (AC2 — observed only). Bump `CONTRACT_VERSION` (index.ts:12) `5 → 6` and add a `// v6 (Story 6.5): structured `tool` invocation records on the control channel` line to the header changelog (index.ts:6-11).
  - [x] **The bump ripple** (mechanical — Story 6.1 did 4→5 the same way): every `v: 5` literal moves to `6`. Sweep the test literals with `perl -i -pe 's/\bv: 5\b/v: 6/g'` across the SRC test files only (NOT dist): `apps/control-api/src/runs/runs.test.ts` (16), `apps/control-api/src/runs/hub.test.ts` (1), `apps/control-api/src/app.test.ts` (1), `apps/egress-guard/src/guard.test.ts` (7), and `apps/web/src/lib/runs.ts` (4 — the hand-mirrored union type literals). Then hand-fix: `packages/contracts/src/index.test.ts` `expect(CONTRACT_VERSION).toBe(5)` → `toBe(6)`, and extend its round-trip/parse coverage with the new `tool` variant. Verify no stray `v: 5` remains in src (`grep -rn "v: 5" apps packages --include=*.ts | grep -v dist`).
  - [x] Confirm the JobSpec/JobTool/ToolCall schemas are otherwise unchanged — this is purely an additive control-channel variant + the version literal.

- [x] **Task 2: The harness emits a structured tool record per call (agent-harness)** (AC: #1)
  - [x] `apps/agent-harness/src/main.ts` — replace the invisible success-fold with a structured emit. Refactor the Story 6.4 `toolOutcome` (main.ts:135-139) into a pure `toolRecord(toolId, toolName, operation, res: ToolCallResponse): { message: ControlChannelMessage; system?: string }` (exported for tests) that ALWAYS returns a `tool` control message:
    - `res.ok && !res.isError` → `outcome: "ok"`; `system: "Called <op>."` (still fold a context note for the model).
    - `res.ok && res.isError` → `outcome: "error"`; `detail`: a short note; `system: "Called <op> (the tool reported an error)."`.
    - `res.refusal` → `outcome: "refused"`; `detail: res.refusal.detail`; no system note (a blocked call is not context).
    - a transport/plain error (`!res.ok && !res.refusal`) → `outcome: "error"`; `detail: res.error`.
    - `latencyMs: res.latencyMs ?? 0` on every message (the Guard sets it on success + refusal).
  - [x] In the Phase-1b tool loop (main.ts:187-198), `emit(rec.message)` for EVERY tool call (not only refusals), and push `rec.system` into the model context when present. This is the behavior change: a successful tool call now leaves a transcript trace. The tool call is still NOT a run failure (a refused/errored tool call doesn't fail the run — same posture as a blocked send).
  - [x] The harness still emits nothing cost-related for a tool call (AC2). `toolName` comes from `spec.tools[].name` (the JobTool).

- [x] **Task 3: Per-agent tool-stats aggregation (control-api) — mirror the cost endpoint** (AC: #1, #2)
  - [x] `apps/control-api/src/runs/repo.ts` — add a `ToolStat` type + `aggregateToolStats(agentId: string): Promise<ToolStat[]>` (the `sumTodayMicros` analogue, repo.ts:126-132). `ToolStat = { toolId: string; toolName: string; invocations: number; ok: number; errors: number; refusals: number; avgLatencyMs: number; lastUsedAt: string | null }`. Implementation: read the agent's runs' transcripts, reduce the `tool` messages per `toolId` (count by `outcome`, average `latencyMs`, track the latest `createdAt`). Memory repo: iterate the in-memory rows; drizzle repo: `select id, transcript, createdAt from runs where agentId = ?` then reduce in JS (tool messages are sparse; a `LIMIT` on recent runs is a fine later bound — note it, don't add cost-cap-style complexity). Keep it read-only; NO write, NO cost interaction (AC2).
  - [x] `apps/control-api/src/runs/routes.ts` — add `GET /agents/:id/tool-stats` (session-guarded like `/agents/:id/cost` at routes.ts:46-48) → `c.json({ stats: await repo.aggregateToolStats(id) })`. Place it beside the cost routes.
  - [x] **Orchestrator: NO change.** The harness's `tool` control message is recorded on the transcript automatically by the existing `execute()` loop (`ControlChannelMessageSchema.safeParse` → `appendMessage` + `hub.publish`, orchestrator.ts:271-280) once the contract carries the variant. Confirm the message does NOT flow through `onMetrics`/`handleGuardEvent` (that's the cost/kill path — AC2); it's an in-band transcript message only.

- [x] **Task 4: Render tool activity (web)** (AC: #1, #2)
  - [x] `apps/web/src/lib/runs.ts` — after the Task-1 `v: 5→6` sweep, add the `tool` variant to the hand-mirrored `RunMessage` union (runs.ts:10-14): `| { type: "tool"; v: 6; toolId: string; toolName: string; operation: string; outcome: "ok" | "error" | "refused"; latencyMs: number; detail?: string }`. Add a `ToolStat` type + `getAgentToolStats(agentId): Promise<Result<ToolStat[]>>` (the `getAgentCost` analogue, runs.ts:63-71).
  - [x] `apps/web/src/lib/components/RunTranscript.svelte` — add a `{:else if msg.type === "tool"}` row after the refusal branch (RunTranscript.svelte:24-33): show the tool name + operation (operation mono), the **outcome as a dot + word** (NFR-6/UX-DR15 — never colour-only: ok / error / refused, using the state tokens — e.g. `--state-*`), the `latencyMs` mono+tabular, and the `detail` on error/refused. One edit covers BOTH the live test pane and the run-review page (both render this component).
  - [x] `apps/web/src/routes/(app)/agents/[id]/runs/[runId]/+page.svelte` — extend the `isRenderable` guard (runs/[runId]/+page.svelte:41) with `|| m.type === "tool"` so tool rows render on the run-review page.
  - [x] `apps/web/src/routes/(app)/agents/[id]/+page.svelte` — fetch `getAgentToolStats(id)` on load (beside `getAgentCost`/`listTools`) and render a compact **per-tool activity** readout in (or just below) the Tools `<Section>` (agent page :409-411): for each attached tool with stats, `{invocations} call(s) · {refusals} refused · {avgLatencyMs}ms avg` (counts + latency mono+tabular). This is the "when a tool's activity is viewed" surface. A tools/stats outage must not block editing (empty on error, like the providers/tools loads).
  - [x] Voice/UX (UX-DR16, NFR-6, UX-DR15): sentence case, outcome as dot + word, numbers mono+tabular, an empty state ("No tool calls yet.") where a tool has no activity.

- [x] **Task 5: Tests + verification** (AC: all)
  - [x] **contracts unit** (`index.test.ts`): the `tool` message parses (all three outcomes); `CONTRACT_VERSION` is `6`; a `v: 5` message fails the current schema (mixed-version guard). Update the existing round-trip assertions to `6`.
  - [x] **agent-harness unit** (`main.test.ts`): `toolRecord` maps ok→`tool{outcome:"ok"}` + a system note; isError→`outcome:"error"`; a refusal→`outcome:"refused"` with the detail and NO system note; a transport error→`outcome:"error"` with the detail; `latencyMs` is carried. (Replaces the 6.4 `toolOutcome` tests — the harness behavior evolved.)
  - [x] **control-api unit** (`runs.test.ts`): seed a run whose transcript has `tool` messages (ok/error/refused for one tool + a second tool) → `aggregateToolStats(agentId)` returns the correct per-tool `{ invocations, ok, errors, refusals, avgLatencyMs, lastUsedAt }`; an agent with no tool calls → `[]`. `GET /agents/:id/tool-stats` returns the shape (session-guarded — 401 without a session). **AC2 assertion:** a run with tool messages accrues NO `costMicros` from them (the run's cost summary is unaffected by tool calls) and no `kill` is triggered.
  - [x] **web unit** (if a component test exists) or **svelte-check**: `RunTranscript` renders a `tool` row with the outcome word + latency. At minimum `svelte-check` 0.
  - [x] **Playwright e2e (isolated stack incl. `mcp-stub`, serial):** the payoff 6.4 couldn't assert — connect the stub tool, grant `get_time`, run the agent, and the run transcript (test pane or run-review) shows a **`tool` row: "Weather · get_time · ok"** with a latency. Given run-streaming flakiness keep it best-effort but now there IS a positive artifact to assert. Distinct `x-forwarded-for` per `signIn`; clean up.
  - [x] `svelte-check` 0 · `pnpm -r build` (8 workspaces) · `pnpm lint` · all unit suites · e2e green · teardown. **Run e2e via `deploy/test-stack.sh` (project `turanga-e2e`) — NEVER `docker compose down -v` on the dev stack** (it wipes `Clyde`/`Untitled agent`/`wopr`). `pnpm -r build` before any Docker build (the contract bump touches every service — rebuild all images for the e2e; a `.default([])` Zod field is optional on input but required on output, so `pnpm -r build` catches what `pnpm -r test` misses). Restore the dev stack after; verify data intact.

## Dev Notes

**The epic closer. Story 6.4 made tools callable but left successful calls invisible (they fold into the model context; only refusals surfaced, as a generic `refusal`). This story makes every tool invocation a structured, recorded event on the Run — count, latency, outcome, refusals — attributed per tool, and surfaces the per-tool aggregate. Tools stay OBSERVED-ONLY: recorded, never metered, never killed (AC2).**

### The design: mirror the cost/metrics spine, but IN-BAND (no Guard change)
Cost is the existing observability precedent: the Guard measures it, reports a `GuardRunEvent` OUT-OF-BAND, the orchestrator accumulates a summary, it's persisted + streamed + rendered, with an aggregate `/agents/:id/cost` endpoint. Cost went out-of-band because it must be **Guard-authoritative to kill**. **Tools are observed-only (no kill), so the lighter mirror is IN-BAND**: the harness emits a structured `tool` control message (it already has `toolId`/`toolName`/`operation`/`latencyMs`/outcome from the `ToolCallResponse`), the orchestrator's existing transcript loop records it automatically, and the aggregate is computed from the transcript. **This needs NO egress-guard change** — `forwardTool` already returns `latencyMs` in-band (Story 6.4).

| Concern | Cost (out-of-band template) | Tools (this story, in-band) |
|---|---|---|
| Source | Guard `emitRunEvent` → `GuardRunEvent` | harness `emit` → `tool` ControlChannelMessage |
| Contract | `GuardRunEvent{metrics}` | a `tool` variant on `ControlChannelMessage` (v6 bump) |
| Record on Run | `onMetrics` → `appendMessage` | the existing `execute()` transcript loop (no orchestrator change) |
| Kill/meter | yes (cost cap, breach) | **NO — observed only (AC2)** |
| Aggregate endpoint | `GET /agents/:id/cost` → `sumTodayMicros` | `GET /agents/:id/tool-stats` → `aggregateToolStats` |
| Client | `getAgentCost` | `getAgentToolStats` |
| Render | test-pane cost meter | RunTranscript tool rows + a per-tool activity readout |

### Why the CONTRACT_VERSION bump is required (and correct)
Every control-channel message pins `v: z.literal(CONTRACT_VERSION)`, and the orchestrator's `ControlChannelMessageSchema.safeParse` silently drops any message whose `v` doesn't match — so a new variant can't be mixed into v5; it MUST bump to v6. This is the same additive bump Story 6.1 did (4→5, adding tools to the JobSpec). The ripple is mechanical: `CONTRACT_VERSION = 6`, the changelog line, and a `perl` sweep of the `v: 5` test literals + the web `runs.ts` union (the client union is hand-mirrored by design, not imported — keep it in sync). Recurring lesson: after the bump run `pnpm -r build` (tsc) AND `pnpm -r test` — and rebuild ALL Docker images for the e2e, since every service speaks the contract.

### Architecture (binding)
- **AC2 — observed, not metered (the load-bearing constraint):** the `tool` message carries NO cost and NEVER flows through `onMetrics`/`handleGuardEvent`/the breach-kill path. It is an in-band transcript record only. Assert in a test that a run with tool calls accrues no `costMicros` from them and triggers no `kill`. Do NOT add a cost field, a cap check, or a kill hook for tools — the E4-AD-10 ledger stays the (unused) hook.
- **AD-10:** the `tool` record carries `toolId`/`toolName`/`operation`/`outcome`/`latencyMs`/`detail` — NEVER the endpoint URL or the credential (the Guard composed the `detail`; it never includes a secret). The harness only ever knew logical handles anyway.
- **NFR-4 (never silent) / NFR-6 (status is dot + word):** a refusal is recorded with its cause; the outcome renders as a coloured dot PAIRED with a word (ok/error/refused), never colour-only.
- **AD-7:** control-api owns Run state; the aggregate endpoint is read-only over the runs it owns.

### Existing patterns to mirror (exact file:line)
- **Control-channel union + version:** `packages/contracts/src/index.ts` — `ControlChannelMessageSchema` (51-63), `CONTRACT_VERSION` (12), the changelog header (6-11). `ToolCallResponse` (134-143) is the source of `latencyMs`/`isError`/`refusal`.
- **Transcript recording (no change needed):** `apps/control-api/src/runs/orchestrator.ts` `execute()` loop (271-280) `safeParse → appendMessage → hub.publish`; the cost path to AVOID for tools is `onMetrics` (251-256) + `handleGuardEvent` (333-338).
- **Cost aggregate = the tool-stats template:** `GET /agents/:id/cost` (`routes.ts:46-48`) → `sumTodayMicros` (`repo.ts:126-132`) → `getAgentCost` (`web/src/lib/runs.ts:63-71`) → rendered (`agents/[id]/+page.svelte:475-479`). Clone this spine as `/agents/:id/tool-stats` → `aggregateToolStats` → `getAgentToolStats` → the Tools-section readout.
- **RunRow/transcript:** `apps/control-api/src/runs/repo.ts` — `RunRow.transcript: ControlChannelMessage[]` (8-18), `appendMessage` jsonb-append (119-125), `setStatus` (112-118); `runs.transcript` jsonb column (`schema.ts:80`). The tool message flows through `appendMessage` unchanged; NO new column (the aggregate is computed from the transcript).
- **Harness emit + the 6.4 tool loop:** `apps/agent-harness/src/main.ts` — `emit` (31-33), `toolOutcome` (135-139, refactor → `toolRecord`), the Phase-1b loop (187-198), `guardToolCall` (120-128).
- **Web render:** `RunTranscript.svelte` (turn 19-23 / refusal 24-30 / metrics 31-33 → add a `tool` branch); the client union `runs.ts:10-14`; the test-pane derived-metrics precedent (`agents/[id]/+page.svelte:68-70` — filter transcript by type, reduce); the run-review `isRenderable` (`runs/[runId]/+page.svelte:41`).

### Project Structure Notes
- Edited: `packages/contracts/src/index.ts` (+ its test), `apps/agent-harness/src/main.ts` (+ test), `apps/control-api/src/runs/{repo,routes}.ts` (+ runs.test.ts), `apps/web/src/lib/runs.ts`, `apps/web/src/lib/components/RunTranscript.svelte`, `apps/web/src/routes/(app)/agents/[id]/+page.svelte`, `apps/web/src/routes/(app)/agents/[id]/runs/[runId]/+page.svelte`, and the `v: 5→6` sweep across the test files listed in Task 1. No new files, no new dependency, no schema/migration (the aggregate is transcript-derived).
- **CONTRACT_VERSION bump 5→6** is the one cross-cutting change — every service + the web speak it; rebuild all Docker images for the e2e.
- Scope guard: NO metering/kill for tools (AC2), NO Guard change (in-band), NO new DB column, NO container tools (Epic 7), NO cross-agent global tool dashboard (the per-agent + per-run surfaces satisfy AC1; a global Settings→Tools lifetime stat is a possible follow-up, not this story).

### Testing standards
- Vitest for the contract (the `tool` variant parses; version is 6), the harness (`toolRecord` mappings + latency), and control-api (`aggregateToolStats` correctness + the endpoint + the **AC2 no-cost/no-kill** assertion). `svelte-check` for the web render. Playwright serial e2e via the **isolated `deploy/test-stack.sh`** (incl. `mcp-stub`) — now assertable: a granted tool call shows a `tool` row with outcome + latency. Distinct `x-forwarded-for` per `signIn`; `pnpm -r build` before any Docker build; rebuild ALL images (contract bump); **never `down -v` the dev stack.**

### References
- [Source: _bmad-output/planning-artifacts/epics.md#Epic-6, #Story-6.5 — invocation statistics per tool + on the Run; observed-not-metered (decision 2026-08-03); the E4-AD-10 ledger hook]
- [Source: _bmad-output/implementation-artifacts/6-4-invoke-a-tool-at-runtime-through-the-guard.md — the tool broker + `ToolCallResponse.latencyMs`; the DEFERRED structured tool event this story delivers; the invisible-success gap]
- [Source: _bmad-output/implementation-artifacts/6-1-tool-model-and-management.md — the v4→v5 CONTRACT_VERSION bump precedent (same mechanical ripple)]
- [Source: the cost/metrics observability spine — contracts `GuardRunEvent`/`ControlChannelMessage`; orchestrator `onMetrics`/`execute` loop; `/agents/:id/cost` + `sumTodayMicros`; the test-pane cost meter]
- [Source: architecture spine #AD-7, #AD-10, E4-AD-10 (the Guard→orchestrator ledger — cost/kill only, tools observed-only); NFR-4 (never silent), NFR-6 (dot + word)]
- [Source: project-context.md — UI tokens/NFR-6, voice UX-DR16, a11y UX-DR15, mono+tabular numbers; build/test expectations]
- [Source: deploy/test-stack.sh + the 2026-08-03 infra rule — isolate e2e; never `down -v` the dev stack]

## Dev Agent Record

### Agent Model Used
claude-opus-4-8[1m] (Claude Code)

### Debug Log References
- **Live end-to-end verification (definitive AC1):** ran a real agent with a granted `get_time` tool on the isolated stack — the run transcript now carries a structured record `{v:6, type:"tool", toolId, toolName:"StubTime", operation:"get_time", outcome:"ok", latencyMs:28}` (a successful call is no longer invisible — the exact 6.4 gap), and `GET /agents/:id/tool-stats` returned `{invocations:1, ok:1, errors:0, refusals:0, avgLatencyMs:28, lastUsedAt:…}`. AC2 confirmed: the run's `costMicros` was unaffected by the tool call.
- **e2e infra flake diagnosed + fixed:** the initial e2e failures were NOT the feature. (1) A **stale Vite dev server** from an earlier session held port 5173, so a fresh `npm run dev` fell back to 5174 and Playwright hit the old server — killed all Vite + freed the port. (2) A `test-stack.sh reset` recreates LiteLLM cold; its **key-generation path (`/key/generate`, needs its DB tables) isn't ready when the healthcheck passes**, so the first runs failed at "Couldn't mint the cost key: fetch failed" (empty transcript, no tool call). Fix: after a reset, **poll `/key/generate` until it succeeds (~11-12s) before running run-dependent e2e**; the 6.5 test also retries the run via the API until one records a tool call. With that, the full 28-test e2e suite passes clean. This refines the e2e-isolated-test-stack procedure.

### Completion Notes List
- **Contract (Task 1):** added a `tool` variant to `ControlChannelMessageSchema` (`{ toolId, toolName, operation, outcome: ok|error|refused, latencyMs, detail? }` — NO cost, AC2) and bumped `CONTRACT_VERSION` 5→6 with a changelog line. The bump ripple was mechanical (a `perl` sweep of ~29 `v: 5` test literals + the web `runs.ts` union → `v: 6`, plus the contracts test `toBe(6)`) — the same additive bump Story 6.1 did (4→5). No JobSpec/JobTool/ToolCall shape change.
- **Harness (Task 2):** refactored `toolOutcome` → `toolRecord`, which emits a structured `tool` message for EVERY call (ok / error / refused, with latency + detail) — a successful call now leaves a transcript trace. Still folds a context note for the model on success; still never fails the run; still emits nothing cost-related.
- **Aggregation (Task 3):** `RunsRepo.aggregateToolStats(agentId)` (+ a shared pure `reduceToolStats`) reduces the `tool` messages across the agent's recent runs (bounded to 500) into per-tool `{ invocations, ok, errors, refusals, avgLatencyMs, lastUsedAt }`; `GET /agents/:id/tool-stats` mirrors `/agents/:id/cost`. **The orchestrator needed no change** — the existing transcript loop records the message automatically; it never touches `onMetrics`/the kill path (AC2, asserted).
- **Web (Task 4):** the `tool` variant + `getAgentToolStats` on the client; a `tool` row in `RunTranscript` (name · operation · **outcome as dot + word** ok/error/refused · latency mono) covering both the live test pane and the run-review page; the run-review `isRenderable` guard extended; a compact per-tool activity readout in the agent's Tools section (calls / refused / errors / avg latency).
- **Tests (Task 5):** contracts +1 (the `tool` variant parses all outcomes, no cost, a v5 message is rejected); harness `toolRecord` mappings +4; control-api `aggregateToolStats` correctness + empty case + the AC2 no-cost assertion + the endpoint session-guard; a Playwright e2e (connect stub → grant → run records a tool call → the Tools-section activity readout shows it — the payoff 6.4 couldn't assert).
- **Verification:** `pnpm -r build` (8 workspaces) · svelte-check 0/0 · `eslint .` clean · units all green (contracts 12→13, agent-harness 8→9, control-api 142→145 +1 skipped, egress-guard 31, domain/web unchanged) · full 28-test e2e suite green on a clean isolated stack (all images rebuilt for the contract bump). Dev stack restored, data intact (`Clyde`, `Untitled agent`, `wopr`).
- **Scope held:** observed-not-metered (no cost/kill for tools — AC2), NO Guard change (in-band via the harness), NO new DB column (transcript-derived), NO container tools (Epic 7), NO cross-agent global tool dashboard (per-agent + per-run surfaces satisfy AC1). **This closes Epic 6.**

### File List
- `packages/contracts/src/index.ts` (the `tool` variant + CONTRACT_VERSION 5→6) · `packages/contracts/src/index.test.ts`
- `apps/agent-harness/src/main.ts` (toolOutcome → toolRecord; emit per call) · `apps/agent-harness/src/main.test.ts`
- `apps/control-api/src/runs/repo.ts` (ToolStat + reduceToolStats + aggregateToolStats, both impls)
- `apps/control-api/src/runs/routes.ts` (GET /agents/:id/tool-stats)
- `apps/control-api/src/runs/runs.test.ts` (v6 sweep + aggregateToolStats tests) · `apps/control-api/src/runs/hub.test.ts` (v6) · `apps/control-api/src/app.test.ts` (v6 + endpoint guard)
- `apps/egress-guard/src/guard.test.ts` (v6 sweep)
- `apps/web/src/lib/runs.ts` (v6 + the `tool` variant + ToolStat + getAgentToolStats)
- `apps/web/src/lib/components/RunTranscript.svelte` (the `tool` row)
- `apps/web/src/routes/(app)/agents/[id]/+page.svelte` (per-tool activity readout)
- `apps/web/src/routes/(app)/agents/[id]/runs/[runId]/+page.svelte` (isRenderable += tool)
- `apps/web/tests/providers.spec.ts` (Story 6.5 e2e)

### Change Log
- 2026-08-03 — Story 6.5 implemented (closes Epic 6): every tool invocation is now a structured, recorded event on the Run — a `tool` control-channel message (CONTRACT_VERSION 5→6) the harness emits per call carrying outcome + latency, recorded on the transcript automatically and aggregated per tool via `GET /agents/:id/tool-stats`. Rendered as tool rows in the run transcript + a per-tool activity readout on the agent page. Observed only — no cost, no kill (AC2). Verified live end-to-end + a full clean e2e suite. Status → review.
