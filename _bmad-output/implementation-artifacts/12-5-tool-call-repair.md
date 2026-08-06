---
baseline_commit: 2d8dd21099bb309994f0fcb857bef254da6cc099
---
# Story 12.5: Tool-call repair — weak models self-correct

Status: review

<!-- FIFTH story of Epic 12. 12.4 made the loop live and already folds a tool-EXECUTION error back into
     context (the executor returns {error}, the model retries on the next step) and ends gracefully on a
     mid-loop failure. 12.5 adds the piece that a first-class reason we adopted the AI SDK: REPAIR of a
     MALFORMED tool call — the failure that happens BEFORE the executor runs. A weak model
     (gpt-oss-20b) often emits bad JSON arguments or a tool name that doesn't exist; without repair the
     SDK throws (NoSuchToolError / InvalidToolInputError) → 12.4's try/catch ends the run. 12.5 wires the
     SDK's `repairToolCall` so the malformed call is fed back and the model self-corrects WITHIN the step
     budget, and records each repair attempt on the transcript. An unrepairable call still ends cleanly
     (12.4's graceful stop). NO contract change (reuses the Story 6.5 `tool` event); NO new observability
     surface (the distinct per-step web view is 12.6). Small, focused: one generateText option + the
     repair strategy + its observability + tests. -->

## Story

As the builder running a smaller local model,
I want a malformed or failed tool call to be corrected rather than fatal,
so that a capable-but-streaky model reliably completes a multi-step task instead of dying on one flubbed call.

## Acceptance Criteria

1. **Given** the model emits a **malformed** tool call — bad/unparseable JSON arguments (`InvalidToolInputError`) or a tool name that doesn't exist (`NoSuchToolError`) — **when** the loop processes it, **then** the SDK's `repairToolCall` is invoked: the error + the offending call are fed back and the model is re-asked for a corrected call, which the loop then runs. A single malformed call is **not** a run failure. A tool **execution** error (the call ran but the tool returned an error) continues to fold back into context for a normal next-step retry (Story 12.4, unchanged). [Source: epics.md#Story-12.5 AC1; AI SDK `repairToolCall`]

2. **Given** repair attempts, **when** they occur, **then** each is **visible in the transcript** — a `tool` control-channel event (Story 6.5 schema, outcome `error`, a `detail` naming the repair, e.g. "malformed arguments — repairing") is emitted for the attempt, so a human can see the model recovered rather than the recovery being invisible. If the repair succeeds and the retried call runs, its own `ok` event follows — the transcript reads: attempt(error/repairing) → result(ok). No contract change (the existing `tool` event carries it). [Source: epics.md#Story-12.5 AC2; Story 6.5 observability]

3. **Given** a call that **cannot** be repaired within the step ceiling — the repair re-ask fails, returns nothing usable, or the model keeps flubbing until `stepCountIs(N)` — **when** the ceiling is reached (or `repairToolCall` returns `null`), **then** the run ends **cleanly** with the last text that stood and a recorded stop reason (`step-limit` or `error`) — never a crash and never a silent stop (Story 12.4's graceful end; NFR-2). Repair re-asks are metered model round-trips through the Guard, bounded by the same per-run cost cap. [Source: epics.md#Story-12.5 AC3; Story 12.4 graceful stop; Story 4.5 cost cap]

## Tasks / Subtasks

- [x] **Task 1: Harness — wire `repairToolCall` into the loop** (AC: #1)
  - [x] `toolLoop.ts` — added `repairToolCall` to the `generateText(...)` options. STRUCTURED repair for the malformed-args case: `generateObject` with the same `provider(spec.model)` + the failing tool's `inputSchema` (via `inputSchema({ toolName })`) regenerates valid arguments; returns `{ ...toolCall, input: JSON.stringify(object) }`. NO `generateText`-with-live-tools re-ask (that would double-execute). The re-ask routes through `makeGuardFetch` → the Guard (metered). The repair prompt includes the schema JSON (weak models need it — the provider doesn't enforce structured output without `structuredOutputs`).
  - [x] Both error kinds handled: `NoSuchToolError.isInstance(error)` → give up (`return null`, no repair possible); else (`InvalidToolInputError`) → structured repair. Imported `NoSuchToolError` + `generateObject` from `ai`. `return null` / a failed repair → the SDK falls through → the run ends gracefully (12.4).
  - [x] The tool **executor** is untouched — a tool that ran + errored still folds back via `{error}` (Story 12.4).

- [x] **Task 2: Harness — record each repair attempt on the transcript** (AC: #2)
  - [x] `toolLoop.ts` — `buildTools` now returns `{ tools, meta }` where `meta: Map<exposedName, {toolId, toolName, operation}>`; the `repairToolCall` closure looks the failing `toolCall.toolName` up in `meta` and `emit`s a `tool` event (`outcome:"error"`, `detail` "malformed arguments — repairing" or "no such tool — cannot repair"). A `NoSuchToolError` name not in `meta` uses the raw offered name. The eventual repaired call emits its own `ok` event.
  - [x] `tool` event schema unchanged (Story 6.5) — no contract bump.

- [x] **Task 3: Tests** (AC: #1, #2, #3)
  - [x] `toolLoop.test.ts` — 2 new fake-Guard tests: **(a)** an UNPARSEABLE-args tool call (`"{not valid json"`) → `InvalidToolInputError` → structured repair (`generateObject` returns valid args) → the call runs `ok` → final answer; asserts a repair `tool` event (error + "repairing" detail) AND the `ok` event, `stopReason: "final"`. **(b)** a call to a nonexistent tool → `NoSuchToolError` → a "no such tool" repair event, `return null`, and the loop ends cleanly (`step-limit`/`error` — both graceful). **harness 20** (was 18).
  - [x] All suites green.

- [x] **Task 4: Verification** (AC: all)
  - [x] `pnpm -r build` · `pnpm lint` (0) · full `pnpm -r test` green (harness 20, guard 36, control-api 256, contracts 18, domain 5, web 22).
  - [x] **contracts** unchanged — `git status packages/contracts` empty; no `CONTRACT_VERSION` bump.
  - [ ] **e2e — folds into the Story 12.4 Mortimer demo (still user-gated/pending).** With repair on, a `gpt-oss-20b` flubbed call self-corrects and the multi-step run completes. Never `down -v` the dev stack. See [[turanga-e2e-clean-run]].
  - [x] Bookkeeping: boxes checked, Dev Agent Record / File List / Change Log filled, Status → review.

## Dev Notes

**Repair is the pre-execute half; 12.4 already did the post-execute half.** Two different failure points:
- A tool that **ran** and returned an error → the executor returns `{error}` (Story 12.4), the SDK folds it into context as the tool result, and the model naturally retries on the next step. **Already works** — do not touch it.
- A tool call that is **malformed** — the JSON arguments don't match the schema (`InvalidToolInputError`) or the model named a tool that doesn't exist (`NoSuchToolError`) — fails **before** the executor. Without a repair function the SDK **throws**, which 12.4's try/catch turns into a graceful `stopReason:"error"` end — i.e. one flubbed call kills the whole run. **This is what 12.5 fixes:** `repairToolCall` feeds the error back and lets the model correct itself within the step budget. For a weak model like `gpt-oss-20b`, this is the difference between "usually fails on a bad-JSON call" and "recovers and finishes."

### Structured repair (regenerate the args) — and the double-execution trap to avoid
`repairToolCall` can do anything, but the clean, robust fix for `InvalidToolInputError` is **structured repair**: use `generateObject` against the failing tool's `inputSchema` to regenerate valid arguments, then return the same call with fixed `input`. **Do not re-ask with `generateText` + the live `tools`** — those tools carry `execute`, so a `generateText` re-ask would run the tool a second time (double side-effect) and throw the inner result away. `generateObject` produces only arguments, no execution. Either way the re-ask uses the **same** `provider(spec.model)`, so it routes through `makeGuardFetch` → the Guard — **metered on the per-run cost key**, bounded by the cost cap; no new egress or secret path (AD-1/AD-10 hold). For `NoSuchToolError`, giving up (`return null`) is acceptable (12.4 ends gracefully) unless a near-match is unambiguous.

### Observability without a contract change
The Story 6.5 `tool` control-channel event (`outcome: ok|error|refused`, `detail?`) already carries what a repair needs: emit it with `outcome:"error"` + a repair `detail` for the attempt; the eventual successful call emits its own `ok`. So the transcript shows the recovery (attempt→repair→ok) with **no `CONTRACT_VERSION` bump**. A distinct `repair` outcome + the richer per-step web rendering are **Story 12.6** — do not add them here. To label the repair event, `buildTools` must expose the exposed-name → `{toolId, toolName, operation}` map it already computes internally (the collision-fix disambiguation from 12.4).

### Bounds are unchanged (12.4 + 4.5)
A repair re-ask is a model round-trip → metered, and counts toward `stepCountIs(N)` pressure indirectly (the retried call is another step). An unrepairable call → `repairToolCall` returns `null` → the SDK throws → 12.4's try/catch ends the run with the last text + `stopReason`. So the two backstops (step ceiling + cost cap) already bound a repair storm; 12.5 adds no new limiter.

### Architecture (binding)
- **AD-1 / AD-10** — the repair re-ask is a normal model call through the Guard socket; no credential, no network in the sandbox. The provider `apiKey` placeholder is unchanged.
- **AD-6 / Story 4.5** — every repair re-ask is metered on the per-run cost key; the cost cap bounds repair storms for free.
- **AD-9** — repair reads the immutable spec's tools/schemas; it mutates no policy.

### Existing patterns / source (file:line)
- **The loop:** `apps/agent-harness/src/toolLoop.ts` — `runToolLoop` `generateText(...)` (the `repairToolCall` option goes here), `buildTools` (extend to return the exposed-name map), `makeGuardFetch` (the metered re-ask path), the try/catch graceful end (12.4). The fake-Guard test harness is in `toolLoop.test.ts`.
- **The observability event:** `packages/contracts/src/index.ts` `ControlChannelMessageSchema` — the `tool` variant (`outcome`, `detail`); `main.ts:toolRecord` builds it (exported, reusable).
- **AI SDK v7:** `repairToolCall` (stable; `experimental_repairToolCall` is the deprecated alias) — `(options: { toolCall, error: NoSuchToolError | InvalidToolInputError, messages, tools, inputSchema, system }) => Promise<LanguageModelV4ToolCall | null>`. Import the error types from `ai`.
- Prior stories: `12-4` (the loop + the graceful end + the collision-fix map), `12-1/12-2/12-3`; [[epic-12-tool-loop]].

### Project Structure Notes
- **Edited:** `apps/agent-harness/src/toolLoop.ts` (the `repairToolCall` strategy + the buildTools exposed-name map + the repair observability), `apps/agent-harness/src/toolLoop.test.ts` (repair tests).
- **No change:** contracts (no bump — the `tool` event carries it), the Guard, the orchestrator, web (the web step view is 12.6), `main.ts` (the executor is untouched).
- **Scope guard:** NO contract change / new event type, NO distinct `repair` outcome or web rendering (12.6), NO new bound/limiter, NO change to the tool executor's error fold-back. This story is: enable `repairToolCall` (re-ask strategy) + record the attempt on the existing `tool` event + tests.

### Testing standards
- Vitest, co-located. Extend the `toolLoop.test.ts` real-Unix-socket fake Guard — no live model. Drive `InvalidToolInputError` by giving a tool a strict `inputSchema` and having the fake model's first call omit a required arg; the repair re-ask is a subsequent fake model call returning a valid call. Assert the repair `tool` event + the final stop reason. Full verification: `pnpm -r build`, `pnpm lint`, `pnpm -r test`; e2e folds into 12.4's Mortimer demo.

### References
- [Source: epics.md#Epic-12 + #Story-12.5 (tool-call repair; weak-model self-correction; repair attempts visible; unrepairable → clean stop) + #Architecture-and-scope-decisions]
- [Source: architecture spine #AD-1, #AD-6, #AD-9, #AD-10 ; Story 4.5 (metering) ; Story 6.5 (`tool` observability event)]
- [Source: toolLoop.ts (runToolLoop/buildTools/makeGuardFetch + the 12.4 graceful end) ; AI SDK v7 `repairToolCall` + `NoSuchToolError`/`InvalidToolInputError`]
- [Source: 12-4 story file (the loop + collision-fix map to expose) ; [[epic-12-tool-loop]] ; [[turanga-e2e-clean-run]]]

## Dev Agent Record

### Agent Model Used

claude-opus-4-8 (Claude Opus 4.8)

### Debug Log References

- **KEY FINDING — the AI SDK's `jsonSchema()` does NOT validate by default.** The first test tried to trigger `InvalidToolInputError` with args that violate a `required` field (schema-invalid). It didn't fire: `jsonSchema(schema)` without a `validate` callback is a schema *hint* only — the SDK does not enforce it on tool inputs. So schema-invalid args pass straight to `execute`. `InvalidToolInputError` fires on **unparseable** args (JSON.parse failure), which is independent of validation — and that IS the realistic weak-model failure. The test now uses `arguments: "{not valid json"`. **Implication (noted for the future):** if we ever want schema-invalid detection too, pass a `validate` fn to `jsonSchema()`; today repair covers the parse-failure case (the common one).
- **`generateObject` runs in JSON-content mode (no server-side schema enforcement).** The provider warns `responseFormat … only supported with structuredOutputs` — the openai-compatible provider (structuredOutputs off) sends a plain json request and parses the content. So `generateObject` relies on the model returning valid JSON; the repair prompt now **includes the schema JSON** so a weak model knows the shape. `makeGuardFetch` reads only model/messages/tools (ignores `response_format`), so the repair call routes through the Guard like any other model call (metered).
- **`return null` on NoSuchTool doesn't throw immediately.** The SDK doesn't hard-throw when repair returns null; the model just re-emits the bad call each step, so the loop ends at the ceiling (`step-limit`) — still a graceful, non-crash end (12.4). The test accepts `step-limit` or `error`.
- **`ToolCall.input` is a stringified JSON.** Structured repair sets `input: JSON.stringify(regeneratedArgs)` (not an object) to match `LanguageModelV4ToolCall`.

### Completion Notes List

- **Weak models now self-correct.** `repairToolCall` is wired into the loop: a malformed tool call (unparseable JSON args → `InvalidToolInputError`, or an unknown tool → `NoSuchToolError`) is fed back and the model recovers WITHIN the step budget instead of the run dying on one flubbed call. Structured repair (`generateObject` against the tool's schema) regenerates valid arguments without re-executing the tool. The post-execute tool-error fold-back (12.4) is untouched.
- **Observable + secret-free + bounded:** each repair attempt is recorded on the existing Story 6.5 `tool` event (`error` + a repair `detail`) — **no contract bump**; the repair re-ask is a metered Guard model round-trip (AD-10 held — no credential/network in the sandbox); an unrepairable call ends cleanly via 12.4's graceful stop, bounded by the step ceiling + cost cap.
- **Scope held:** no contract change, no distinct `repair` outcome or web view (→ 12.6), executor untouched, no new limiter. Footprint is exactly `toolLoop.ts` + `toolLoop.test.ts`.
- **Verification:** harness 20 (+2), guard 36, control-api 256, contracts 18, domain 5, web 22 — all green; `pnpm -r build` + `pnpm lint` clean; contracts confirmed untouched. e2e folds into the 12.4 Mortimer demo (user-gated/pending).

### File List

**Edited — agent-harness**
- `apps/agent-harness/src/toolLoop.ts` — imported `generateObject` + `NoSuchToolError`; `buildTools` returns `{ tools, meta }` (exposed-name → {toolId,toolName,operation}); `runToolLoop` adds `repairToolCall` (structured `generateObject` repair for malformed args, `null` for no-such-tool, each attempt emitted as a `tool` event)
- `apps/agent-harness/src/toolLoop.test.ts` — 2 new tests (malformed-args repaired→succeeds; no-such-tool recorded→graceful end)

### Change Log

| Date | Version | Description |
|------|---------|-------------|
| 2026-08-06 | 0.1 | Story 12.5 drafted. |
| 2026-08-06 | 0.2 | Story 12.5 implemented. Wired AI SDK v7 `repairToolCall` into the loop — structured repair (`generateObject` against the tool's schema, routed through the Guard + metered) so a weak model's malformed call self-corrects instead of ending the run. Each attempt recorded on the existing `tool` event (no contract bump). Key finding: `jsonSchema()` doesn't validate by default, so repair fires on UNPARSEABLE args (the common weak-model case), not schema-invalid; the repair prompt includes the schema JSON since the provider doesn't enforce structured output. Post-execute error fold-back (12.4) untouched; unrepairable → 12.4 graceful stop. Verified: harness 20 / full pnpm -r test + build + lint green; contracts untouched. e2e folds into the 12.4 Mortimer demo. Status → review. |
