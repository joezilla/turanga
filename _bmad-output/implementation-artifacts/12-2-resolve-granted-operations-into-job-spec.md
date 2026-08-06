---
baseline_commit: cfb4bed816c95fa1384236edf0dd125fc530043e
---
# Story 12.2: Resolve granted operations into the job spec

Status: review

<!-- SECOND story of Epic 12 (Model-driven tool loop). 12.1 reshaped the sandbox-visible
     JobTool.operations to {name, description?, inputSchema?} and had the orchestrator emit NAME-ONLY
     placeholders. 12.2 fills the real thing: resolveRunTools looks each granted operation up in the
     REGISTERED tool (whose `operations` are already ToolOperation = {name,title?,description?,
     inputSchema?} from the Story 6.2 list-tools handshake) and copies the description + argument
     schema onto the JobTool. That is the entire story — the data already exists; the orchestrator's
     local ToolLike type just throws it away today. No loop (12.4), no Guard change (12.3). Small,
     surgical: one type widen + one lookup + the fail-safe that keeps a bad schema from poisoning the
     spec. The payoff: when the loop lands (12.4) the model sees each op's real argument shape, so it
     calls tools with correct structured arguments instead of guessing. -->

## Story

As the builder,
I want each of my agent's granted tool operations described to the model with its real argument schema,
so that the model calls tools correctly — with the right arguments — instead of guessing against an empty placeholder.

## Acceptance Criteria

1. **Given** an agent with attached tools and per-operation grants, **when** the orchestrator assembles a run (`resolveRunTools`), **then** each **granted** operation on the sandbox-visible `JobTool.operations` carries the operation's **real `description` and `inputSchema`** resolved from the registered tool (the `ToolOperation` data populated by the Story 6.2 list-tools handshake) — replacing Story 12.1's name-only placeholder. An operation the registered tool describes with neither a description nor a schema still yields a valid name-only entry. [Source: epics.md#Story-12.2 AC1, #Architecture-and-scope-decisions]

2. **Given** a tool with many operations of which only some are granted, **when** the spec is built, **then** **only granted** operations are manifested (least-privilege *and* a bounded context/token footprint), the manifest carries **no endpoint or credential** (AD-10), and `inputSchema` is included **only when it is a JSON-Schema object** — a non-object schema is omitted so a malformed registration can never make the whole immutable `JobSpec` unparseable by the harness (the spec is not validated control-side; the harness parses it via `JobSpecSchema` on receipt). The Guard-only `ProvisionTool.operations` stays `string[]` granted names — unchanged. [Source: epics.md#Story-12.2 AC2; AD-9 immutable spec, AD-10 no secret; orchestrator.ts:458 the spec is `JSON.stringify`'d, not parsed control-side]

3. **Given** the run path, **when** a granted op's registration has a description + input schema, **then** a unit test proves both flow onto the sandbox `JobTool` op; a name-only registration yields a name-only op; the endpoint URL + credential never appear on the sandbox wire (AD-10); and `ProvisionTool.operations` remains `string[]` names (the 12.1 split is preserved). `pnpm -r build` / `pnpm lint` / unit suites stay green. [Source: epics.md#Story-12.2 AC3; runs.test.ts the existing tool-resolution tests]

## Tasks / Subtasks

- [x] **Task 1: Orchestrator — widen `ToolLike.operations` to carry the schema** (AC: #1)
  - [x] `apps/control-api/src/runs/orchestrator.ts` — widened `ToolLike.operations` from `{ name: string }[]` to `{ name: string; description?: string; inputSchema?: unknown }[]` (mirrors domain `ToolOperation`; `inputSchema` stays `unknown` — opaque JSON Schema). No new import; `toolsRepo.getTool` already returns the full `ToolRow.operations: ToolOperation[]`, so only the local type was hiding the data.

- [x] **Task 2: Orchestrator — `resolveRunTools` resolves the real description + schema** (AC: #1, #2)
  - [x] `apps/control-api/src/runs/orchestrator.ts` `resolveRunTools` — replaced the name-only map with a `byName = new Map(tool.operations.map(o => [o.name, o]))` lookup (the grant filter now uses `byName.has`), and each granted op emits `{ name, ...(description if truthy), ...(inputSchema only if a plain non-null non-array object as Record) }`. Comment updated to state 12.2 resolves the real description + schema and why the non-object fail-safe exists.
  - [x] Left the `operations` `string[]` of granted names feeding `provisionTools.push({ ..., operations })` untouched — the Guard allow-list stays name-based (the 12.1 split).

- [x] **Task 3: Tests — prove the schema flows, the name-only fallback, and the split** (AC: #3)
  - [x] `apps/control-api/src/runs/runs.test.ts` — widened the `toolOrch` `ToolRec.operations` fixture type to carry `description?`/`inputSchema?`.
  - [x] Added the Story 12.2 test: a granted op with a real `description` + object `inputSchema` flows through in full; a name-only registration yields `{ name }`; a granted op with a **non-object** `inputSchema` (a stray string) drops the schema but keeps the description (fail-safe); an **ungranted** op never appears (`not.toContain("ungranted_op")`); and `provision.tools[].operations` stays `string[]` granted names (the split). Written RED-first (failed against the name-only code), now green.

- [x] **Task 4: Verification** (AC: all)
  - [x] **control-api unit** — new + existing tool-resolution tests pass (incl. the 12.1 name-only split test). **256 passed / 1 skipped** (was 255; +1 new).
  - [x] `pnpm -r build` (TS-local change; rippled nowhere) · `pnpm lint` — both clean. Full regression `pnpm -r test`: domain 5 / contracts 18 / harness 14 / guard 31 / control-api 256 / web 22 — all green.
  - [x] **contracts** unchanged — `git status packages/contracts` empty, `CONTRACT_VERSION` still `9`. No version bump this story.
  - [ ] **e2e — DEFERRED (same rationale as 12.1):** control-plane spec-assembly only, no runtime path (the harness stub ignores the schema; the loop that consumes it is 12.4). Fold into 12.4's e2e where the loop actually reads the schema. Never `down -v` the dev stack. See [[turanga-e2e-clean-run]].
  - [x] Bookkeeping: boxes checked, Dev Agent Record / File List / Change Log filled, Status → review.

## Review Findings (code review 2026-08-06)

- [x] [Review][Patch] Guard `description` on bare truthiness while `inputSchema` is guarded — copy it only when `typeof === "string"` (defense-in-depth consistency with the inputSchema fail-safe, on the same untrusted stored source) [apps/control-api/src/runs/orchestrator.ts:188] — APPLIED
- [x] [Review][Patch] The new 12.2 test omits the AD-10 negative assertion — add `expect(jobSpecJson).not.toContain("mcp.example")` so the description/inputSchema-copy path is guarded against endpoint leakage across the whole serialized spec [apps/control-api/src/runs/runs.test.ts] — APPLIED
- [x] [Review][Defer] inputSchema fail-safe checks object-ness not JSON-Schema validity (non-object-typed schema → LiteLLM 400) [orchestrator.ts:185] — deferred to Story 12.4 (only bites when the loop drives it; mitigated by MCP-SDK validation at registration)

## Dev Notes

**The data already exists — 12.2 just stops discarding it.** The Story 6.2 list-tools handshake populated each registered tool's `operations` as `ToolOperation` (`{ name, title?, description?, inputSchema? }`, `tools/repo.ts:16`, domain `:113-118`). `resolveRunTools` already fetches the full `ToolRow` via `toolsRepo.getTool` — but the orchestrator's local `ToolLike.operations` type narrows it to `{ name }[]` (`orchestrator.ts:45`), and 12.1 emitted name-only. 12.2 widens that one type and copies `description` + `inputSchema` onto the granted ops. There is **no new source, no new query, no contract change** — the contract shape (`JobToolOperationSchema` with optional `description`/`inputSchema`) already exists from 12.1.

### Why the fail-safe matters (AC #2)
The assembled `JobSpec` is **not** validated control-side — `orchestrator.ts:458` does `JSON.stringify(jobSpec)` and hands it to the runtime; the **harness** parses it with `JobSpecSchema` on receipt (`agent-harness/src/main.ts:readJobSpec`). `JobToolOperationSchema.inputSchema` is `z.record(z.string(), z.unknown()).optional()` — a **record (object)**. So if a registered op's `inputSchema` were, say, a string or number (a malformed/odd MCP registration), copying it verbatim would make the ENTIRE spec fail `JobSpecSchema.parse()` → the run dies `done:failed` for an unrelated tool. Guard against it: include `inputSchema` only when it is a plain non-null, non-array object; otherwise omit it (the op still calls fine — the model just doesn't get an arg schema for it). Description is a plain string — include when truthy.

### Only granted operations (least privilege + bounded footprint)
Unchanged from 12.1: `granted = attachedTools.filter(t => t.operations.length > 0)` then `operations = g.operations.filter(op => offered.has(op))` — a tool with 90 registered ops but 12 granted manifests only those 12, now each with its schema. The description + schema add tokens; that is the intended cost of letting the model call correctly. No un-granted op is ever described to the model.

### The 12.1 split holds (three `operations`, still only the sandbox one carries schemas)
- **`JobTool.operations`** (sandbox-visible) — the one 12.2 enriches with `description`/`inputSchema`.
- **`ProvisionTool.operations`** (Guard allow-list, `:188`) — stays `string[]` granted names; the Guard enforces grants by name, not schema. **Do not touch.**
- **`Agent.attachedTools[].operations`** (grants) — `string[]`, untouched.

### Architecture (binding)
- **AD-9 — immutable JobSpec.** The resolved schema is baked in at run start; the harness never re-resolves. 12.2 only enriches what the orchestrator builds pre-spec.
- **AD-10 — no secret in the sandbox.** `description` + `inputSchema` are model-visible metadata (a name, a human description, an argument JSON-Schema), never an endpoint/credential — the same posture 12.1 established and tested.
- **AD-7 — orchestrator sole builder** of `JobTool`; no new writer.
- **AD-1** — no runtime surface added.

### Existing patterns / precedent (file:line)
- **The site:** `orchestrator.ts:161-192` `resolveRunTools`; the `jobTools.push` (`:176`) is the only line whose `operations` value changes; the `ToolLike.operations` type (`:45`) is the only type widened.
- **The data source:** domain `ToolOperation` (`packages/domain/src/index.ts:113-118`), `ToolRow.operations: ToolOperation[]` (`tools/repo.ts:16`), populated by `setOperations` (`:25`) at list-tools time.
- **The contract (already in place from 12.1):** `JobToolOperationSchema` (`packages/contracts/src/index.ts`) — `{ name, description?, inputSchema? }`, `inputSchema` a `z.record`.
- **The spec-send (no control-side validation):** `orchestrator.ts:458` `JSON.stringify(jobSpec)`; the harness `readJobSpec` is the validator.
- **The test:** `runs.test.ts` `toolOrch` (`:249`) + the 12.1 tool-resolution test (`~:269`) that already asserts the URL/credential exclusion and the `provTools` string-names split — extend it, don't duplicate.
- **Story 12.1** (`12-1-tool-calling-contract-and-version-bump.md`) — the reshape + the split rationale; [[epic-12-tool-loop]].

### Project Structure Notes
- **Edited:** `apps/control-api/src/runs/orchestrator.ts` (widen `ToolLike.operations`; `resolveRunTools` lookup + fail-safe) and `apps/control-api/src/runs/runs.test.ts` (fixture type widen + the flow-through / name-only / non-object-schema cases).
- **No change:** `packages/contracts` (12.1 already shaped it — **no `CONTRACT_VERSION` bump**), the harness (the stub ignores the schema; the loop is 12.4), the Guard (12.3), web.
- **Scope guard:** NO loop, NO Guard tool-forwarding, NO contract change, NO new query/table. This story is one type widen + one lookup + the fail-safe + tests.

### Testing standards
- Vitest, co-located. Control-api uses in-memory fakes (`memoryRunsRepo`, the `toolOrch` fake `toolsRepo`). Assert on the parsed `runtime.established[0].jobSpecJson`. Keep the AD-10 negative assertions. No new framework. Full verification: `pnpm -r build`, `pnpm lint`, unit suites; e2e optional (control-plane spec-assembly only).

### References
- [Source: epics.md#Epic-12 + #Story-12.2 (resolve real op schemas into JobSpec.tools; only granted ops; bounded footprint) + #Architecture-and-scope-decisions]
- [Source: architecture spine #AD-1, #AD-7, #AD-9, #AD-10]
- [Source: orchestrator.ts:44 (ToolLike), :161-192 (resolveRunTools), :458 (JSON.stringify, no control-side validation) ; domain:113-118 + tools/repo.ts:16 (ToolOperation source) ; contracts JobToolOperationSchema (12.1)]
- [Source: 12-1-tool-calling-contract-and-version-bump.md (the reshape + the three-operations split) ; [[epic-12-tool-loop]]]

## Dev Agent Record

### Agent Model Used

claude-opus-4-8 (Claude Opus 4.8)

### Debug Log References

- **The data was already there.** `resolveRunTools` already fetched the full `ToolRow` (whose `operations` are `ToolOperation[]` with `description`/`inputSchema`); the only thing discarding it was the orchestrator's local `ToolLike.operations: { name: string }[]` narrowing + 12.1's name-only map. Widening the one type + a `byName` lookup was the whole change — no new query, no contract change.
- **`offered` → `byName`.** Replaced the `offered = new Set(...names)` membership set with a `byName = new Map(name → op)` so the same filter (`byName.has(op)`) also serves the description/schema lookup. Functionally identical grant-narrowing; one structure instead of two.
- **The fail-safe is load-bearing, not defensive dressing.** The spec is `JSON.stringify`'d and sent (`orchestrator.ts:458`), then parsed by the harness via `JobSpecSchema` (`main.ts:readJobSpec`). `JobToolOperationSchema.inputSchema` is a `z.record` (object). A registration with a non-object `inputSchema` (some odd MCP server) copied verbatim would make the ENTIRE spec fail `parse()` → an unrelated run dies `done:failed`. The `typeof === "object" && !== null && !Array.isArray` guard drops it (keeping the op + its description). Unit-tested with a stray-string schema.
- **RED-first confirmed:** the new test failed against the name-only code (`expected [{name:"get_weather"}] … got the full object`), then passed after the lookup landed.

### Completion Notes List

- **Filled the placeholder.** `resolveRunTools` now copies each granted op's real `description` + `inputSchema` from the registered tool onto the sandbox-visible `JobTool` (replacing 12.1's name-only). The model will see each tool's true argument shape once the loop lands (12.4) — the spike's `toolLoop.ts` already prefers `op.description`/`op.inputSchema` when present.
- **Fail-safe for un-validated specs:** `inputSchema` is included only when it is a plain non-null, non-array object; a malformed schema is dropped (description kept), so it can never make the immutable JobSpec unparseable harness-side. Unit-tested.
- **Scope held:** only granted ops manifested (least-privilege + bounded footprint; an ungranted op never appears — tested); `ProvisionTool.operations` stays `string[]` granted names (the Guard allow-list — the 12.1 split preserved); AD-10 intact (names + descriptions + schemas only, no endpoint/credential). **No contract change, no `CONTRACT_VERSION` bump, no loop (12.4), no Guard change (12.3)** — footprint is exactly two files.
- **Verification:** control-api 256 (+1 new) / 1 skipped; full `pnpm -r test` green (domain 5, contracts 18, harness 14, guard 31, web 22); `pnpm -r build` + `pnpm lint` clean; contracts confirmed untouched. e2e deferred (same rationale as 12.1) — the one unchecked box, documented in Task 4.

### File List

**Edited — control-api**
- `apps/control-api/src/runs/orchestrator.ts` — widened `ToolLike.operations` to `{ name; description?; inputSchema? }[]`; `resolveRunTools` resolves the real description + inputSchema onto the JobTool (byName lookup + non-object-schema fail-safe); `provisionTools.operations` unchanged
- `apps/control-api/src/runs/runs.test.ts` — widened the `ToolRec` fixture type; added the Story 12.2 flow-through / name-only / non-object-schema / ungranted / split test

### Change Log

| Date | Version | Description |
|------|---------|-------------|
| 2026-08-06 | 0.1 | Story 12.2 drafted. |
| 2026-08-06 | 0.2 | Story 12.2 implemented. resolveRunTools resolves each granted op's real description + inputSchema from the registered tool onto the sandbox JobTool (replacing 12.1's name-only); inputSchema included only when a JSON-Schema object (fail-safe — the spec is parsed harness-side, not control-side); only granted ops manifested; ProvisionTool stays string[] (12.1 split preserved). No contract change, no loop (12.4), no Guard change (12.3). Footprint: orchestrator.ts + runs.test.ts. Verified: control-api 256 + full `pnpm -r test` + build + lint green; contracts untouched. e2e deferred (documented). Status → review. |
