---
baseline_commit: d845d8719eb0d9ad678d674e007facaab22a64ff
---
# Story 6.3: Attach tools to an agent with per-operation grants

Status: review

<!-- Third story of Epic 6. Builds on 6.1 (the Tool entity + the versioned JobTool contract) and 6.2
     (connect a remote MCP tool → discovered operations). This story attaches a connected tool to an
     agent and grants specific operations, mirroring the Skills-with-per-scope-grants model EXACTLY
     (default-deny). It persists the grants server-side (AD-7) and makes them the authoritative set the
     Guard will enforce, and populates the agent-visible JobSpec.tools with the granted operation IDs
     (never the endpoint/credential — AD-10). NO runtime invocation yet (the Guard broker is 6.4);
     NO Guard credential provisioning yet (also 6.4). -->

## Story

As the builder,
I want to attach a connected tool to an agent and grant only specific operations,
so that an agent can use a tool with least privilege — enforced, not on trust.

## Acceptance Criteria

1. **Given** the agent-definition surface, **when** the **Tools** section (next to Skills) is used, **then** I can attach a connected tool and **grant per operation**; the default is most-restrictive (**deny** — an attached tool grants nothing until an operation is checked), mirroring Skills/permission scopes. [Source: epics.md#Story-6.3, FR-3; the Skills-grant template]
2. **Given** an agent with granted tool operations, **when** its definition is saved, **then** the grants persist server-side (**AD-7** — control-api is the sole writer) and are the authoritative set the Guard will enforce at runtime; the agent-visible job spec carries the **granted operation IDs**, never the endpoint/credential (**AD-10**). [Source: epics.md#Story-6.3, AD-7, AD-10, contracts JobTool]

## Tasks / Subtasks

- [x] **Task 1: Persist attached-tool grants on the agent (domain + schema + repo, AD-7)** (AC: #1, #2)
  - [x] `packages/domain/src/index.ts` — add `attachedTools: AttachedTool[]` to the `Agent` interface (next to `skills: AttachedSkill[]`, line ~63). The `AttachedTool { toolId: Ulid; operations: string[] }` type **already exists** (line 104, added in 6.1) — "the AttachedSkill analogue; default-deny (an empty `operations` grants nothing)." Do NOT redefine it.
  - [x] `apps/control-api/src/db/schema.ts` — add an `attachedTools` jsonb column to the `agents` table (mirror `skills` at line 64): `attachedTools: jsonb("attached_tools").$type<{ toolId: string; operations: string[] }[]>().notNull().default([])`. Generate the migration (`pnpm --filter @turanga/control-api drizzle-kit generate` → `drizzle/0013_*.sql` + `meta/_journal.json` + `0013_snapshot.json`; applied on boot). **NO new table** — a JSON column on `agents`, exactly like `skills` (not a join table).
  - [x] `apps/control-api/src/agents/repo.ts` — extend `AgentRow` with `attachedTools: AttachedTool[]` (line ~15, next to `skills`) and `AgentPatch` with `attachedTools?: AttachedTool[]` (line ~27). Thread through: `toRow` (pass `attachedTools: (r.attachedTools ?? []) as AttachedTool[]`), memory `applyPatch` (`...(patch.attachedTools !== undefined ? { attachedTools: patch.attachedTools } : {})`), drizzle `create` (`attachedTools: row.attachedTools`), drizzle `update` (`if (patch.attachedTools !== undefined) set.attachedTools = patch.attachedTools;`). Import `AttachedTool` from `@turanga/domain` (the file already re-exports domain agent types). **No secret redaction** — AgentRow carries no secrets (grants are just IDs).
  - [x] Where `AgentRow` literals are constructed in tests/fixtures/`create` defaults, add `attachedTools: []` so older construction stays valid (mirror how `skills: []` is defaulted).

- [x] **Task 2: Validate + save grants against what the tool offers (control-api route)** (AC: #1, #2)
  - [x] `apps/control-api/src/agents/routes.ts` — inject the tools repo: `agentRoutes(repo, connectionsRepo, toolsRepo)` (line 106). Add a `parseTools` validator — the `parseSkills` analogue (lines 81-104) but validated against **per-tool discovered operations**, not a static Set, so it must load each referenced tool (async, or resolve the tools first and pass a lookup map):
    - Input must be a list; each item an object with `toolId: string` + `operations: string[]`.
    - `toolId` must resolve to an existing tool (`await toolsRepo.getTool(toolId)`) → else `400 { error: "Unknown tool." }`.
    - Every entry in `operations` must be one of that tool's discovered `operations[].name` → else `400` with a stated cause (e.g. `Operation "x" isn't offered by tool "<name>".`). This is the **one genuinely new bit** vs. Skills (skills validated against a static builtin set; tools validate against discovered operations).
    - De-dupe `toolId` (a tool attached more than once → `400`); de-dupe operation names within a tool. **Default-deny is preserved** — an empty `operations` array is valid and grants nothing (do NOT reject it; that's how a tool is attached-but-ungranted).
    - Return the cleaned `AttachedTool[]`.
  - [x] In `PATCH /agents/:id` (lines 128-194), read `body.attachedTools` (declare it in the body type ~line 134) and apply exactly like `body.skills` (lines 178-182): `if (body.attachedTools !== undefined) { const parsed = await parseTools(body.attachedTools); if (!parsed.ok) return c.json({ error: parsed.error }, 400); patch.attachedTools = parsed.value; }`. Keep returning the updated row via `c.json({ agent })` (no `view()` — AgentRow has no secrets). If `parseTools` is async, make the handler await it (the handler is already async).
  - [x] `apps/control-api/src/app.ts` — pass `toolsRepo` into `agentRoutes(agentsRepo, connectionsRepo, toolsRepo)` (the `toolsRepo` is already constructed at line 82 for `toolRoutes`; reuse the same instance).
  - [x] **No `CONTRACT_VERSION` bump** — 6.3 changes nothing on the sandbox wire. `JobSpec.tools` + `JobTool` already exist (v5, Story 6.1); this story only fills them.

- [x] **Task 3: Populate the agent-visible JobSpec.tools from the grants (orchestrator, AD-10)** (AC: #2)
  - [x] `apps/control-api/src/runs/orchestrator.ts` — the `tools: []` on the JobSpec literal (line 147, commented "agent tool grants land in 6.3") is the hook. Resolve the agent's `attachedTools` into `JobTool[]`:
    - Inject `toolsRepo` into the orchestrator deps (`runOrchestrator({ ..., toolsRepo })`) — mirror how `dataConnectionsRepo` is threaded (it's already a dep).
    - Add a `resolveRunTools(agent)` step (the `resolveRunConnections` analogue): filter `agent.attachedTools` to entries with **≥1 granted operation** (`t.operations.length > 0` — default-deny: an attached-but-ungranted tool is NOT put on the spec), load each tool by `toolId` (`await toolsRepo.getTool`), and map to `JobTool { id: tool.id, name: tool.name, operations: t.operations }`. Skip a grant whose `toolId` no longer resolves (a deleted tool — don't crash the run). Set `jobSpec.tools = jobTools`.
    - **Scope guard (AD-10):** the JobSpec carries only `{ id, name, operations }` — NEVER `url` or `encCredential`. The `JobToolSchema` already strips extras (see contracts test line 35). The Guard-side credential provisioning (decrypt `encCredential` → hand to the Guard on `RunProvision`) is **Story 6.4**, NOT this story — do not add it here. 6.3 makes the grants *visible + authoritative*; 6.4 makes them *callable*.
  - [x] `apps/control-api/src/app.ts` + `apps/control-api/src/server.ts` — pass `toolsRepo` into the orchestrator construction in both (the fake-runtime default orchestrator in app.ts, line ~91, and the real one in server.ts, line ~79). `app.ts` already has `toolsRepo`; `server.ts` has `toolsRepo` at line 64.

- [x] **Task 4: The Tools section in the agent editor (web)** (AC: #1, #2)
  - [x] `apps/web/src/lib/agents.ts` — add `attachedTools: AttachedTool[]` to the client `Agent` type (next to `skills`, line ~37) and `attachedTools?: AttachedTool[]` to `AgentPatch` (line ~47). Add an `AttachedTool { toolId: string; operations: string[] }` type (mirror the domain). `updateAgent` already PATCHes + trusts the returned agent (no change).
  - [x] `apps/web/src/lib/components/ToolsEditor.svelte` (NEW) — the `SkillsEditor.svelte` analogue, controlled via `{ value: AttachedTool[]; tools: Tool[]; onchange }` props (the parent passes the list of connected tools from `listTools()` so the editor knows each tool's name + available operations):
    - `attach(toolId)` pushes `{ toolId, operations: [] }` — **default-deny on attach** (mirrors SkillsEditor's `{ skill, scope: "none", send: false }`).
    - `remove(toolId)`, `toggleOperation(toolId, opName, on)` — each rebuilds the array immutably and calls `onchange`.
    - Render: one chip per attached tool showing the tool name; **a checkbox per discovered operation** (from the matching `Tool.operations`) instead of Skills' scope `<select>` + send checkbox — because a tool grant is an operation allow-list, not a scope enum. Show the operation name (mono) + its `title`/`description` if present. An "Add a tool" popover picker filtered to connected tools not already attached (the `attachableSkills` analogue). If a tool has a stale/removed operation still granted, show it flagged (defensive) — but the server is authoritative.
    - Empty state: "No tools attached." (fact + the Add action) — UX-DR16.
  - [x] `apps/web/src/routes/(app)/agents/[id]/+page.svelte` — add `attachedTools = $state<AttachedTool[]>([])` (next to `skills`, line ~43); hydrate on load (`attachedTools = a.value.attachedTools.map((t) => ({ ...t, operations: [...t.operations] }))`, next to line ~225); load the connected tools list (`listTools()`) for the editor's `tools` prop (a new fetch in the load path — reuse `$lib/tools.ts` `listTools`); render `<Section label="Tools"><ToolsEditor value={attachedTools} tools={connectedTools} onchange={onToolsChange} /></Section>` after the Skills section (line ~395); add `onToolsChange(next)` → set state + `persist({ attachedTools: next })` immediately (discrete change, like `onSkillsChange` at 263-266, NOT debounced). `persist` already coalesces via `saveSeq` + trusts the server row.
  - [x] Voice/UX (UX-DR16, NFR-6, UX-DR15): sentence case, verb-first ("Add a tool", "Remove"), operation IDs mono, keyboard-reachable checkboxes with a visible focus ring, persistent labels. No colour-only state.

- [x] **Task 5: Tests + verification** (AC: all)
  - [x] **control-api unit** (`agents/agents.test.ts` — extend, and/or `tools`): PATCH `/agents/:id` with `attachedTools`:
    - grants persist (round-trip: PATCH then GET returns the grants);
    - **validation**: unknown `toolId` → 400; an operation not offered by the tool → 400 (seed a tool via a `memoryToolsRepo` with known `operations`); a tool attached twice → 400; an **empty `operations` array is accepted** (default-deny — attached but ungranted);
    - the `appWithSession`/test harness must now supply a `toolsRepo` to `createApp` (thread it like `agentsRepo`), seeded with a tool so operation validation has something to check.
  - [x] **control-api unit** (`runs/runs.test.ts` or orchestrator): a run for an agent with `attachedTools` → the built `JobSpec.tools` contains the expected `JobTool { id, name, operations }` for granted tools, **omits** attached-but-ungranted tools (empty operations), and the spec contains **no `url`/`encCredential`** (assert AD-10). Requires seeding a `toolsRepo` in the orchestrator test wiring.
  - [x] **Playwright e2e** (append to the tools/agents e2e, isolated stack incl. `mcp-stub`, serial): connect the stub tool (reuse 6.2's flow) → open an agent → the **Tools** section lists it → attach it → grant an operation (check `echo`) → save → reload → the grant persists. Distinct `x-forwarded-for` per `signIn`. Clean up (unattach / delete) so pristine-DB assumptions hold on reruns.
  - [x] `svelte-check` 0 · `pnpm -r build` (8 workspaces) · `pnpm lint` · all unit suites · e2e green · teardown. **Run e2e via `deploy/test-stack.sh` (project `turanga-e2e`) — NEVER `docker compose down -v` on the dev stack** (it wipes the dev data: `Clyde`, `Untitled agent`, `wopr`). `pnpm -r build` before any Docker build. Restore the dev stack after; verify data intact.

## Dev Notes

**Builds on 6.1 (Tool entity + JobTool contract) and 6.2 (connect a remote MCP tool → discovered `operations`). This story attaches a connected tool to an agent with per-operation grants, persists them (AD-7), and makes them authoritative + job-spec-visible (AD-10). It does NOT invoke tools at runtime and does NOT provision the credential to the Guard — both are Story 6.4.**

### The model: mirror Skills-with-per-scope-grants EXACTLY (the sanctioned template)
The epic is explicit: "Permission model mirrors Skills (FR-3). Attach a tool to an agent, then grant per operation; the Guard enforces the grant at runtime, exactly like skill scopes." The Skills pattern is fully built — copy its shape at every layer. **The one divergence:** a skill grant is a scope enum (`none|read|read-write`) + a `send` bool; a **tool grant is an operation allow-list** (`operations: string[]`, empty = deny). The `AttachedTool { toolId, operations }` domain type (already stubbed in 6.1) is the sanctioned analogue.

| Layer | Skills (the template) | Tools (this story) |
|---|---|---|
| Domain | `AttachedSkill { skill, scope, send }`; `Agent.skills` | `AttachedTool { toolId, operations[] }` (exists); **add** `Agent.attachedTools` |
| Schema | `agents.skills` jsonb (schema.ts:64) | **add** `agents.attached_tools` jsonb (migration 0013) |
| Repo | `AgentRow.skills` / `AgentPatch.skills`; toRow/applyPatch/create/update | same fields for `attachedTools` |
| Route | `parseSkills` (static Set); PATCH reads `body.skills` | `parseTools` (**validate ops against the tool's discovered `operations`**); PATCH reads `body.attachedTools` |
| Web lib | `$lib/skills.ts` metadata + `attachableSkills` | `$lib/tools.ts` (exists) + an `attachableTools`/operation helper |
| Web UI | `SkillsEditor.svelte` (scope select + send checkbox) | `ToolsEditor.svelte` (**operation checkboxes**) |
| Editor page | `skills` state + `onSkillsChange` → `persist({skills})` | `attachedTools` state + `onToolsChange` → `persist({attachedTools})` |
| Orchestrator | `resolveRunConnections`: `scoped = skills.filter(scope!=="none")` → `jobSkills` (spec) + `grants` (Guard) | `resolveRunTools`: `attachedTools.filter(ops.length>0)` → `JobSpec.tools` (spec). **Guard provisioning is 6.4.** |

### Architecture (binding)
- **AD-7:** control-api is the sole writer of Agent state (grants included). The route validates + persists; the web trusts the returned row.
- **AD-10:** the JobSpec the sandbox sees carries only `{ id, name, operations }` per tool — **never** the endpoint URL or credential. `JobToolSchema` already enforces this (extras stripped; contracts test line 35). The credential stays `encCredential` on the tools table until 6.4 decrypts it Guard-side.
- **FR-3 / default-deny:** an attached tool grants **nothing** until an operation is explicitly granted. An empty `operations` array is valid (attached, ungranted) — do not reject it, and do not put it on the JobSpec.
- **Fail-closed validation:** reject a grant for an operation the tool doesn't offer (guards against a stale UI or a tampered request); reject an unknown `toolId`.

### Existing patterns to mirror (exact file:line, from the codebase scan)
- **Domain grant type:** `AttachedSkill` (`packages/domain/src/index.ts:51-55`); `AttachedTool` already at `:104-107`. Add `Agent.attachedTools` at `:63`.
- **Schema JSON grant column:** `agents.skills` jsonb (`apps/control-api/src/db/schema.ts:64`) → add `attached_tools` alongside.
- **Repo threading:** `AgentRow.skills` (`repo.ts:15`), `AgentPatch.skills` (`:27`), `toRow` (`:47`), memory `applyPatch` (`:61`), drizzle `create` (`:87`), drizzle `update` (`:98`).
- **Route validation + PATCH:** `parseSkills` (`routes.ts:81-104`) + the PATCH apply block (`:178-182`); `agentRoutes(repo, connectionsRepo)` (`:106`) → add `toolsRepo`. **New:** validate operation names against `toolsRepo.getTool(toolId).operations` (async lookup — parseSkills was sync against a static Set).
- **Web client + metadata:** `$lib/agents.ts` (`Agent.skills` :37, `AgentPatch.skills` :47, `updateAgent` :98); `$lib/skills.ts` (`attachableSkills` :38); `$lib/tools.ts` already has `listTools()` + the `Tool`/`ToolOperation` types (from 6.1/6.2).
- **Web UI component:** `apps/web/src/lib/components/SkillsEditor.svelte` (attach default-deny :34-37; immutable rebuild + onchange; popover picker :83-116) → `ToolsEditor.svelte`.
- **Editor host:** `apps/web/src/routes/(app)/agents/[id]/+page.svelte` (`skills` state :43, hydrate :225, `<Section label="Skills">` :394-395, `onSkillsChange` :263-266 → immediate `persist`, `persist` saveSeq :238-249).
- **Orchestrator split:** `resolveRunConnections` (`orchestrator.ts:91-117`: `scoped = agent.skills.filter(s=>s.scope!=="none")` :92, `jobSkills` :93, `grants` :94); JobSpec literal `tools: []` (`:147`). Inject `toolsRepo` (mirror `dataConnectionsRepo`).

### The contract is already in place (no bump)
`CONTRACT_VERSION = 5` (Story 6.1) already defines `JobToolSchema { id, name, operations }` (contracts:24-29) and `JobSpec.tools: JobTool[]` (contracts:44). This story only *populates* them. Confirm no `v: 4→5` ripple is needed (6.1 did that). The `authorizes(grants, op)` predicate (contracts:175) is the Skills enforcement analogue — tool-call enforcement (does the granted set authorize this operation?) is **6.4's** Guard concern, not this story.

### Project Structure Notes
- New: `apps/web/src/lib/components/ToolsEditor.svelte`, `apps/control-api/drizzle/0013_*.sql`. Edited: `packages/domain/src/index.ts`, `apps/control-api/src/db/schema.ts`, `apps/control-api/src/agents/{repo,routes}.ts`, `apps/control-api/src/app.ts`, `apps/control-api/src/server.ts`, `apps/control-api/src/runs/orchestrator.ts`, `apps/web/src/lib/agents.ts`, `apps/web/src/routes/(app)/agents/[id]/+page.svelte`, the agents/orchestrator unit tests + the tools/agents e2e.
- **No new dependency, no new workspace, no contract bump.** Scope guard: NO runtime tool invocation, NO Guard credential provisioning, NO container tools. Those are 6.4 / Epic 7.
- The agent editor page grows a Tools section; it must load the connected-tools list (`listTools()`) so the editor can render each tool's operations. If no tools are connected, show the empty state with a pointer to Settings → Tools.

### Testing standards
- Vitest for the route (grants persist + round-trip; validation: unknown tool 400, unoffered operation 400, dup 400, empty-operations accepted) — seed a `memoryToolsRepo` with a known tool so operation validation has a target; the agents test harness must thread `toolsRepo` into `createApp`. Vitest for the orchestrator (JobSpec.tools populated from grants; ungranted tools omitted; no url/credential on the spec — AD-10). Playwright serial e2e via the **isolated `deploy/test-stack.sh`** (incl. `mcp-stub`): connect the stub tool → attach to an agent → grant an operation → save → reload → persists. Distinct `x-forwarded-for` per `signIn`; `pnpm -r build` before any Docker build; **never `down -v` the dev stack.**

### References
- [Source: _bmad-output/planning-artifacts/epics.md#Epic-6, #Story-6.3 — attach + per-operation grants, "mirrors Skills (FR-3)", default-deny, AD-7/AD-10]
- [Source: _bmad-output/implementation-artifacts/6-2-connect-remote-mcp-tool.md — the connected tool + discovered `operations` this attaches; the tools repo/routes/`$lib/tools.ts`]
- [Source: _bmad-output/implementation-artifacts/6-1-tool-model-and-management.md — the Tool/AttachedTool domain types + the JobTool contract this fills]
- [Source: the Skills-grant template — packages/domain AttachedSkill; schema agents.skills; agents/repo.ts; agents/routes.ts parseSkills; SkillsEditor.svelte; orchestrator resolveRunConnections]
- [Source: architecture spine #AD-7 (sole writer), #AD-10 (no secret/endpoint on the sandbox wire); FR-3 (permission scopes, default-deny)]
- [Source: project-context.md — UI tokens/NFR-6, voice UX-DR16, a11y UX-DR15; build/test expectations]
- [Source: deploy/test-stack.sh + the 2026-08-03 infra rule — isolate e2e; never `down -v` the dev stack]

## Dev Agent Record

### Agent Model Used
claude-opus-4-8[1m] (Claude Code)

### Debug Log References
- e2e: the same two known-flaky login-throttle tests (`agents.spec.ts:23`, `health.spec.ts:45`) tripped on `signIn` ("stayed on /login?") in the full parallel run, and the cold-sandbox run-streaming test (`agents.spec.ts:214`) timed out once on a pristine DB — all three passed on isolated re-run, confirming environment flakiness, not a regression. My Story 6.3 e2e (`providers.spec.ts:114`) passed every run.
- Verified migration `0013` applied cleanly to the restored dev DB: the `attached_tools` column exists and existing agents (`Clyde`, `Untitled agent`) defaulted to `[]` — no data loss.

### Completion Notes List
- **Persist grants (Task 1):** `Agent.attachedTools: AttachedTool[]` added to the domain (the `AttachedTool { toolId, operations }` type already existed from 6.1). New `attached_tools` jsonb column on `agents` (migration `0013_thankful_marvel_boy.sql`, `NOT NULL DEFAULT '[]'`) — a JSON column, not a join table, mirroring `skills`. Threaded through `AgentRow`/`AgentPatch`/`toRow`/`applyPatch`/drizzle `create`+`update`, and the POST-create default literal.
- **Validate + save (Task 2):** `agentRoutes(repo, connectionsRepo, toolsRepo)`; a new async `parseTools` validator — the `parseSkills` analogue but validated against each tool's **discovered `operations`** (the one genuinely new bit vs. Skills). Rejects unknown `toolId`, an operation the tool doesn't offer, a tool attached twice, and bad shapes (400); **accepts an empty `operations`** (default-deny: attached-but-ungranted); de-dupes operation names. PATCH reads `body.attachedTools`, applies exactly like `body.skills`, returns the row (no `view()` — no secrets on an agent). `app.ts` reuses the same `toolsRepo` instance already built for `toolRoutes`.
- **Populate JobSpec.tools (Task 3):** the orchestrator's `tools: []` hook now calls a new `resolveRunTools(agent)` — filters `attachedTools` to entries with ≥1 granted operation (default-deny omits ungranted), resolves each tool's name via an injected `toolsRepo`, and maps to `JobTool { id, name, operations }`. Re-narrows to operations the tool still offers; **skips a deleted tool** rather than crashing the run. AD-10 held: the JobSpec carries only `{ id, name, operations }` — never `url`/`encCredential` (asserted in tests). `toolsRepo` wired into the orchestrator in both `app.ts` (fake default) and `server.ts` (real). Guard-side credential provisioning stays Story 6.4.
- **Web (Task 4):** `AttachedTool` type + `Agent.attachedTools`/`AgentPatch.attachedTools` on the client. New `ToolsEditor.svelte` (the `SkillsEditor` analogue) — a chip per attached tool with a **checkbox per discovered operation** (instead of Skills' scope-select), default-deny on attach, a searchable picker of connected-but-unattached tools, empty/edge states (no tools connected, no operations, stale tool). The agent editor loads the connected-tools list (`listTools()`), hydrates `attachedTools`, renders a `<Section label="Tools">` next to Skills, and `onToolsChange` persists immediately (discrete change) via the existing server-authoritative `persist`.
- **Tests (Tasks 5):** control-api `agents.test.ts` +5 (persist/round-trip, default-empty, empty-operations accepted, op de-dupe, the 400 matrix + no-persist-on-failure) with a seeded `memoryToolsRepo`; `runs.test.ts` +2 (JobSpec.tools populated for granted tools, ungranted omitted, no url/credential leak — AD-10; deleted-tool grant skipped). Playwright: a new `providers.spec.ts` test — connect the stub tool → create an agent → attach it → grant `echo` → **reload → the grant persisted** (echo checked, get_time not) → clean up.
- **Verification:** `pnpm -r build` (8 workspaces) · svelte-check 0/0 · `eslint .` clean · units all green (control-api 140 +1 skipped: agents 42→47, runs 23→25; domain/contracts/web/harness/guard green) · e2e providers/tools spec **7/7** on the isolated `test-stack.sh` stack (incl. `mcp-stub`; never `down -v` the dev stack). Dev stack restored, data intact, migration 0013 clean.
- **Scope held:** no `CONTRACT_VERSION` bump (v5 already carried `JobTool`), no runtime invocation, no Guard credential provisioning, no container tools — all 6.4 / Epic 7.

### File List
- `packages/domain/src/index.ts` (Agent.attachedTools) · `packages/domain/src/index.test.ts` (fixture)
- `apps/control-api/src/db/schema.ts` (agents.attached_tools)
- `apps/control-api/drizzle/0013_thankful_marvel_boy.sql` (NEW) + `meta/_journal.json` + `meta/0013_snapshot.json`
- `apps/control-api/src/agents/repo.ts` (AgentRow/AgentPatch/toRow/applyPatch/create/update)
- `apps/control-api/src/agents/routes.ts` (parseTools + PATCH branch + agentRoutes signature)
- `apps/control-api/src/app.ts` (toolsRepo → agentRoutes + orchestrator) · `apps/control-api/src/server.ts` (toolsRepo → orchestrator)
- `apps/control-api/src/runs/orchestrator.ts` (ToolsReader dep + resolveRunTools + JobSpec.tools)
- `apps/control-api/src/agents/agents.test.ts` (Story 6.3 describe + connectedTools harness)
- `apps/control-api/src/runs/runs.test.ts` (Story 6.3 orchestrator tests)
- `apps/web/src/lib/agents.ts` (AttachedTool + attachedTools on Agent/AgentPatch)
- `apps/web/src/lib/components/ToolsEditor.svelte` (NEW)
- `apps/web/src/routes/(app)/agents/[id]/+page.svelte` (Tools section: state, load, onToolsChange)
- `apps/web/tests/providers.spec.ts` (Story 6.3 attach+grant e2e)

### Change Log
- 2026-08-03 — Story 6.3 implemented: attach a connected tool to an agent with per-operation grants (default-deny), mirroring the Skills model. Grants persist server-side (AD-7, new `attached_tools` column, migration 0013), are validated against each tool's discovered operations, and populate the sandbox-visible `JobSpec.tools` as logical `{ id, name, operations }` handles — never the endpoint/credential (AD-10). New `ToolsEditor` web component + a Tools section in the agent editor. Status → review.
