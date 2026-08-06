---
baseline_commit: 0188f9f3bfbf290b20e9f98bcaa703264038a608
---
# Story 12.3: The Guard forwards tools and meters the multi-call loop

Status: review

<!-- THIRD story of Epic 12 (Model-driven tool loop). 12.1 shaped the contract (GuardModelRequest.tools
     + GuardModelResponse.toolCalls); 12.2 filled the per-op schemas. 12.3 is the GUARD half: proxyModel
     forwards `tools`/`tool_choice` to LiteLLM and passes the model's `tool_calls`/`finishReason` back to
     the harness — so the model can actually be offered its tools and express a call. The keystone
     realization: the Guard needs NO loop awareness. It is stateless per call; the harness (12.4) drives
     the loop by making N proxyModel calls, and EACH call already meters on the per-run cost key and
     already emits kill-on-breach. So a multi-step turn is just N independent metered calls under ONE
     per-run cap — the cost cap bounds the loop for free, no new Guard machinery. A proven reference of
     the proxyModel forwarding is uncommitted in the working tree (from the seam spike); 12.3 FORMALIZES
     it (comment wording spike→Story 12.3) and adds the test coverage that hardens the three guarantees:
     tools forwarded, tool_calls returned, per-call metering + mid-loop kill unchanged. NO harness loop
     (12.4); the "killed run ends cleanly, last text stands" behavior is the harness loop's job (12.4) —
     here we only prove the Guard emits the kill on a tool-carrying call. -->

## Story

As a platform maintainer,
I want the Guard to offer the model its tools and stay the cost authority on every round-trip,
so that a multi-step tool loop is bounded and killed on breach exactly like a single call — with no new machinery and no weakened invariant.

## Acceptance Criteria

1. **Given** a model call that carries `tools`, **when** the Guard proxies it to LiteLLM, **then** it forwards `tools` + `tool_choice` (defaulting `"auto"`) in the `/v1/chat/completions` body and returns the model's `tool_calls` + `finishReason` to the harness on the `GuardModelResponse`. A call **without** `tools` is forwarded **byte-identically to before** (no `tools`/`tool_choice` keys in the body) and returns no `toolCalls`/`finishReason` — the non-tool (draft/skill) path is provably unchanged. No secret crosses the boundary: the request carries only tool names + arg schemas, the response only the model's chosen calls (AD-10). [Source: epics.md#Story-12.3 AC1, #Architecture-and-scope-decisions]

2. **Given** a loop of N model round-trips within one run, **when** each round-trip executes, **then** **every** call is authenticated with the run's **per-run cost key** (never the master key) and reports a `metrics` event out-of-band to the orchestrator (E4-AD-10) — so N tool-loop calls are N metered calls under one per-run cap, with **no new budget machinery** (the Guard is stateless per call; it holds no loop state). The fail-closed rule is unchanged: a registered run with no cost key refuses the call (NFR-2). [Source: epics.md#Story-12.3 AC2; Story 4.5 cost metering; AD-6]

3. **Given** the per-run or per-day budget is exceeded on a **tool-carrying** call mid-loop, **when** LiteLLM 400s it, **then** the Guard emits a `kill` event with the correct scope (run vs day) exactly as for a plain call, and returns `ok:false` with the gateway message — the breach path is agnostic to whether the call carried tools. (The harness loop ending cleanly with the last text that stood is Story 12.4's behavior; 12.3 proves only that the Guard signals the kill.) [Source: epics.md#Story-12.3 AC3; Story 4.5 kill-on-breach; NFR-2] 

## Tasks / Subtasks

- [x] **Task 1: Guard — formalize `proxyModel` tool forwarding + tool-call passthrough** (AC: #1)
  - [x] `apps/egress-guard/src/guard.ts` — verified the four spike edits against the finalized `GuardModelToolCall`: the body-spread (`:240`), the response body type incl. `tool_calls?: GuardModelToolCall[]` + `finish_reason?` (`:246`), the return-spread `...(toolCalls?.length ? { toolCalls, finishReason: … } : {})` (`:265`), and the `type GuardModelToolCall` import (`:26`). Formalized the comment wording — both "Tool-loop spike" comments in `proxyModel` now read "Story 12.3" and note the N-metered-calls-under-one-cap posture. No behavioral change.
  - [x] Confirmed the **non-tool path is byte-identical**: with `req.tools` undefined the body is exactly `{ model, messages }` (no `tool_choice`) and the return omits `toolCalls`/`finishReason` — proven by the key-absence test in Task 2.

- [x] **Task 2: Tests — tools forwarded, tool_calls returned, non-tool path unchanged** (AC: #1)
  - [x] `apps/egress-guard/src/guard.test.ts` — extended `costFetch` to capture each request `body` alongside `auth` and to optionally return `tool_calls` + `finish_reason` on the 200 response (a `modelOut?` param). Existing callers unchanged.
  - [x] Added: a `proxyModel` call carrying `tools` + `toolChoice` forwards `tools` and `tool_choice: "auto"` in the LiteLLM body, and the response's `tool_calls` + `finish_reason` come back on `GuardModelResponse.toolCalls`/`.finishReason`.
  - [x] Added: a call **without** `tools` sends a body with **no** `tools` and **no** `tool_choice` key (asserted by `"tools" in body` absence, not falsiness) and returns `toolCalls`/`finishReason` **undefined** — the non-tool path is byte-identical.

- [x] **Task 3: Tests — per-call metering + mid-loop kill on a tool call** (AC: #2, #3)
  - [x] Added: two `proxyModel` calls on the same registered run (two loop steps) emit **two** `metrics` events, each on `Bearer sk-run-costkey` (never the master key) — the "N calls = N metered" guarantee, Guard holding no loop state.
  - [x] Added: a **tool-carrying** call that 400s on a budget message emits a `kill` (run scope) + returns `ok:false` — the breach path is tools-agnostic.
  - [x] Confirmed the existing 4.5 metering/kill/fail-closed tests still pass unchanged (the body-spread is additive).

- [x] **Task 4: Verification** (AC: all)
  - [x] **guard unit** — 4 new tests pass; all existing guard tests still green. **guard 35** (was 31: guard.test.ts 30→34 + app.test.ts 1).
  - [x] `pnpm -r build` · `pnpm lint` (0) · full `pnpm -r test` green (domain 5, contracts 18, guard 35, harness 14, control-api 256, web 22).
  - [x] **contracts** unchanged — `git status packages/contracts` empty; no `CONTRACT_VERSION` bump.
  - [ ] **e2e — DEFERRED to Story 12.4:** the Guard forwarding is exercised end-to-end only when the harness loop drives it. Fold the live proof into 12.4's Mortimer acceptance demo. Standalone, a v9 harness stub sends no `tools`, so this path is inert. Never `down -v` the dev stack. See [[turanga-e2e-clean-run]].
  - [x] Bookkeeping: boxes checked, Dev Agent Record / File List / Change Log filled, Status → review.

## Review Findings (code review 2026-08-06)

- [x] [Review][Patch] Empty `tools: []` (truthy) forwards `tool_choice:"auto"` with zero tools — gate on `req.tools?.length` instead of `req.tools` (some gateways 400 on auto with no tools) [apps/egress-guard/src/guard.ts:240] — APPLIED
- [x] [Review][Patch] The `tool_choice ?? "auto"` DEFAULT branch is untested — the forwarding test passes `toolChoice` explicitly; add a case with tools present + `toolChoice` omitted asserting `body.tool_choice === "auto"` [apps/egress-guard/src/guard.test.ts] — APPLIED
- [x] [Review][Defer] Guard returns provider `tool_calls` unvalidated; a non-string `arguments` → harness strict-parse rejects the whole response [guard.ts:266] — deferred to Story 12.4 (only reachable once the loop drives tool calls)
- [x] [Review][Defer] `finishReason` dropped when `tool_calls: []` (degenerate provider response) [guard.ts:265] — deferred; low-value, treated as a plain answer which is acceptable

## Dev Notes

**The Guard is stateless per call — that is the whole story.** The model-driven loop is driven by the harness (12.4): it calls `guardModelCall` → the Guard's `proxyModel` → LiteLLM, N times per turn. The Guard holds **no** loop state; each `proxyModel` invocation independently (a) forwards the tools it was given, (b) meters on the per-run cost key, (c) emits `kill` on a budget breach. So a multi-step turn is simply **N independent metered calls under one per-run cap** — the Story 4.5 cost cap bounds the loop **for free**, no new budget machinery, no per-loop accounting. 12.3 makes `proxyModel` tool-aware and **proves** those three guarantees hold on tool-carrying calls; it does not build a loop.

### This formalizes a working-tree spike delta
The seam spike (proven offline) already wrote the `proxyModel` forwarding + tool-call passthrough; it is **uncommitted in the working tree** (`apps/egress-guard/src/guard.ts`, from Stories 12.1/12.4 spike work — 12.1 committed contracts but deliberately left guard.ts for this story). 12.3's code task is therefore small: verify the four spike edits against the finalized `GuardModelToolCall`, formalize the comment wording (spike→Story 12.3), and confirm the non-tool path is byte-identical. **The weight of 12.3 is the test coverage** (Tasks 2–3) that hardens the guarantees the spike proved only by construction.

### The metering + kill path (Story 4.5, unchanged)
`proxyModel` (`guard.ts:222-262`): a REGISTERED run without a cost key **refuses** (`:229-230`, fail-closed — no unmetered master-key fallback for a real run); otherwise it POSTs to `${litellmBaseUrl}/v1/chat/completions` with `Authorization: Bearer <costKey>` (`:235`); reads cost from `x-litellm-response-cost` → `costMicros` (`:244`); emits a `metrics` event to the orchestrator out-of-band (`:249`); on a non-ok response, `budgetBreach(status, message)` (`:179-182`) classifies a 400 + /budget|exceeded/ as run (or day for a team/crossed-spend message) and emits a `kill` (`:258`). **None of this changes for tools** — the body-spread is the only addition; metering + breach are computed from the response regardless of the request shape. That is exactly why N loop calls are N metered calls with kill-on-breach intact.

### Byte-identical non-tool path (the regression guard)
Every caller before 12.4 (the draft run path, the skills path, plain chat turns) sends a `GuardModelRequest` with **no** `tools`. The spike body-spread `...(req.tools ? {…} : {})` adds nothing in that case, so the LiteLLM body stays exactly `{ model, messages }` — and the return spreads nothing, so `toolCalls`/`finishReason` are absent. Task 2 asserts this by **key absence** (not just falsiness), so a future refactor can't silently start sending `tool_choice: undefined` on plain calls.

### Architecture (binding)
- **AD-1 / AD-5** — the Guard remains the sandbox's single egress; tools ride the SAME model-call channel that already exists. No new outbound edge.
- **AD-6 / Story 4.5** — the per-run cost key + kill-on-breach stay authoritative and now bound the multi-call loop; the Guard is the sole cost authority.
- **AD-9** — the Guard reads the immutable request; it never mutates policy or holds loop state.
- **AD-10** — `tools` (names + arg schemas) and `tool_calls` (the model's chosen calls) are secret-free; the LiteLLM key stays Guard-held, never in the sandbox, never in the response to the harness.

### Existing patterns to mirror (file:line)
- **The site:** `guard.ts:222-262` `proxyModel` — the body-spread (`:241`-ish), the response body type (`:242-245`), the return spread (post-`:256`), the `GuardModelToolCall` import (`:26` region).
- **The metering/kill machinery (unchanged):** `budgetBreach` (`:179-182`), `MICROS_PER_USD` (`:175`), the `emitRunEvent` metrics/kill emits (`:249`, `:258`).
- **The test harness:** `guard.test.ts` `describe("guard cost metering + kill-on-breach (4.5)")` (`:256`) — `modelReq` (`:257`), `costFetch(status,message,cost)` (`:259-268`, capturing `calls[].auth`), `withCostKey` (`:270-276`), and the four existing model-call tests (`:278-323`). Extend `costFetch` to capture the body + optionally return tool_calls; mirror the existing test shapes.
- **Contract (already in place):** `GuardModelRequest.tools`/`toolChoice`, `GuardModelResponse.toolCalls`/`finishReason`, `GuardModelToolCall` (Story 12.1, `packages/contracts/src/index.ts`).
- **Prior stories:** `12-1-*.md` (the contract + the spike-fold pattern), `12-2-*.md` (the split); [[epic-12-tool-loop]].

### Project Structure Notes
- **Edited:** `apps/egress-guard/src/guard.ts` (formalize the spike `proxyModel` forwarding + comments) and `apps/egress-guard/src/guard.test.ts` (extend `costFetch`; add forwarding / passthrough / non-tool / per-call-metering / tool-call-kill tests).
- **No change:** contracts (12.1), the orchestrator (12.2), the harness (the loop is 12.4 — 12.3 does NOT wire `runToolLoop`), web.
- **Scope guard:** NO harness loop, NO `runToolLoop` wiring, NO contract change, NO new Guard state. This story is: formalize the `proxyModel` tool forwarding + the tests that prove forwarding, passthrough, per-call metering, and mid-loop kill.

### Testing standards
- Vitest, co-located. Guard tests build a real `createGuard` with an injected `fetchImpl` fake (`withCostKey`) and capture `emitRunEvent` events. Assert on the captured LiteLLM request body (forwarding) and the returned `GuardModelResponse` (passthrough), plus the `metrics`/`kill` events. Keep the existing 4.5 tests green. Full verification: `pnpm -r build`, `pnpm lint`, `pnpm -r test`; e2e deferred to 12.4.

### References
- [Source: epics.md#Epic-12 + #Story-12.3 (Guard forwards tools→LiteLLM, returns tool_calls; every round-trip metered; kill-on-breach mid-loop) + #Architecture-and-scope-decisions (two backstops; the Guard is the cost authority)]
- [Source: architecture spine #AD-1, #AD-5, #AD-6, #AD-9, #AD-10 ; Story 4.5 (cost key + kill-on-breach)]
- [Source: guard.ts:222-262 (proxyModel), :179-182 (budgetBreach) ; guard.test.ts:256-323 (the 4.5 model-call test harness to extend)]
- [Source: contracts GuardModelRequest.tools/toolChoice + GuardModelResponse.toolCalls/finishReason (Story 12.1) ; 12-1/12-2 story files ; [[epic-12-tool-loop]]]

## Dev Agent Record

### Agent Model Used

claude-opus-4-8 (Claude Opus 4.8)

### Debug Log References

- **This story finally commits `guard.ts`.** The `proxyModel` forwarding rode in on the seam spike (uncommitted in the working tree since Story 12.1, which deliberately left `guard.ts` out of its commit). 12.3's code task was verification + comment formalization, not new logic — the weight was the four tests that harden what the spike proved by construction.
- **`costFetch` extended without breaking callers.** Added a 4th optional param (`modelOut?: { toolCalls?, finishReason? }`) and a captured `body` on each recorded call. The existing 4.5 cost tests (`calls[0].auth`, `res.ok`, `res.text === "hi"`) are untouched — the 200 response still carries `content:"hi"`, and `finish_reason:"stop"` on a tool-less response never triggers the return-spread (which keys on `toolCalls?.length`), so those responses still omit `finishReason`.
- **Non-tool regression guarded by KEY ABSENCE, not falsiness.** The test asserts `"tool_choice" in body === false`, so a future refactor that started sending `tool_choice: undefined` on a plain call would fail — catching a silent behavior drift a truthiness check would miss.
- **The Guard is provably stateless per call:** the two-step metering test issues two `proxyModel` calls on one registered run and gets exactly two independent `metrics` events on the per-run key — demonstrating N loop round-trips = N metered calls with no per-loop machinery.

### Completion Notes List

- **The Guard half of the loop, landed + hardened.** `proxyModel` forwards `tools`/`tool_choice` to LiteLLM (which normalizes function-calling across providers) and passes the model's `tool_calls`/`finishReason` back to the harness; the non-tool path is byte-identical (proven by key-absence). Comment wording formalized spike→Story 12.3.
- **The cost cap bounds the loop for free.** No new budget machinery: the Guard holds no loop state, each round-trip meters on the per-run cost key and emits kill-on-breach — so a multi-step turn is N metered calls under one per-run cap. Tests prove per-call metering (2 calls → 2 metrics) and a tools-agnostic breach path (a tool-carrying 400 still emits the run-scope kill).
- **Scope held:** no harness loop (12.4), no `runToolLoop` wiring, no contract change / `CONTRACT_VERSION` bump. Footprint is exactly `guard.ts` + `guard.test.ts`. The `toolLoop.ts` / AI SDK dep / `pnpm-lock.yaml` deltas stay untouched for 12.4. AD-1/5/6/9/10 intact.
- **Verification:** guard 35 (+4 new) / full `pnpm -r test` green (domain 5, contracts 18, harness 14, control-api 256, web 22); `pnpm -r build` + `pnpm lint` clean; contracts confirmed untouched. e2e deferred to 12.4's Mortimer acceptance demo (the Guard forwarding is only exercised end-to-end once the loop drives it).

### File List

**Edited — egress-guard**
- `apps/egress-guard/src/guard.ts` — `proxyModel`: forward `tools`/`tool_choice` to LiteLLM + return `tool_calls`/`finishReason` (formalized from the spike; comments spike→Story 12.3); non-tool path byte-identical
- `apps/egress-guard/src/guard.test.ts` — extended `costFetch` (capture body + optional tool_calls response); added 4 Story 12.3 tests (forwarding+passthrough, non-tool byte-identical, per-call metering, tools-agnostic kill)

### Change Log

| Date | Version | Description |
|------|---------|-------------|
| 2026-08-06 | 0.1 | Story 12.3 drafted. |
| 2026-08-06 | 0.2 | Story 12.3 implemented. proxyModel forwards tools/tool_choice to LiteLLM and returns tool_calls/finishReason (formalized from the working-tree spike delta; this is the commit where guard.ts lands); non-tool path byte-identical (key-absence tested). The Guard stays stateless per call → N loop round-trips are N metered calls under one per-run cap with kill-on-breach intact; no new machinery. 4 new guard tests (forwarding, passthrough, per-call metering, tools-agnostic kill). No harness loop (12.4), no contract change. Footprint: guard.ts + guard.test.ts. Verified: guard 35 + full pnpm -r test + build + lint green; contracts untouched. e2e deferred to 12.4. Status → review. |
