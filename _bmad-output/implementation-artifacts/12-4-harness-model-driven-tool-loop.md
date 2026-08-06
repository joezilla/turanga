---
baseline_commit: 4eccab8d2144f969c3f8c25a490365f700d7aa93
---
# Story 12.4: The model-driven loop replaces the stub

Status: review

<!-- FOURTH + keystone story of Epic 12. 12.1 shaped the contract, 12.2 filled the per-op schemas, 12.3
     made the Guard forward tools + meter each round-trip. 12.4 is where it comes alive: the Vercel AI
     SDK loop (`runToolLoop`, proven in the seam spike) REPLACES the deterministic Phase-1b stub in
     runHarness. The model is offered its tools, CHOOSES which to call with what args, each call is
     brokered through the Guard (grant + credential enforced — AD-10), the result folds back, and it
     iterates until a final answer or `stopWhen: stepCountIs(N)`. The SDK owns COGNITION; turanga keeps
     TRANSPORT + ENFORCEMENT (the Guard socket, no credential/network in the sandbox). This story also
     FOLDS IN the Epic-12 code-review findings that were deferred to 12.4 (deferred-work.md): the two
     HIGHs — a duplicate op-name across two tools must not misroute, and a mid-loop kill must NOT crash
     the harness (end gracefully with the last text that stood). Distinct stop-reason transcript events
     + the web step view are Story 12.6; repair is Story 12.5 — 12.4 delivers the working loop + the
     safety fixes + the Mortimer acceptance demo. The Gmail SKILLS path (4.4) is UNTOUCHED. -->

## Story

As the builder,
I want my agent to reason, call a tool, see the result, and continue until it answers,
so that it actually USES the tools I granted — instead of denying them or firing one blind predetermined call.

## Acceptance Criteria

1. **Given** a sandboxed run whose agent has granted tools, **when** the harness runs the turn, **then** the **Vercel AI SDK loop** (`runToolLoop`) replaces the Phase-1b stub: the model is given the tool manifest, chooses calls, each is brokered via `guardToolCall` (the Guard enforcing the grant + injecting the credential — AD-10), the **real MCP result** folds back into context, and it iterates to a final answer bounded by `stopWhen: stepCountIs(N)` (configurable, default ~10 — the control backstop). The loop's final text is emitted as the agent turn; every model call leaves the sandbox **only** via the Guard socket, holding no credential and reaching no network (AD-1, AD-10). [Source: epics.md#Story-12.4 AC1, AC2; #Architecture-and-scope-decisions]

2. **Given** an agent with **no** granted tools, **when** its run executes, **then** the existing **single model call** path is unchanged — a normal text answer for the draft/test-console and chat (Epic 9) flows (the loop degenerates away; no regression). The deterministic **skills** read→draft→send ops (Story 4.4, Guard send-gate) still bracket the run in both paths; **only the blind `operations[0]` stub is removed**, no skill behavior regresses. [Source: epics.md#Story-12.4 AC3, AC4; AD-8]

3. **Given** the code-review findings deferred to 12.4, **when** the loop is wired, **then** it is robust: **(a)** two attached tools that share an operation name never misroute — the SDK tool key is unique per `(toolId, operation)`, and the executor brokers against the **correct** `toolId`; **(b)** a mid-loop model failure or cost-cap kill does **NOT** throw an unhandled rejection — the harness ends **gracefully** with the last assistant text that stood and a recorded stop reason (never a bare crash — NFR-2); **(c)** an empty `tools:[]` does not force `tool_choice`; **(d)** a granted op whose `inputSchema` is not a `type:"object"` schema falls back to a permissive object schema (never a provider 400); **(e)** a Guard **refusal** is surfaced to the model distinctly from a tool **error** (so it stops retrying a permanently-denied op). [Source: deferred-work.md (Epic 12 review, 2026-08-06); NFR-2]

4. **Given** the sandbox image, **when** it is built, **then** the Vercel AI SDK (`ai@^7`, `@ai-sdk/openai-compatible@^3`) ships in the harness `node_modules` (raw-`tsc`, ESM/NodeNext — no bundler change); the custom `fetch` holds **no credential** (the provider `apiKey` is a literal placeholder; the real LiteLLM key is Guard-held) and reaches **no network** (its only egress is the UDS; `--network=none` fails closed anything else). `package.json` + `pnpm-lock.yaml` are committed with the story. [Source: epics.md#Architecture-and-scope-decisions; AD-1, AD-10]

5. **Given** the acceptance demo (the deferred Stage-2 proof), **when** the finished loop runs against **Mortimer's unchanged config** (`gpt-oss-20b` + the BitsBy8 tool, 12 granted ops incl. `list_drives`) on the dev stack, **then** the model selects tools, the Guard brokers each call, the result folds back, the run completes with a real multi-step answer, and the transcript records each tool call. Invariants verified live: no credential in the sandbox, `--network=none` holds, the per-run cost cap bounds the loop, and kill-on-breach fires mid-loop. [Source: epics.md#Story-12.4 Acceptance demo]

## Tasks / Subtasks

- [x] **Task 1: Harness — formalize `toolLoop.ts` + fix the op-name collision (review HIGH)** (AC: #1, #3a)
  - [x] `toolLoop.ts` header + inline comments formalized (spike → Story 12.4).
  - [x] **Cross-tool misroute fixed:** `buildTools` now builds a **unique exposed name per `(toolId, op)`** (bare op name, disambiguated to `Tool_op` then `op_<idsuffix>` on collision, via a `used` Set + `sanitize`), and `execute` closes over the ORIGINAL `toolId` + `operation` — so two tools sharing an op name each route to their own id. `toolRecord` still records the real names. Proven by the new collision test.
  - [x] **Non-object schema fallback:** added `objectSchema()` — uses `op.inputSchema` only when it is object-typed (`type:"object"` or no explicit type), else the permissive open object. A `{type:"array"}` schema no longer reaches the provider.
  - [x] **Refusal-distinct:** `execute` returns `{ error: "Not permitted: … — do not retry this operation." }` on a Guard refusal, distinct from a tool execution error.
  - [x] **Empty-tools gate:** `makeGuardFetch` gates on `oa.tools?.length`.

- [x] **Task 2: Harness — graceful mid-loop failure (review HIGH) + stop-reason** (AC: #1, #3b)
  - [x] `runToolLoop` wraps `generateText` in try/catch and accumulates `lastText` + `stepsSeen` via `onStepFinish`; on a thrown mid-loop failure it **resolves** `{ text: lastText, steps: stepsSeen, stopReason: "error" }` (never rejects). `ToolLoopResult.stopReason` grew to `"final" | "step-limit" | "error"`. **Key correctness fix:** `makeGuardFetch` now returns a **NON-retryable 400** (not 502) for a Guard failure — retrying a cost-cap-killed run is pointless (the next call is killed too) and a 5xx triggered SDK backoff retries that hung the loop; the 400 throws immediately → graceful end. Proven by the kill-salvage test.
  - [x] The entrypoint catch (`main.ts`) still maps any escape to `done:failed` — the loop's try/catch is the graceful path; the entrypoint is the last-resort net.

- [x] **Task 3: Harness — wire `runToolLoop` into `runHarness`, delete the stub** (AC: #1, #2)
  - [x] `main.ts` — **deleted the Phase-1b stub.** Phase 2 now branches on `spec.tools.length`: tools → `const loop = await runToolLoop(...)` (agent turn = `loop.text`, `ok = loop.stopReason !== "error"`); no tools → the existing single `guardModelCall` unchanged. `done` status uses the branch `ok`. Phase-1 read + Phase-3 write skills ops bracket both. The skills path (4.4) is untouched.
  - [x] **Scope note (documented, not solved):** the loop builds context from the spec (`toPrompt`), not the skills-read-folded `messages` — a skills+tools agent loses skills-read notes inside the loop. Agents are skills-XOR-tools in practice; the merge is out of scope (open question in Dev Notes).
  - [x] Used a **lazy `import("./toolLoop.js")`** inside the tools branch — the AI SDK loads only for a tools run, keeping the no-tools/skills path + `main.test.ts` light and avoiding a main↔toolLoop load cycle. `main.test.ts` (12 unit tests) still green.

- [x] **Task 4: Dependencies + image** (AC: #4)
  - [x] `package.json` carries `ai@^7.0.52` + `@ai-sdk/openai-compatible@^3.0.23` (runtime deps); `pnpm-lock.yaml` has the resolved tree. Committed with this story (held out of 12.1–12.3).
  - [x] Dockerfile needs **no bundler change** (raw `tsc`, ESM/NodeNext, `node:22-slim`); the SDK ships in `node_modules`. Image-size increase is acceptable — the sandbox has no network + no secret (AD-1/AD-10 are what let us tolerate the dependency).

- [x] **Task 5: Tests** (AC: #1, #2, #3)
  - [x] `toolLoop.test.ts` — 4 new fake-Guard tests: **(a)** shared op name across two tools routes each to its own `toolId` (no misroute); **(b)** a mid-loop `ok:false` → `runToolLoop` resolves with the last text + `stopReason:"error"`; **(c)** empty `tools:[]` → single call, no `tool_choice` forwarded; **(d)** a `{type:"array"}` inputSchema → permissive fallback, loop completes. **harness 18** (was 14).
  - [x] `main.test.ts` — the 12 unit tests still pass (pure helpers; the stub deletion didn't regress them). The loop-vs-single-call **branch** runtime proof is the offline `toolLoop.test.ts` (the loop path) + the Mortimer e2e; a full `runHarness` integration test is not added (it needs env/stdout/socket mocking — the offline loop tests + e2e cover the behavior).
  - [x] All suites green (harness 18, guard 36, control-api 256, contracts 18, domain 5, web 22).

- [x] **Task 6: Verification + the acceptance demo (e2e)** (AC: all, #5)
  - [x] `pnpm -r build` · `pnpm lint` (0) · full `pnpm -r test` green.
  - [ ] **e2e — the Mortimer acceptance demo — PENDING (user gated, 2026-08-06).** Not run: the live demo stops the running dev stack to rebuild the v9+AI-SDK harness image. The loop, both HIGH fixes, and the LOWs are all proven offline (deterministic fake-Guard unit tests) and the full build compiles the v9+AI-SDK harness. Run when ready via `deploy/test-stack.sh` (isolated `turanga-e2e`; never `down -v` the dev stack; rebuild the harness image; wait for LiteLLM key-readiness) against Mortimer's unchanged config (`gpt-oss-20b` + BitsBy8) — verify the loop end-to-end + the invariants live. See [[turanga-e2e-clean-run]] / [[e2e-isolated-test-stack]].
  - [x] Bookkeeping: boxes checked, Dev Agent Record / File List / Change Log filled, Status → review.

## Dev Notes

**This is where the tool loop comes alive.** 12.1–12.3 built the rails (contract, per-op schemas, Guard forwarding + metering). 12.4 puts the AI SDK engine on them: `runToolLoop` (the proven spike) replaces the deterministic stub, and the model finally drives. The architecture principle holds exactly: **the SDK owns cognition** (loop, step-counting, tool-call parsing, result fold-back), **turanga owns transport + enforcement** — the two injection points are `makeGuardFetch` → `guardModelCall` (no key in the sandbox; the Guard meters + kills) and each tool `execute` → `guardToolCall` (the Guard enforces the grant + injects the credential). The SDK's only egress is the UDS; `--network=none` (AD-1) fails closed anything else.

### Fold in the review findings — two are HIGH, do not skip them
The Epic-12 code review (deferred-work.md, 2026-08-06) found the spike `toolLoop.ts` carries defects that are latent only because it isn't wired yet. Wiring it (this story) makes them live, so 12.4 **must** fix them:
- **HIGH — duplicate op-name cross-tool misroute** (`buildTools`, `tools[name]` keyed by op name only). Two tools each granting `search` → the second overwrites the first → a model call to `search` is silently brokered against the wrong tool's `toolId` + credential + endpoint. **This is a security/correctness bug** (wrong credential, wrong endpoint). Fix: unique key per `(toolId, op)`; the executor resolves the real `toolId` from the closure.
- **HIGH — mid-loop kill throws, no partial-text salvage.** No try/catch around `generateText`; a cost-cap breach or gateway error → 502 → the SDK throws → `runToolLoop` rejects with zero text, contradicting the epic AC ("killed run ends cleanly, last text stands"). Fix: try/catch + `onStepFinish` last-text accumulation + a `stopReason`.
- LOW — non-object schema → provider 400; refusal-vs-error conflation; empty-`tools:[]` gate. Cheap; fold them.

### The wiring seam (main.ts) — tools XOR the single call; skills bracket both
`runHarness` today: Phase-1 skills-read → Phase-1b **stub** → Phase-2 single model call → Phase-3 skills-write → done. 12.4 replaces Phase-1b + Phase-2 with a branch on `spec.tools.length`: tools → `runToolLoop`; no tools → the existing single `guardModelCall` (draft/test-console/chat + skills-draft). Phase-1/Phase-3 skills ops bracket **both** — the skills path (4.4) is untouched. **Known edge (out of scope, note it):** the loop builds context from the spec (`toPrompt`), not the skills-read-folded `messages`, so a skills+tools agent loses skills-read notes inside the loop; agents are skills-XOR-tools in practice — flag as an open question, don't build the merge now.

### Stop reasons: 12.4 = "don't crash + surface something"; 12.6 = the rich distinction
12.4 grows `ToolLoopResult.stopReason` to `"final" | "step-limit" | "error"` and guarantees the harness never throws. The **distinct** stop reasons (final / step-limit / **cost-cap-kill**), the per-step `tool` transcript ordering, and the web completed-turn step view are **Story 12.6** (observability). A cost-cap kill is signaled out-of-band by the Guard→orchestrator `kill` event (Story 4.5) which reaps the run; the harness just ends gracefully — do not try to detect the kill *inside* the sandbox (there's no side-channel; AD-9).

### Architecture (binding)
- **AD-1** — the loop runs inside the `--network=none` sandbox; the Guard socket is its ONE egress. The AI SDK dependency is tolerable **because** of this — a supply-chain issue in its tree still can't exfiltrate (no network) or hold a key.
- **AD-6 / Story 4.5** — every model round-trip in the loop is metered on the per-run cost key by the Guard (Story 12.3); N calls under one cap; kill-on-breach mid-loop. The `stepCountIs(N)` ceiling is the independent control backstop.
- **AD-9** — the JobSpec is immutable; the loop consumes it (`toPrompt`, `buildTools`), never mutates policy or reaches a side-channel.
- **AD-10** — no secret in the sandbox: the provider `apiKey` is a literal placeholder, `makeGuardFetch` ignores request headers (reads only `init.body`), the Guard holds the LiteLLM key + every tool credential, and the response to the harness carries only `text`/`toolCalls`/`finishReason`/`tokens`.

### Existing patterns / source (file:line)
- **The spike (your reference):** `apps/agent-harness/src/toolLoop.ts` (+ `toolLoop.test.ts`) — `makeGuardFetch` (`:23`), `toPrompt` (`:61`), `buildTools` (`:78`, the collision to fix), `runToolLoop` (`:103`, the try/catch to add). Uses `ai@7` `generateText`/`stepCountIs`/`tool`/`jsonSchema` + `@ai-sdk/openai-compatible` `createOpenAICompatible({ fetch })`.
- **The wiring point:** `main.ts` `runHarness` — Phase-1b stub (`:216-227`, delete), Phase-2 single call (`:229-234`), the entrypoint catch (`:245-248`). Exports `guardModelCall`/`guardToolCall`/`toolRecord` (used by `toolLoop.ts`).
- **The contract (in place):** `GuardModelRequest.tools/toolChoice`, `GuardModelResponse.toolCalls/finishReason`, `JobTool.operations` objects (Stories 12.1/12.2). **The Guard (in place):** `proxyModel` forwarding + metering (Story 12.3).
- **Review guardrails:** `_bmad-output/implementation-artifacts/deferred-work.md` (the 12.4 section). Prior stories: `12-1`…`12-3`; [[epic-12-tool-loop]].

### Project Structure Notes
- **Edited:** `apps/agent-harness/src/toolLoop.ts` (formalize + collision fix + try/catch + fallbacks), `apps/agent-harness/src/main.ts` (wire the loop, delete the stub), `apps/agent-harness/src/toolLoop.test.ts` + `apps/agent-harness/src/main.test.ts` (tests), `apps/agent-harness/package.json` + `pnpm-lock.yaml` (the AI SDK dep — committed now).
- **No change:** contracts (12.1/12.2), the Guard (12.3), the orchestrator, web (the web step view is 12.6), the skills path (4.4).
- **Scope guard:** NO distinct cost-cap-kill stop-reason event or web step view (12.6), NO tool-call repair tuning (12.5 — the SDK's default repair is on, but the dedicated story hardens it), NO skills+tools context merge, NO parallel tool calls / streaming / sub-agents (epic-deferred). This story is: wire the loop, delete the stub, fix the two HIGH findings + the cheap LOWs, ship the dep, prove Mortimer.

### Testing standards
- Vitest, co-located. `toolLoop.test.ts` uses a real Unix-socket fake Guard (already built in the spike) — extend it; no live model. `main.test.ts` asserts the branch (loop vs single-call). Full verification: `pnpm -r build`, `pnpm lint`, `pnpm -r test`, then the **e2e Mortimer demo** via `deploy/test-stack.sh` (rebuild the v9+AI-SDK harness image; never `down -v` the dev stack; warm Vite before any Playwright). This is the epic's headline proof.

### References
- [Source: epics.md#Epic-12 + #Story-12.4 (the AI SDK loop replaces the stub; stopWhen stepCountIs(N); skills untouched; the Mortimer acceptance demo) + #Architecture-and-scope-decisions]
- [Source: architecture spine #AD-1, #AD-6, #AD-9, #AD-10 ; Story 4.5 (cost key + kill-on-breach) ; Story 4.4 (skills path)]
- [Source: toolLoop.ts (the spike) + main.ts runHarness:216-234 (the wiring point) ; contracts 12.1/12.2 + guard 12.3 (the rails)]
- [Source: deferred-work.md#Epic-12-review (the 12.4 guardrails — the two HIGHs) ; 12-1…12-3 story files ; [[epic-12-tool-loop]] ; [[turanga-e2e-clean-run]] ; [[e2e-isolated-test-stack]]]

## Dev Agent Record

### Agent Model Used

claude-opus-4-8 (Claude Opus 4.8)

### Debug Log References

- **The 502→400 fix was both a test cure AND a correctness fix.** The kill-salvage test timed out at 5s because the AI SDK **retries on 5xx** (default backoff) — so a mid-loop 502 from `makeGuardFetch` triggered retries that hung the loop. Returning a **non-retryable 400** for a Guard failure fixed it: the SDK throws immediately, `runToolLoop` catches it, and the run ends gracefully. This is the right behavior regardless of the test — retrying a cost-cap-killed run is pointless (the next call is killed too).
- **`onStepFinish` accumulates `lastText`.** AI SDK v7's `StepResult` exposes `readonly text: string`; the callback fires after each step (model call + tool executions). So on a throw at step N+1, `lastText` holds step N's assistant text and `stepsSeen` the count — surfaced as the graceful `stopReason:"error"` result.
- **Lazy `import()` avoided the main↔toolLoop cycle + kept the unit test light.** `toolLoop.ts` imports `guardModelCall`/`guardToolCall`/`toolRecord` from `main.ts`; `main.ts` importing `runToolLoop` at the top level would be a load-time cycle and pull the AI SDK into every `main.test.ts` run. A dynamic `import("./toolLoop.js")` inside the `spec.tools.length > 0` branch defers the SDK load to an actual tools run.
- **Collision routing correctness is in the closure, not the key.** The bug was `tools[name]` overwriting; the fix makes the exposed KEY unique so both entries survive, and each `execute` closes over its own `toolId`/`operation` (per-iteration `const`), so routing is correct by construction. The disambiguation only needs to keep keys distinct.
- **`main.test.ts` unaffected by the stub deletion:** its 12 tests exercise pure helpers (`readJobSpec`, `buildMessages`, `opOutcome`, `toolRecord`), not the `runHarness` flow — so removing the Phase-1b stub didn't touch them.

### Completion Notes List

- **The loop is live.** `runToolLoop` (the AI SDK reason→act→observe loop) replaces the deterministic Phase-1b stub in `runHarness`: an agent with granted tools has the model choose calls, each brokered via `guardToolCall` (Guard enforces grant + injects credential — AD-10), results fold back, iterating under `stopWhen: stepCountIs(10)`. An agent with no tools keeps the single model call unchanged (draft/test-console/chat); the Gmail skills path (4.4) brackets both and is untouched. This is the direct fix for the original "Mortimer can't access its tools" bug — the model is now *told* its tools and *drives* them.
- **Both HIGH review findings fixed + proven:** (1) two tools sharing an op name route to their own `toolId` (unique exposed key + closure over the real id) — no cross-tool credential/endpoint misroute; (2) a mid-loop model failure / cost-cap kill ends **gracefully** with the last text that stood + `stopReason:"error"` — never a bare crash (NFR-2). Plus the LOWs: non-object-schema fallback, refusal-distinct, empty-tools gate. The extra 400-non-retryable fix stops the SDK from backoff-retrying a killed run.
- **AD-10 held throughout:** no secret in the sandbox — the provider `apiKey` is a literal placeholder, `makeGuardFetch` reads only `init.body` (ignores headers), the Guard holds the LiteLLM key + tool credentials, and the harness sees only text/toolCalls/finishReason/tokens.
- **Scope held:** distinct cost-cap-kill stop-reason event + web step view = **12.6**; repair hardening = **12.5**; skills+tools context merge = open question (not built). The AI SDK dep ships with this story.
- **Verification:** harness 18 (+4), guard 36, control-api 256, contracts 18, domain 5, web 22 — all green; `pnpm -r build` + `pnpm lint` clean. **The Mortimer e2e (AC5) is user-gated/pending** — the one unchecked box, documented in Task 6 (the loop + fixes are fully proven offline; the e2e is the live headline demo).

### File List

**Edited — agent-harness**
- `apps/agent-harness/src/toolLoop.ts` — formalized (spike→12.4); op-name collision fix (unique exposed key + closure); `objectSchema` non-object-schema fallback; refusal-distinct; empty-tools gate; non-retryable 400 on Guard failure; try/catch + `onStepFinish` graceful end; `stopReason` grew to `"final"|"step-limit"|"error"`
- `apps/agent-harness/src/main.ts` — deleted the Phase-1b stub; Phase-2 branches on `spec.tools.length` (loop via lazy import vs single call); `done` status from the branch `ok`
- `apps/agent-harness/src/toolLoop.test.ts` — 4 new tests (collision, kill-salvage, empty-tools, non-object-schema); describe retitled to Story 12.4
- `apps/agent-harness/package.json` — `ai@^7.0.52` + `@ai-sdk/openai-compatible@^3.0.23` runtime deps (committed now)
- `pnpm-lock.yaml` — the resolved AI SDK tree

### Change Log

| Date | Version | Description |
|------|---------|-------------|
| 2026-08-06 | 0.1 | Story 12.4 drafted. |
| 2026-08-06 | 0.2 | Story 12.4 implemented (code + unit tests). The Vercel AI SDK loop (runToolLoop) replaces the Phase-1b stub in runHarness (branch on spec.tools.length via lazy import; no-tools single-call + skills 4.4 untouched). Folded in the deferred Epic-12 review findings: the two HIGHs (op-name cross-tool misroute → unique key + closure; mid-loop kill must not crash → try/catch + onStepFinish salvage + stopReason "error"; plus a non-retryable 400 so the SDK doesn't backoff-retry a killed run) and the LOWs (non-object-schema fallback, refusal-distinct, empty-tools gate). Ships the AI SDK dep. Verified: harness 18 / guard 36 / control-api 256 / full pnpm -r test + build + lint green. The Mortimer e2e (AC5) is user-gated/pending — the one open item. Status → review. |
