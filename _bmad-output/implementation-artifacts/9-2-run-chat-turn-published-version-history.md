---
baseline_commit: 4c12745b936e5dc34249912d326d61dda8a20740
---
# Story 9.2: Run a chat turn against the published version, with history

Status: review

<!-- SECOND story of Epic 9 (Chat). 9.1 laid the spine (Conversation model, the run↔conversation link,
     JobSpec.history shape, the publish-first refusal). 9.2 makes chat ACTUALLY RUN: sending a message
     to a conversation spawns a fresh run built FROM THE PUBLISHED SNAPSHOT (agent_versions for the
     conversation's pinned version — NOT the draft), with the prior turns injected into JobSpec.history;
     the harness folds that history into the model context ahead of the new message; the reply streams
     over the EXISTING run SSE and the run is linked to the conversation (conversationId + turnIndex) as
     the next turn. Every turn stays --network=none, cost-capped (the published version's caps), and
     Guard-fronted (AD-1/AD-9). This is "a turn is a normal run, parameterized by a DEFINITION" — the
     test console runs the draft, a chat turn runs the published snapshot, ONE run/execute path. No web
     surface (9.3), no rename/delete/history-windowing (9.4). Contracts already at v8 — NO bump. -->

## Story

As the builder,
I want each message I send to run the agent's published definition with the conversation so far,
so that the agent replies in context, safely, exactly as published.

## Acceptance Criteria

1. **Given** a conversation pinned to published version v_N, **when** the builder sends a message, **then** the orchestrator builds a run from the **published snapshot** (`agent_versions` v_N) — model / instructions / skills / attachedTools / costCap from the snapshot, **NOT** the draft `agents` row — injects the prior turns into `JobSpec.history`, and runs it as a fresh `--network=none`, cost-capped, Guard-fronted sandbox (AD-1/AD-9); the harness folds the history into the model context ahead of the new message. [Source: epics.md#Story-9.2 AC1, #Architecture-and-scope-decisions ("a turn is a normal run, parameterized by a DEFINITION")]

2. **Given** the turn runs, **when** the agent replies, **then** the reply streams over the **existing** run event stream (`GET /runs/:id/events`) and the run is appended to the conversation as the next turn (linked by `conversationId` + `turnIndex`); the published version's caps apply per turn (kill-on-breach unchanged), observed like any run. [Source: epics.md#Story-9.2 AC2, AD-7]

3. **Given** the agent is republished mid-conversation, **when** the next turn runs, **then** it still uses the conversation's **pinned** version (v_N) — in-flight behavior doesn't change; a newer publish never retroactively changes an open conversation. [Source: epics.md#Story-9.2 AC3, decision (2) — the immutable-snapshot model]

## Tasks / Subtasks

### Cluster A — the run store + orchestrator reach (AC #1, #2, #3)

- [x] **Task 1: `RunsRepo.listByConversation` + widen the orchestrator's agents reach** (AC: #1, #2)
  - [x] `apps/control-api/src/runs/repo.ts` — add `listByConversation(conversationId: string): Promise<RunRow[]>` (turnIndex ASC — full `RunRow` WITH transcript; history reconstruction needs the agent turn text, so NOT the summary projection) to the `RunsRepo` interface (`:70-81`) + BOTH impls. Drizzle: `db.select().from(runs).where(eq(runs.conversationId, conversationId)).orderBy(asc(runs.turnIndex))` — **import `asc`** (line 1 currently imports only `and, desc, eq, gte, sql`). In-memory fake: filter `r.conversationId === conversationId`, sort by `turnIndex` ascending, return copies (mirror `list()`'s transcript clone).
  - [x] `apps/control-api/src/runs/orchestrator.ts` — widen the internal `AgentsReader` interface (`:28-30`) to add `listVersions(id: string): Promise<AgentVersionRow[]>` (import the type from `../agents/repo.js`). The concrete `agentsRepo` passed in `app.ts` is the full `AgentsRepo` (already has `listVersions`) — only the orchestrator's narrowed interface hides it. Add `conversationsRepo?: ConversationsRepo` to `OrchestratorDeps` (`:67-83`) + destructure it (`:97`) — the orchestrator resolves the conversation for a chat turn.

- [x] **Task 2: The chat-turn build path — published snapshot + history + link** (AC: #1, #2, #3)
  - [x] `apps/control-api/src/runs/orchestrator.ts` — **parameterize the ONE run-build path** (the epic's goal: test console = draft, chat = published snapshot, no fork). Recommended shape:
    - Extract the assembly body of `validateAndCreate` (`:340-366` — slot reserve + 429 + resolveRunConnections/Tools/Recall + build `jobSpec` + `row` + `create` + `hub.open` + return `Created`) into a private `assembleRun(agent: AgentLike, taskInput: string, chat: { conversationId: string; turnIndex: number; history: JobHistoryTurn[] } | null): Promise<Created>`. Inside it: `history: chat?.history ?? []` in the `jobSpec` literal (`:354`, replacing the hard-coded `[]`); `conversationId: chat?.conversationId ?? null, turnIndex: chat?.turnIndex ?? null` in the `row` literal (`:358`, replacing the hard-coded nulls). Keep the `agent.model` 400 + 429 + `active++`/release logic in `assembleRun`.
    - `validateAndCreate(agentId, taskInput)` (draft path, UNCHANGED public behavior): `const agent = await agentsRepo.get(agentId); if (!agent) 404;` → `assembleRun(agent, taskInput, null)`. The `launch`/`start` public signatures (`:471`, `:480`) stay `(agentId, taskInput)` — the heavily-tested draft path is untouched.
    - Add a NEW private `validateChatTurn(conversationId, taskInput): Promise<Created | {ok:false,...}>`: resolve the conversation (`conversationsRepo.get` → 404 "That conversation doesn't exist."); resolve the PINNED snapshot — `const pinned = (await agentsRepo.listVersions(conv.agentId)).find(v => v.version === conv.publishedVersion)`; 404/409 if absent ("That published version is no longer available."); build an `AgentLike` from `pinned.snapshot` (`{ id: conv.agentId, model: snap.model, instructions: snap.instructions, state: "active" /* unused — the run path is state-agnostic, orchestrator.ts:325 */, skills: snap.skills, attachedTools: snap.attachedTools, costCap: snap.costCap }`); build `history` + `turnIndex` from `runsRepo.listByConversation(conv.id)` — `turnIndex = prior.length`, `history = prior.flatMap(r => r.transcript.filter(m => m.type === "turn").map(m => ({ role: m.role, content: m.text })))` (mirror the reflector's turn extraction at `:222-224`; a run's transcript already carries BOTH its user turn (`main.ts:167`) and the agent reply (`main.ts:222`), so this reconstructs the full thread); → `assembleRun(agentLike, taskInput, { conversationId: conv.id, turnIndex, history })`.
    - Add `startChatTurn(conversationId: string, taskInput: string): Promise<LaunchResult>` to the public API (mirror `start` at `:480-491`): `validateChatTurn` → background `execute(...).then(reflectRun).catch(...)` → return `{ ok:true, run: { ...v.row, status: "running" } }`. Chat turns reflect + recall like any run (Epic 8 long-term memory composes with the thread's short-term history — recall keys on `agent.id`, read live).
  - [x] **Version-pin invariant (AC #3):** because `validateChatTurn` resolves the snapshot for `conv.publishedVersion` (pinned at 9.1 creation), republishing the agent to v_{N+1} never changes an in-flight conversation — nothing extra to build; assert it in tests.

### Cluster B — the harness fold (AC #1)

- [x] **Task 3: Fold `spec.history` into the model context** (AC: #1)
  - [x] `apps/agent-harness/src/main.ts` — between the memories fold (ends `:181`) and the current-turn `taskInput` push (`:182`), insert the prior turns: `for (const h of spec.history) messages.push({ role: h.role === "agent" ? "assistant" : "user", content: h.content });`. Order becomes: system(instructions) → system(memories) → [prior user/assistant turns…] → current user turn. Role map: **`agent` → `assistant`**, `user` → `user`. `JobSpecSchema` already accepts `history` (default `[]`) — NO schema change; only the fold is new (the contract comment at `contracts/index.ts:8` already says "the harness folds it into the model context in Story 9.2"). Line `:167` (the current-turn `role:"user"` transcript echo) is unchanged.

### Cluster C — the chat-turn endpoint (AC #2)

- [x] **Task 4: `POST /conversations/:id/messages` — send a message, run a turn** (AC: #1, #2)
  - [x] `apps/control-api/src/conversations/routes.ts` — add `orchestrator: RunOrchestrator` to `conversationRoutes(repo, agentsRepo, orchestrator)` (the route stays thin — it delegates to `orchestrator.startChatTurn`, which owns the snapshot/history resolution). Route: `POST /conversations/:id/messages` — validate the body (`taskInput` string, bound to `MAX_TASK_INPUT = 10_000`, mirror `runs/routes.ts:13,61`); `const r = await orchestrator.startChatTurn(c.req.param("id"), taskInput)`; `if (!r.ok) return c.json({ error: r.error }, r.status)`; `return c.json({ run: r.run }, 201)`. Returning `{ run }` (with `run.id`) mirrors `POST /runs` exactly, so the web (9.3) opens the **existing** `GET /runs/:id/events` SSE with zero SSE changes. Already session-guarded via `/conversations/*` (`app.ts`).
  - [x] `apps/control-api/src/app.ts` — pass `orchestrator` into `conversationRoutes(...)` (`:~102`); wire `conversationsRepo` into the default orchestrator's deps (`:101-103`). `apps/control-api/src/server.ts` — wire `conversationsRepo` into the real orchestrator's deps too. (The orchestrator is constructed AFTER `conversationsRepo` in both — verify ordering; move the `conversationsRepo` construction up if needed.)

### Cluster D — tests + verification (AC: all)

- [x] **Task 5: Tests + full verification** (AC: all)
  - [x] **control-api unit** (`runs/runs.test.ts` or a new `conversations/turn.test.ts`): a chat turn builds from the **published snapshot, not the draft** — publish v1 (snapshot model/instructions X), then EDIT the draft (model/instructions Y, unpublished), start a chat turn → the run's jobSpec carries the **snapshot's** X, not the draft's Y (assert via `runtime.established[i].jobSpecJson`, the pattern at `runs.test.ts:42`); the run is linked (`conversationId`/`turnIndex`) and appended in order (turn 0, then turn 1 sees turn 0 in its `history`); `JobSpec.history` carries the prior turns (`runtime.established[1].jobSpecJson` contains the first turn's text); **republish v2 after the conversation pinned v1 → the next turn STILL uses v1's snapshot** (AC #3); the published version's `costCap` flows to the run (the cost-key mint path). Use the `fakeSandboxRuntime` + `orch(...)` harness (`runs.test.ts:21-30`) with a fake agentsRepo exposing `listVersions` + a `memoryConversationsRepo`.
  - [x] **control-api unit** (`runs/repo.test.ts` or `runs.test.ts`): `listByConversation` returns the conversation's runs in `turnIndex` ASC with transcripts, scoped (never another conversation's).
  - [x] **control-api unit** (`conversations/routes.test.ts`): `POST /conversations/:id/messages` runs a turn (201 + `{ run }`); an unknown conversation → 404; session-guarded (401). (A fake orchestrator whose `startChatTurn` returns a canned run keeps this a routing test.)
  - [x] **agent-harness unit** (`main.test.ts`): a spec with `history` folds prior turns as `user`/`assistant` messages BEFORE the current `taskInput`, after instructions + memories (assert the model-request `messages` order; mirror the memories fold test).
  - [x] **web** — `svelte-check` clean (no web changes expected in 9.2; the surface is 9.3).
  - [x] `pnpm -r build` · `pnpm lint` · all unit suites green · **e2e via `deploy/test-stack.sh`** — the v8 stack already applies (9.1's `0019`); no new migration. Prove live: create a conversation against a published agent (9.1), `POST /conversations/:id/messages` → a run id comes back and the run links to the conversation with `turn_index` 0 (query the DB), a second message → `turn_index` 1 and its jobSpec carried the first turn (a real model reply needs a provider key — gated; assert the LINK + turnIndex progression + that the run was built, which needs no model). **Never `down -v` the dev stack**; restore + verify dev data. See [[turanga-e2e-clean-run]].
  - [x] Bookkeeping: check every task box, fill Dev Agent Record / File List / Change Log, Status → review.

## Dev Notes

**Chat = threaded runs, made real.** 9.1 modeled the thread; 9.2 runs it. A message → a fresh run built from the pinned published snapshot, carrying the thread so far in the immutable `JobSpec` (AD-9), streaming its reply over the same SSE the test console uses, linked back to the conversation. No long-lived sandbox, no mid-run side-channel — the whole thread-so-far is baked in at turn start (AD-9).

### The ONE design fork — parameterize, don't fork the run path
The epic's binding constraint: *"A turn is a normal run, parameterized by a DEFINITION."* The test console runs the draft (`agentsRepo.get`); a chat turn runs the published snapshot (`agent_versions`). The recommended implementation lifts the *agent resolution* OUT of `validateAndCreate` into a shared `assembleRun(agent, taskInput, chat?)`, so both the draft path (`validateAndCreate` → resolve draft → assemble) and the chat path (`validateChatTurn` → resolve snapshot + history → assemble) share the identical Sandbox/Guard/cost-cap/execute machinery. **Do NOT branch `execute()` or `assembleRun()` on chat-vs-draft** — the only differences are the resolved `AgentLike`, the `history`, and the `conversationId`/`turnIndex` on the row. This honors the state-agnostic-run invariant (`orchestrator.ts:325-329`) and keeps the heavily-tested draft path (public `launch`/`start(agentId, taskInput)`) byte-identical.

### The published snapshot IS a complete run definition
`agent_versions.snapshot` (`AgentSnapshot = Pick<Agent, PublishedField>`) carries `model, instructions, skills, attachedTools, costCap` (+ name/description/variables) — everything the run path reads. It deliberately omits `state` (unused — the run path is state-agnostic) and `memoryConfig` (operational; recall reads the live per-agent config keyed by `agent.id`, which composes correctly). Build the `AgentLike` from the snapshot + `conversation.agentId`; there is NO "get version N" repo method, so `listVersions(agentId).find(v => v.version === conv.publishedVersion)` (newest-first list; a single `.find`). If the pinned version is somehow gone, refuse with a stated cause — don't fall back to the draft.

### History reconstruction (from the linked runs)
A conversation has no separate turns table — its thread is DERIVED from its linked runs (9.1's `conversation_id`/`turn_index`). Each prior run's `transcript` already carries its user turn (`main.ts:167`) and the agent reply (`main.ts:222`) as `turn` messages, so `history = prior.flatMap(r => r.transcript.filter(t => t.type==="turn").map(t => ({role: t.role, content: t.text})))` reconstructs the full thread (mirror the reflector's extraction, `orchestrator.ts:222-224`). `turnIndex` for the new run = `prior.length` (0-based). 9.2 injects the FULL prior thread; **history windowing/summarization is Story 9.4** — do not bound it here beyond what exists (a note, not a task).

### Recall + reflect compose with chat (Epic 8 × Epic 9)
A chat turn is a normal run, so it runs recall (long-term memory injected alongside the thread's short-term `history`) and reflect (post-run distillation) exactly like a test run — both key on `agent.id`. This is the intended composition (short-term thread memory + long-term cross-conversation memory, same "inject into the immutable spec at run start" seam). Keep `reflectRun` chained on the chat turn (`startChatTurn` mirrors `start`).

### Caps apply per turn (AC #2), pinned version wins (AC #3)
The snapshot's `costCap` flows through `AgentLike.costCap` → `Created.costCap` → the per-run cost-key mint (`execute` `:387-388`) → kill-on-breach unchanged. Because the snapshot is resolved for `conv.publishedVersion` (pinned at creation), republishing the agent to a newer version never changes an in-flight conversation — the pinned resolve is the whole mechanism (assert with a publish-v2-after-pin test).

### Architecture (binding)
- **AD-1** — each turn is a fresh `--network=none` sandbox; `assembleRun`/`execute` are unchanged, so isolation holds identically.
- **AD-7 — control-api sole writer.** The run-orchestrator owns run rows (incl. the conversation link); conversation metadata is control-plane. The harness never writes.
- **AD-9 — immutable JobSpec.** `history` is baked in at run start; no mid-run side-channel. A turn completes, then the user replies (no mid-turn human-in-the-loop — deferred).
- **AD-10 — no secret in the sandbox.** `history` is secret-free turn content (like `taskInput`); the snapshot→JobSpec carries only logical handles + IDs + secret-free text, same as any run.

### Existing patterns to mirror (file:line)
- **Run build + execute:** `orchestrator.ts` `validateAndCreate` (`:324-367`), `execute` (`:371-467`), `start`/`launch` (`:471-491`); the JobSpec literal (`:354`, gains `history`), the RunRow literal (`:358`, gains the link).
- **Snapshot resolve:** `agents/repo.ts` `listVersions` (`:80`, `:234-242`), `AgentVersionRow`/`AgentSnapshot`/`snapshotOf` (`:46-51`, `:38`, `:85-96`); `PublishedField` (`domain/index.ts:76-86`).
- **Turn extraction (for history):** `orchestrator.ts:222-224` (reflector), `RunTranscript.svelte:29-33`; the harness turn emits (`main.ts:167`, `:222`).
- **Harness fold:** `main.ts:169-182` (memories at `:175-181`, taskInput at `:182`); `GuardModelRequest.messages` roles `system|user|assistant` (`contracts/index.ts:129`).
- **The endpoint:** `runs/routes.ts` `POST /runs` (`:56-69`) + the SSE `GET /runs/:id/events` (`:80-144`); `conversations/routes.ts` (9.1 — add the messages route); wiring `app.ts` (`:102`) + `server.ts`.
- **Tests:** `runs/runs.test.ts` the `orch(...)` factory + `fakeSandboxRuntime` + `jobSpecJson` assertions (`:21-42`); `conversations/routes.test.ts` (9.1) for the route/guard shape.

### Project Structure Notes
- **Edited:** `apps/control-api/src/runs/repo.ts` (`listByConversation` + `asc` import; + `repo.test.ts`), `apps/control-api/src/runs/orchestrator.ts` (widen `AgentsReader`, `conversationsRepo` dep, `assembleRun`/`validateChatTurn`/`startChatTurn`; + `runs.test.ts`), `apps/agent-harness/src/main.ts` (history fold; + `main.test.ts`), `apps/control-api/src/conversations/routes.ts` (messages route; + `routes.test.ts`), `apps/control-api/src/app.ts` + `server.ts` (wire orchestrator↔conversationsRepo).
- **No change:** contracts (v8 already has `history` — NO bump), the domain, the schema/migrations (9.1's `0019` suffices — no new table/column), the SSE route + hub (reused as-is), the web (9.3 builds the surface).
- **Scope guard:** NO web `/chat` surface (9.3), NO conversation rename/delete (9.4), NO history windowing/summarization (9.4 — 9.2 injects the full thread), NO mid-turn human-in-the-loop / token-level streaming / shared-end-user chat (all deferred). This story is: build-from-snapshot + inject history + the harness fold + link the run + the send-message endpoint.

### Testing standards
- Vitest, in-memory fakes (`memoryRunsRepo`, `memoryConversationsRepo`, a fake agentsRepo with `listVersions`, `fakeSandboxRuntime`), `jobSpecJson` assertions for what reached the sandbox. `svelte-check` for web (no web change expected). Full verification: `pnpm -r build`, `pnpm lint`, `deploy/test-stack.sh` e2e proving the link/turnIndex progression live (no new migration; a real model reply is provider-gated — assert the run-build + link, not the reply); never `down -v` the dev stack.

### References
- [Source: epics.md#Epic-9 (chat = threaded runs; "a turn is a normal run, parameterized by a DEFINITION"; the pinned published version; history injected into the immutable spec) + #Story-9.2 (the three ACs)]
- [Source: architecture spine #AD-1 (network=none), #AD-7 (control-api sole writer), #AD-9 (immutable JobSpec at run start; no mid-run side-channel), #AD-10 (no secret in the sandbox)]
- [Source: 9-1-conversation-model-and-published-version-binding (the Conversation model + run link + JobSpec.history shape this consumes) ; the orchestrator.ts:331-334 decision note (chat resolves the published version itself)]
- [Source: [[turanga-e2e-clean-run]] — reset for pristine; never `down -v` the dev stack; warm Vite]

## Dev Agent Record

### Agent Model Used

claude-opus-4-8 (Claude Opus 4.8)

### Debug Log References

- **`AgentsReader` widening rippled to the test helper.** Adding `listVersions` to the orchestrator's narrowed `AgentsReader` broke the `runs.test.ts` `agentsRepo` fake (11 call sites) — fixed by adding `listVersions: async () => []` to the one shared helper (`:17`), so the draft-path tests are untouched (they never call it).
- **`buildMessages` extracted for testability.** The harness's model-message assembly was inline in `runHarness` (untestable without the Guard). Extracted a pure `buildMessages(spec)` (exported) so the history-fold order is unit-tested; `runHarness` just calls it. No behavior change.
- **Fake-runtime history reconstruction.** In the chat-turn test, the fake sandbox doesn't run the real harness, so turn 0's transcript only contains what the script emits — I script BOTH the user turn (`role:"user"`) and the agent turn (`role:"agent"`), mirroring what the real harness emits (`main.ts:167` + `:222`), so turn 1's reconstructed `history` matches the real thread.

### Completion Notes List

- **One run-build path, parameterized (the epic's goal).** Lifted agent resolution out of `validateAndCreate` into a shared `assembleRun(agent, taskInput, chat?)`. The draft path (`validateAndCreate` → `agentsRepo.get`) and the chat path (`validateChatTurn` → the pinned snapshot + history) feed the identical Sandbox/Guard/cost-cap/execute machinery — `execute()` never branches on chat-vs-draft. The public `launch`/`start(agentId, taskInput)` signatures are byte-identical, so the heavily-tested draft path is untouched (238 pre-existing control-api tests stayed green through the refactor).
- **Chat runs the PUBLISHED snapshot, not the draft.** `validateChatTurn` resolves `agentsRepo.listVersions(conv.agentId).find(v => v.version === conv.publishedVersion)` and builds an `AgentLike` from the snapshot (model/instructions/skills/attachedTools/costCap). The snapshot carries everything the run path reads; `state` is unused (state-agnostic invariant). Unit-proven: a turn's jobSpec carries the snapshot's model/instructions, and **republishing to v2 after a v1-pinned conversation still runs v1** (AC #3).
- **History = the thread so far, reconstructed from the linked runs.** No separate turns table — `history` is `runsRepo.listByConversation(id).flatMap(transcript turns → {role, content})`, and `turnIndex = prior.length`. The harness folds it (`agent`→`assistant`) between the memories and the current message. 9.2 injects the FULL prior thread; windowing is Story 9.4.
- **A chat turn is a normal run** — recall + reflect compose (Epic 8 long-term memory alongside the thread's short-term history, both keyed on `agent.id`); the published version's `costCap` flows to the per-run cost key (kill-on-breach unchanged, unit-asserted via the minted key's `perRunCap`).
- **The endpoint** `POST /conversations/:id/messages` delegates to `orchestrator.startChatTurn` and returns `{ run }` (id) — the web (9.3) opens the **existing** `GET /runs/:id/events` SSE, zero SSE changes.
- **NO contract bump** (v8 already has `history`), **NO new migration** (9.1's `0019` suffices).
- **Verification:** contracts 16, domain 5, harness 12 (+2), guard 31, control-api 246 (+8: 4 chat-turn, 3 messages-route, 1 listByConversation), svelte-check + `pnpm -r build` + `pnpm lint` clean. e2e on the isolated stack: the v8 harness (now history-fold-capable) rebuilt and booted healthy; live — a published agent → a conversation → two `POST …/messages` each spawned a run **linked** to the conversation with `turn_index` 0 then 1 (verified in the DB; the runs `failed` at the model call only because the e2e stack has no real provider key — the build-from-snapshot + link + turnIndex progression is what's proven). Dev stack restored, 2 agents intact.

### File List

**New**
- `apps/control-api/src/conversations/turn.test.ts` (the chat-turn orchestrator tests)

**Edited — control-api**
- `apps/control-api/src/runs/repo.ts` — `listByConversation` (+ `asc` import) on the interface + both impls
- `apps/control-api/src/runs/orchestrator.ts` — widen `AgentsReader` (`listVersions`), `conversationsRepo` dep, `assembleRun`/`validateAndCreate`/`validateChatTurn`/`startChatTurn`
- `apps/control-api/src/runs/runs.test.ts` — `listVersions` on the fake; `listByConversation` test
- `apps/control-api/src/conversations/routes.ts` — `POST /conversations/:id/messages` (+ orchestrator param, MAX_TASK_INPUT)
- `apps/control-api/src/conversations/routes.test.ts` — messages-route tests
- `apps/control-api/src/app.ts` — wire `conversationsRepo` into the orchestrator; mount `conversationRoutes` after it (with the orchestrator)
- `apps/control-api/src/server.ts` — wire `conversationsRepo` into the real orchestrator

**Edited — agent-harness**
- `apps/agent-harness/src/main.ts` — extract `buildMessages` + fold `spec.history` (agent→assistant, before the current message)
- `apps/agent-harness/src/main.test.ts` — `buildMessages` history-fold tests

### Change Log

| Date | Version | Description |
|------|---------|-------------|
| 2026-08-05 | 0.1 | Story 9.2 implemented — run a chat turn against the published version, with history. Parameterized the ONE run-build path (draft vs published snapshot) via `assembleRun`; `startChatTurn` + `POST /conversations/:id/messages` build from the pinned `agent_versions` snapshot with the thread so far as `history`; the harness folds history into the model context; the run links to the conversation (`conversationId`/`turnIndex`) and streams over the existing SSE. Chat turns recall + reflect like any run; the published version's caps apply per turn; a mid-conversation republish keeps the pinned version. No contract bump, no new migration. Verified: all unit suites + build + lint + svelte-check clean; e2e proves the link + turnIndex progression live. Status → review. |
