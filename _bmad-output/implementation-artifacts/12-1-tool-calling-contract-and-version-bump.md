---
baseline_commit: 0c9ef3dc03575cc64781902877a12fe3c3b9ef63
---
# Story 12.1: The tool-calling contract + version bump (spine)

Status: review

<!-- FIRST story of Epic 12 (Model-driven tool loop — the Epic 6 follow-on that makes tools real).
     The epic replaces the deterministic Story-6.4 stub (the harness blindly fires each tool's
     operations[0] and NEVER tells the model its tools exist) with a real reason→act→observe loop on
     the Vercel AI SDK. 12.1 lays the CONTRACT SPINE before any loop runs: (A) widen the harness↔Guard
     model-call contract so the model can be TOLD its tools and can EXPRESS a call — GuardModelRequest
     gains `tools` (OpenAI function-calling shape) + `toolChoice`; the message schema gains the `tool`
     role + `tool_calls`/`tool_call_id`; GuardModelResponse gains `toolCalls` + `finishReason`; (B)
     reshape the sandbox-visible `JobTool.operations` from `string[]` to `{name, description?,
     inputSchema?}[]` so the model gets each granted op's ARGUMENT SCHEMA (real schema resolution is
     12.2 — 12.1 emits a NAME-only placeholder, keeping the system compiling + working); (C) bump
     CONTRACT_VERSION 8→9 — the familiar lockstep sweep. This story RUNS no loop — 12.3 forwards tools
     Guard→LiteLLM, 12.4 puts the AI SDK loop in the harness (deletes the stub). A PROVEN reference
     implementation of the widened GuardModel* shapes exists uncommitted on branch
     `spike/agent-tool-loop` (additive, no bump); 12.1 FORMALIZES it with the version bump + the
     JobTool.operations reshape. Keep 12.1 to the contract shape + the version bump + the minimal
     ripples that keep the build green; resist the loop, the real schema resolution, and tool forwarding. -->

## Story

As a platform maintainer,
I want the harness↔Guard contract to carry tools and tool calls, with each granted operation described by its argument schema,
so that the model can be told exactly what it may call and can express a call — with no secret ever crossing the sandbox boundary — before any loop is built on it.

## Acceptance Criteria

1. **Given** the contracts package, **when** the model-call contract is extended for tool use, **then** `GuardModelRequest` gains an optional `tools` (OpenAI function-calling shape: `{ type: "function", function: { name, description?, parameters? } }`, `parameters` a JSON-Schema object held as an opaque record) and an optional `toolChoice`; the model message schema gains the `tool` **role** plus optional `tool_calls`/`tool_call_id` (and `content` becomes nullable — an assistant turn that only calls tools carries null content); `GuardModelResponse` gains optional `toolCalls` + `finishReason`. Every added field is **secret-free** — a logical tool name + an argument schema, never an endpoint or credential (AD-10). All additions are **optional**, so a plain (draft/skill) model call that omits them is byte-identical to today and behaves exactly as before. [Source: epics.md#Story-12.1 AC1, #Architecture-and-scope-decisions]

2. **Given** `JobTool` (the sandbox-visible tool handle), **when** a tool's granted operations are described to the model, **then** `operations` changes from `string[]` to `{ name: string; description?: string; inputSchema?: <JSON-Schema record> }[]` so an operation can be called with structured arguments — still no endpoint/credential in the spec (AD-10). This story emits a **name-only placeholder** (`{ name }`, empty/omitted description + inputSchema); resolving each op's **real** description + input schema from the registered tool is **Story 12.2**. The three ripples that keep the system working end-to-end are handled: `resolveRunTools` builds the new object shape; the sandbox-visible `JobTool.operations` is the **only** shape that changes — `ProvisionTool.operations` / the Guard's grant-enforcement allow-list stay `string[]` names; and the Phase-1b harness stub keeps compiling + running (reads `operations[0].name`). [Source: epics.md#Story-12.1 AC2, AC "least-privilege / bounded footprint"; #Architecture-and-scope-decisions (SDK owns cognition; turanga owns enforcement)]

3. **Given** a breaking shape change to the agent↔harness↔Guard contract, **when** it is published, **then** `CONTRACT_VERSION` is **bumped 8→9** and every producer/consumer re-pins in lockstep via the `z.literal(CONTRACT_VERSION)` symbol (zero manual edits at the 15 literal sites); the only two hardcoded sites are updated — `contracts/index.test.ts` (`.toBe(8)`→`9`) and `apps/web/src/lib/runs.ts` (six `v: 8`→`v: 9` in the `RunMessage` mirror, which deliberately doesn't import contracts). Backward-safe: `tools`/`toolChoice`/`toolCalls`/`finishReason` are optional and `JobTool.operations` still defaults `[]`, so an existing (non-tool) run builds a valid v9 spec; the agent-harness image must be rebuilt to a v9 harness (a v8 harness would fail `JobSpecSchema.parse()` on a v9 spec). `pnpm -r build` / `pnpm lint` / all unit suites stay green. [Source: epics.md#Story-12.1 AC3; the 7→8 bump in Story 9.1 as the exact ritual]

## Tasks / Subtasks

### Cluster A — the tool-calling contract shapes (AC #1)

- [x] **Task 1: Contracts — add the tool-calling schemas + widen the model message/request/response** (AC: #1)
  - [x] `packages/contracts/src/index.ts` — added `GuardModelToolSchema`/`GuardModelToolCallSchema`/`GuardModelMessageSchema` (+ exported types) next to `GuardModelRequestSchema` (folded from the spike; comments formalized "spike"→"Story 12.1"). OpenAI function-calling shape; secret-free (name + arg schema, no endpoint/credential — AD-10); `parameters`/`inputSchema` opaque JSON-Schema records.
  - [x] `GuardModelRequestSchema` — `messages: z.array(GuardModelMessageSchema)` + optional `tools`/`toolChoice` (tool-loop-optional; a plain call omits them → unchanged).
  - [x] `GuardModelResponseSchema` — added optional `toolCalls` + `finishReason` (present with finishReason "tool_calls" when acting; absent on a plain text answer).
  - [x] **Prepended the v9 version-history line** as the new top entry of the block (above `// v8 (Story 9.1)`).
  - [x] **Guard mirror:** `apps/egress-guard/src/guard.ts` — `proxyModel` already imports `type GuardModelToolCall` (spike); verified against the finalized type — build green. (Tool forwarding to LiteLLM is present from the spike but is Story 12.3's scope; it is inert here — no caller passes `tools` until 12.4.)

### Cluster B — the JobTool.operations reshape (AC #2)

- [x] **Task 2: Contracts — reshape `JobTool.operations` to carry argument schemas** (AC: #2)
  - [x] `packages/contracts/src/index.ts` — added `JobToolOperationSchema` (`{ name, description?, inputSchema? }`, `inputSchema` opaque JSON-Schema record) + `export type JobToolOperation`; `JobToolSchema.operations` now `z.array(JobToolOperationSchema)`. Header comment updated (Story 12.1 shape; 12.2 fills real description+inputSchema).
  - [x] `packages/contracts/src/index.test.ts` — JobSpec/JobTool round-trip literals reshaped to `[{ name: "x" }]`; added JobTool op round-trip (`{name,description?,inputSchema?}`), name-only valid, missing-`name` rejected, secret-free (extra keys stripped).

- [x] **Task 3: Orchestrator — `resolveRunTools` emits the object shape (name-only placeholder)** (AC: #2)
  - [x] `apps/control-api/src/runs/orchestrator.ts` — `jobTools.push(...)` now emits `operations: operations.map((name) => ({ name }))` for the **sandbox-visible** JobTool only; the `string[]` at the filter is left untouched and still feeds `provisionTools.push({ ..., operations })`. Comment added: name-only placeholder; 12.2 resolves real description + inputSchema.
  - [x] Confirmed `guardClient.ts`/`egress-guard/src/guard.ts` `ProvisionTool.operations: string[]` + `tool.operations.includes(req.operation)` are **unchanged** — the Guard still enforces grants against string names; only the sandbox manifest gained schemas (verified: runs.test.ts asserts the split).

- [x] **Task 4: Harness — keep the Phase-1b stub compiling + working after the reshape** (AC: #2)
  - [x] `apps/agent-harness/src/main.ts` — stub now reads `const operation = tool.operations[0]?.name;` (Story 12.1 comment); the guard/record calls keep working with the operation **name** exactly as before. Keep-green only — Story 12.4 deletes this stub. Also applied the same `op.name` keep-green fix to the spike's `toolLoop.ts:buildTools` (12.4's artifact) so the working tree stays green; it now prefers the op's own `description`/`inputSchema` when present.

### Cluster C — the version bump 8→9 (AC #3)

- [x] **Task 5: Bump `CONTRACT_VERSION` 8→9 + update the two hardcoded sites** (AC: #3)
  - [x] `packages/contracts/src/index.ts` — `CONTRACT_VERSION` `8` → `9`. All 15 `z.literal(CONTRACT_VERSION)` sites re-pinned automatically via the symbol; backend consumers unchanged.
  - [x] `packages/contracts/src/index.test.ts` — `expect(CONTRACT_VERSION).toBe(9)`; test title updated to "Story 12.1 — tool loop"; the stale `(v7)` mixed-version comment corrected to `(v9)`.
  - [x] `apps/web/src/lib/runs.ts` — six `v: 8` → `v: 9` in the `RunMessage` union + the "currently 9" comment. No new union member (tools are a JobSpec/harness↔Guard concern, not a streamed transcript event).
  - [x] Verified no other hardcoded version-8 literal exists in source (grep `apps/**` + `packages/**`, excl. `/dist/`, `.svelte-kit`, `node_modules`): the exhaustive set was exactly `runs.ts:12-17` + `index.test.ts:6`, both updated.

### Cluster D — tests + verification (AC: all)

- [x] **Task 6: Tests + full verification** (AC: all)
  - [x] **contracts unit** (`index.test.ts`) — `CONTRACT_VERSION === 9`; `GuardModelRequest` round-trips with `tools` + a `tool`-role message carrying `tool_calls`, and a plain request omitting `tools` still parses (backward-compat) + a tool def is secret-free; `GuardModelResponse` round-trips `toolCalls`+`finishReason` and parses without them; a `JobTool` op round-trips `{name,description?,inputSchema?}`, name-only valid, missing-`name` rejected, secret-free. **18 tests green** (+3 new).
  - [x] **control-api unit** — `runs.test.ts` asserts the built `JobTool.operations` is `[{ name }]` objects for granted ops AND `provisionTools.operations` stays `string[]` names (the split preserved). **255 passed / 1 skipped.**
  - [x] **harness unit** (`main.test.ts`) — the stub test passes with `operations` as objects (stub reads `operations[0].name`); the spike's `toolLoop.test.ts` reshaped to object ops. **14 tests green.**
  - [x] **guard unit** — **31 tests green** (proxyModel/broker unaffected by the contract widen).
  - [x] **web** — `svelte-check` clean (0 errors / 0 warnings; six `v: 9` literals typecheck; ToolsEditor/AgentToolsTab consume the registered `Tool.operations` + `attachedTools` names, not `JobTool` — unaffected).
  - [x] `pnpm -r build` (all workspaces incl. web + the v9 harness tsc) · `pnpm lint` (0 errors) — all green.
  - [ ] **e2e via `deploy/test-stack.sh` — DEFERRED (user decision 2026-08-05).** Not run to avoid tearing down the live dev stack. Justification: 12.1 is contract-only, backward-safe (optional fields, `JobTool.operations` defaults `[]`), **no migration**, and **no runtime-path change** for a no-tools run — fully covered by the unit suites + the full `pnpm -r build` (which compiles the v9 harness). The one thing e2e would add — a rebuilt **v9 harness image** boots + completes a run — should be folded into 12.3/12.4's e2e, where the loop actually exercises tools. **Never `down -v` the dev stack.** See [[turanga-e2e-clean-run]] / [[e2e-isolated-test-stack]].
  - [x] Bookkeeping: task boxes checked, Dev Agent Record / File List / Change Log filled, Status → review.

## Dev Notes

**The contract spine before the loop.** Epic 12 makes tools real: the model is told what it may call, chooses, the Guard brokers, the result folds back, it iterates (the AI SDK owns that cognition; turanga owns transport + enforcement). 12.1 builds only the **contract shape** the loop stands on — the tool-calling fields on the model call, the per-op argument schema on `JobTool`, and the version bump — WITHOUT forwarding tools to LiteLLM (12.3) or running the loop (12.4). Resist implementing either; keep the diff to the contract + the minimal ripples that leave the system building and the existing stub working.

### The spike is your reference implementation (branch `spike/agent-tool-loop`)
A **proven** Phase-0 seam spike (offline, deterministic, harness 14/14 + guard 31/31 green) already widened `GuardModelRequest`/`Response`/the message schema **additively (no version bump)** and taught `guard.ts:proxyModel` to forward tools. 12.1 formalizes those shapes with the **CONTRACT_VERSION bump 8→9** and adds the piece the spike stubbed over: the **`JobTool.operations` reshape** (the spike used a permissive open-object arg schema in `toolLoop.ts`, not a typed `JobTool`). Operationally: either build 12.1 **on** the spike branch (the GuardModel* widenings are already there uncommitted — add the bump, the `JobTool` reshape, the placeholder in `resolveRunTools`, and the tests) or re-derive on `prototype/prealpha` from the ACs above. Either way the ACs are the target; don't ship the loop or tool-forwarding as part of 12.1.

### The version bump (8→9) — the familiar sweep, mostly symbolic
`CONTRACT_VERSION` re-pins via `z.literal(CONTRACT_VERSION)` at all **15** sites in `contracts/index.ts`, and every backend consumer references the **symbol** — they re-pin in lockstep with **zero edits**. Only two files hardcode the number: `contracts/index.test.ts` (`.toBe(8)`) and `apps/web/src/lib/runs.ts` (six `v: 8`, because it deliberately doesn't import contracts). This mirrors the 7→8 bump in Story 9.1 exactly. **Backward-safe:** every new field is optional and `JobTool.operations` still defaults `[]`, so a non-tool run builds a valid v9 spec. The one operational requirement: the **agent-harness image must be rebuilt** to a v9 harness (a v8 harness would fail `JobSpecSchema.parse()` on a v9 spec → `done:failed`); `deploy/test-stack.sh up` rebuilds it.

### The `JobTool.operations` reshape — three shapes, only ONE changes
There are three `operations` in the codebase; keeping them straight is the crux of this story:
- **`Tool.operations`** (the registered MCP tool — `schema.ts:158`, domain `ToolOperation` `index.ts:125`) is **already** `{ name; title?; description?; inputSchema? }[]`. The **real argument schemas live here** — which is exactly why 12.2 is a small lookup, not new plumbing.
- **`Agent.attachedTools[].operations`** (`schema.ts:66`, domain `:133`) and **`ProvisionTool.operations`** (`guardClient.ts:27`, `guard.ts:55`) are `string[]` **granted names** — the Guard enforces grants against these (`guard.ts:354`). They **stay `string[]`**; do not touch them.
- **`JobTool.operations`** (the **sandbox-visible** contract handle — `contracts/index.ts:33-37`) is the **only** shape 12.1 reshapes: `string[]` → `{ name; description?; inputSchema? }[]`, so the model gets structured argument shapes. 12.1 emits **name-only** (`{ name }`); 12.2 fills real `description`/`inputSchema` by looking each granted name up in the registered `tool.operations`.

The producer is a single site — `resolveRunTools` `orchestrator.ts:173`, `jobTools.push({ id, name, operations })`. Change only the `operations` there to `operations.map((name) => ({ name }))`, leaving the `string[]` at `:171` for the provision (`:185`). The consumers that must keep compiling: the harness stub `main.ts:221` (`operations[0]` → `operations[0].name`). Nothing in web consumes `JobTool` (its `tool.operations` usages are the **registered** tool in `ToolsEditor.svelte`/`AgentToolsTab.svelte`).

### Secret-free (AD-10) — unchanged posture
Every added field carries model-visible data only — a logical tool **name**, a human **description**, and an **argument JSON-Schema** — exactly like `taskInput`/`instructions`/`memories.summary`. Never an endpoint URL, key, or token: the Guard alone holds those (resolved at broker time in 12.3/existing 6.4). `tool_calls`/`tool_call_id` carry the model's own chosen call + the correlation id — also secret-free. Injected immutably at run start (AD-9); the sandbox has no side-channel to mutate the spec.

### Architecture (binding)
- **AD-1** — 12.1 adds no runtime surface; a run is still a `--network=none` sandbox whose only egress is the Guard socket. The loop that uses this contract (12.4) stays inside that boundary.
- **AD-7 — control-api / orchestrator sole writers.** `resolveRunTools` (orchestrator) is the only builder of `JobTool`; no new writer of run/agent/tool state here.
- **AD-9 — immutable JobSpec.** The reshaped `JobTool.operations` is baked into the spec at run start; the harness never re-resolves it.
- **AD-10 — no secret in the sandbox.** Reaffirmed above: names + descriptions + arg schemas only.

### Existing patterns to mirror (file:line)
- **Version bump ritual:** Story 9.1 (7→8) — `CONTRACT_VERSION` (`contracts/index.ts:21`), the `z.literal` symbol re-pin, `index.test.ts` `.toBe`, `web/src/lib/runs.ts` six `v:` literals. This story is the same sweep, 8→9.
- **Optional contract field + comment style:** `JobSpecSchema.memories`/`history`/`tools` defaults (`contracts/index.ts:73-79`); `JobMemorySchema` as the secret-free-list precedent (`:40-48`).
- **The reshape producer:** `resolveRunTools` (`orchestrator.ts:161-187`) — the granted-name filter (`:170-171`), the `jobTools.push` (`:173`) vs the `provisionTools.push` (`:185`) split.
- **The registered op shape (12.2's source):** `ToolOperation` (`domain/src/index.ts:125`, `schema.ts:158` `{name,title?,description?,inputSchema?}[]`).
- **The Guard model proxy (12.3's target; 12.1 only touches its body type):** `guard.ts:222-262` (`proxyModel`, forwards `{ model, messages }` to `${litellmBaseUrl}/v1/chat/completions`).
- **Spike reference:** `apps/agent-harness/src/toolLoop.ts` + the widened `contracts/index.ts`/`guard.ts` on branch `spike/agent-tool-loop`.

### Project Structure Notes
- **Edited — contracts:** `packages/contracts/src/index.ts` (new `GuardModelTool`/`GuardModelToolCall`/`GuardModelMessage` schemas; `GuardModelRequest`.tools/toolChoice + message widen; `GuardModelResponse`.toolCalls/finishReason; `JobTool.operations` reshape; `CONTRACT_VERSION` 8→9; v9 history comment) + `packages/contracts/src/index.test.ts`.
- **Edited — control-api:** `apps/control-api/src/runs/orchestrator.ts` (`resolveRunTools` jobTools placeholder object).
- **Edited — harness:** `apps/agent-harness/src/main.ts` (stub `operations[0].name` keep-green).
- **Edited — guard:** `apps/egress-guard/src/guard.ts` (proxyModel body type import of `GuardModelToolCall` — spike-proven; forwarding is 12.3).
- **Edited — web:** `apps/web/src/lib/runs.ts` (six `v: 9` mirror literals).
- **No change (this story):** forwarding `tools`→LiteLLM (12.3), real op-schema resolution in `resolveRunTools` (12.2), the AI SDK loop / deleting the stub (12.4), repair (12.5), observability + web step view (12.6), the capability signal (12.7). The Guard's grant-enforcement allow-list (`ProvisionTool.operations` string[]) is untouched.
- **Scope guard:** NO tool forwarding to LiteLLM, NO loop, NO real schema lookup, NO new transcript event, NO web tool-step UI. This story is: the tool-calling contract shape + the `JobTool.operations` reshape (name-only) + the version bump + the minimal ripples that keep `pnpm -r build` green.

### Testing standards
- Vitest, co-located `*.test.ts`. Contracts test asserts `CONTRACT_VERSION` + parses the widened schemas both WITH and WITHOUT the optional tool fields (backward-compat is a first-class assertion). Control-api uses in-memory fakes; assert the `JobTool` object shape + the `JobTool`-vs-`ProvisionTool` operations split. Harness `main.test.ts` proves the stub still records a `tool` event with `operations` as objects. `svelte-check` for web. Full verification: `pnpm -r build`, `pnpm lint`, `deploy/test-stack.sh` e2e proving the v9 harness rebuilds and the no-tools test-console happy path still completes; never `down -v` the dev stack; warm Vite before Playwright.

### References
- [Source: epics.md#Epic-12 (model-driven tool loop; SDK owns cognition / turanga owns transport+enforcement; two injection points; step ceiling + cost cap backstops) + #Story-12.1 (the three ACs) + #Architecture-and-scope-decisions]
- [Source: architecture spine #AD-1 (network=none sandbox), #AD-7 (control-api/orchestrator sole writers), #AD-9 (immutable JobSpec at run start), #AD-10 (no secret in the sandbox)]
- [Source: contracts/index.ts (GuardModelRequest/Response, JobTool, CONTRACT_VERSION) + Story 9.1's 7→8 bump as the exact ritual]
- [Source: orchestrator.ts:161-187 resolveRunTools (the jobTools vs provisionTools split) ; domain/schema.ts ToolOperation (12.2's real-schema source) ; agent-harness/main.ts:220-227 (the Phase-1b stub, deleted in 12.4)]
- [Source: branch spike/agent-tool-loop — proven reference implementation of the widened GuardModel* shapes; [[epic-12-tool-loop]]]
- [Source: [[turanga-e2e-clean-run]] + [[e2e-isolated-test-stack]] — reset via deploy/test-stack.sh; never `down -v` the dev stack; rebuild the harness image for the v9 bump]

## Dev Agent Record

### Agent Model Used

claude-opus-4-8 (Claude Opus 4.8)

### Debug Log References

- **Folded the spike, not re-derived.** Built on branch `spike/agent-tool-loop`, which already carried the additive `GuardModelTool`/`GuardModelToolCall`/`GuardModelMessage` schemas + the widened `GuardModelRequest`/`Response`. 12.1's net-new work was: the `CONTRACT_VERSION` 8→9 bump, the `JobTool.operations` reshape (`string[]` → `{name,description?,inputSchema?}[]`), and formalizing the spike's "(tool-loop spike)" comments to "(Story 12.1)".
- **AI SDK v7 `system` rule (from the spike):** `generateText` rejects `system`-role messages in the `messages` array — system content goes via the `system` option. Already handled in `toolLoop.ts:toPrompt` during the spike; no change needed here.
- **The three-`operations` trap held.** Only the sandbox-visible `JobTool.operations` reshaped. The two `string[]` shapes — `Agent.attachedTools[].operations` (grants) and `ProvisionTool.operations` (Guard allow-list) — were left untouched; `runs.test.ts` asserts both sides of the split (jobSpec ops are `[{name}]`, provTools ops stay `["get_weather"]`). The `attachedTools`/`provTools` test literals were deliberately NOT reshaped.
- **Two harness stubs needed the `op.name` keep-green edit:** `main.ts:221` (Phase-1b stub, deleted in 12.4) and the spike's `toolLoop.ts:buildTools` (12.4's artifact). Both now read the operation name off the object; `toolLoop.ts` additionally prefers the op's own `description`/`inputSchema` when present (12.2 populates them).
- **Test-data ripple:** JobTool `operations: ["x"]` → `[{name:"x"}]` in `contracts/index.test.ts`, `agent-harness/main.test.ts`, `agent-harness/toolLoop.test.ts`, and the one JobTool assertion in `control-api/runs.test.ts:284` (its neighboring `attachedTools`/`provTools` literals correctly stayed `string[]`).

### Completion Notes List

- **The contract spine, no loop.** Landed the tool-calling contract shape (GuardModelRequest.tools/toolChoice, the `tool` message role + tool_calls/tool_call_id, GuardModelResponse.toolCalls/finishReason), the `JobTool.operations` reshape to per-op argument schemas (name-only placeholder — Story 12.2 fills real description+inputSchema from the registered `Tool.operations`), and the `CONTRACT_VERSION` 8→9 bump — WITHOUT running the loop (12.4) or making the Guard forward tools its own concern (12.3).
- **Backward-safe (proven at unit + build level):** every added field is optional and `JobTool.operations` still defaults `[]`, so an existing non-tool run builds a valid v9 spec and the Phase-1b stub behaves exactly as before (now reading `operations[0].name`). No migration (contract-only). The full `pnpm -r build` compiles the v9 harness, so a rebuilt harness image will accept v9 specs.
- **Secret-free (AD-10) preserved + tested:** tool defs and JobTool ops carry names + descriptions + arg schemas only; unit tests assert extra endpoint/secret keys are stripped from both a `GuardModelRequest.tools` def and a `JobTool` op.
- **Working-tree note for the eventual commit:** the branch also carries Story 12.3 (guard `proxyModel` tool-forwarding) and 12.4 (`toolLoop.ts`/`toolLoop.test.ts`, the AI SDK dep in `agent-harness/package.json` + `pnpm-lock.yaml`) spike deltas. These are inert for 12.1 (no caller passes `tools` until 12.4) and are **not** part of 12.1's logical scope — a 12.1 commit should include only the File List below; the rest lands with 12.3/12.4.
- **Verification:** contracts 18 (+3 new), harness 14, control-api 255 (+1 skipped), guard 31 — all green; `pnpm -r build`, `pnpm lint`, `svelte-check` clean. **e2e deferred by user decision** (contract-only + backward-safe + no migration; fold into 12.3/12.4's e2e) — the one unchecked box, documented in Task 6.

### File List

**Edited — contracts**
- `packages/contracts/src/index.ts` — `CONTRACT_VERSION` 8→9; `GuardModelTool`/`GuardModelToolCall`/`GuardModelMessage` schemas + types (folded from spike, comments formalized); `GuardModelRequest.tools`/`toolChoice` + widened messages; `GuardModelResponse.toolCalls`/`finishReason`; `JobToolOperation` schema + `JobTool.operations` reshape; v9 version-history line
- `packages/contracts/src/index.test.ts` — v9 assertion; JobTool op reshape + name-required + secret-free; new GuardModelRequest tools/tool-role + backward-compat + secret-free; new GuardModelResponse toolCalls/finishReason

**Edited — control-api**
- `apps/control-api/src/runs/orchestrator.ts` — `resolveRunTools` jobTools emit `operations.map(name => ({ name }))` (sandbox-visible only; provisionTools stays `string[]`)
- `apps/control-api/src/runs/runs.test.ts` — the JobTool assertion reshaped to `[{ name }]` objects (attachedTools/provTools literals unchanged)

**Edited — harness**
- `apps/agent-harness/src/main.ts` — Phase-1b stub `operations[0]` → `operations[0]?.name` (keep-green; deleted in 12.4)
- `apps/agent-harness/src/main.test.ts` — JobTool `operations` literal reshaped to objects

**Edited — web**
- `apps/web/src/lib/runs.ts` — `RunMessage` mirror six `v: 8` → `v: 9` + comment

**Edited — spike artifacts (kept green for the working tree; formally owned by 12.4)**
- `apps/agent-harness/src/toolLoop.ts` — `buildTools` reads `op.name` + prefers the op's own `description`/`inputSchema`
- `apps/agent-harness/src/toolLoop.test.ts` — JobTool `operations` literal reshaped to objects

### Change Log

| Date | Version | Description |
|------|---------|-------------|
| 2026-08-05 | 0.1 | Story 12.1 drafted — the tool-calling contract spine of Epic 12. |
| 2026-08-05 | 0.2 | Story 12.1 implemented (folded the proven spike). GuardModelRequest.tools/toolChoice + tool-role messages + tool_calls, GuardModelResponse.toolCalls/finishReason, JobTool.operations reshape string[]→{name,description?,inputSchema?}[] (name-only; real schemas in 12.2), CONTRACT_VERSION 8→9. No tool forwarding (12.3), no loop (12.4). Verified: contracts 18 / harness 14 / control-api 255 / guard 31 unit + `pnpm -r build` + `pnpm lint` + `svelte-check` all green; e2e deferred by user decision (documented). Status → review. |
