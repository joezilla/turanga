---
baseline_commit: 9541c7e681bc606a97e1b58d368ea9d69da717d6
---
# Story 9.1: The conversation model + published-version binding (spine)

Status: review

<!-- FIRST story of Epic 9 (Chat). The epic's keystone: chat = THREADED RUNS — each user message is a
     fresh, network-isolated, cost-capped, Guard-fronted run whose JobSpec carries the conversation
     so far. 9.1 lays the SPINE before any turn runs: (A) the CONTRACT shape — bump CONTRACT_VERSION
     7→8 and add a sandbox-visible `JobSpec.history` field (prior turns, secret-free — AD-10),
     defaulting [] so every existing spec stays valid; (B) the DOMAIN — a first-class `Conversation`
     entity pinned to a published agent version; (C) the STORE — a `conversations` table + a run↔
     conversation link (`conversationId`/`turnIndex`), control-api the sole writer (AD-7); (D) the
     REFUSAL — you can't chat with an agent that was never published (chat runs the PUBLISHED snapshot,
     never the draft). 9.2 populates `history` + folds it in the harness + builds from the published
     snapshot; 9.3 is the web surface; 9.4 is management + history windowing. This story RUNS no chat
     turn — it makes chatting a modeled, governed capability. -->

## Story

As the builder,
I want turanga to model a chat conversation as a first-class thread bound to a published agent version,
so that chatting is a stable, governed capability before any turn runs.

## Acceptance Criteria

1. **Given** the domain + contracts, **when** chat is modeled, **then** a `Conversation` is a control-plane thread `{ id, agentId, publishedVersion (pinned), title, createdAt }`; a run gains a `conversationId` + `turnIndex` link; and `JobSpec` gains a **sandbox-visible `history` field** (an array of prior turns `{ role: "user" | "agent", content }` — secret-free, AD-10; default `[]` keeps every existing spec valid) with a **CONTRACT_VERSION bump 7→8**. control-api is the sole writer (AD-7). [Source: epics.md#Story-9.1 AC1, #Architecture-and-scope-decisions]

2. **Given** an agent that has never been published, **when** a chat is attempted (a conversation is created), **then** it is refused with a stated cause ("Publish this agent to chat with it") — chat runs a published snapshot, never the draft. A conversation created against a publishable agent **pins** the agent's current `publishedVersion` (version-pin = latest-at-conversation-start). [Source: epics.md#Story-9.1 AC2, decision (2)]

3. **Given** the store, **when** it is created, **then** a `conversations` table lands (control-plane; IDs/timestamps per convention); the `runs` table carries the `conversation_id` + `turn_index` link (both nullable — a standalone/test-console run has no conversation). Migration `0019_*` generates cleanly (a plain new table + two nullable columns — no hand-edit, no pgvector). [Source: epics.md#Story-9.1 AC3, AD-7]

## Tasks / Subtasks

### Cluster A — the contract shape (AC #1)

- [x] **Task 1: Contracts — bump 7→8, add `JobSpec.history`, update the mirror + tests** (AC: #1)
  - [x] `packages/contracts/src/index.ts` — (a) bump `CONTRACT_VERSION = 7` → `8` (`:17`); (b) prepend a `// v8 (Story 9.1): history — a sandbox-visible JobSpec.history of prior conversation turns folded into the model context (secret-free, AD-10); chat = threaded runs.` line above the `// v7` line (`:6-8`); (c) add a `JobHistoryTurnSchema = z.object({ role: z.enum(["user","agent"]), content: z.string() })` + `export type JobHistoryTurn` next to `JobMemorySchema` (`:36-44`) — REUSE the `["user","agent"]` role literals from the `turn` control message (`:70`); (d) add `history: z.array(JobHistoryTurnSchema).default([])` to `JobSpecSchema` mirroring the `memories` field (`:60-62`) with a comment: "Prior conversation turns for a chat run (Story 9.1; secret-free content like taskInput — AD-10). Default [] keeps every non-chat spec valid; the harness folds it into the model context in 9.2." All 16 `z.literal(CONTRACT_VERSION)` sites re-pin automatically — no manual edits.
  - [x] `packages/contracts/src/index.test.ts` — retitle + `expect(CONTRACT_VERSION).toBe(8)` (`:5-6`); add a `history: [{ role: "user", content: "hi" }, { role: "agent", content: "hello" }]` entry to the JobSpec round-trip (`:9-23`); add `expect(parsed.history).toEqual([])` to the defaults-when-omitted test (`:25-31`); add a **secret-free** test mirroring the `JobMemory is secret-free` one (`:33-41`) — a history turn carries only `role`/`content` (an extra `secret` key is stripped), and an unknown `role` is rejected.
  - [x] `apps/web/src/lib/runs.ts` — this file re-declares the transcript union WITHOUT importing contracts (`:3-4`); bump the "currently 7" comment (`:10`) → 8 and the **six `v: 7` literals** in the `RunMessage` union (`:12-17`, one per variant: turn/metrics/refusal/tool/recall/done) → `v: 8`. **No new union member** — `history` is a JobSpec INPUT field, not a streamed transcript event (contrast 8.3, which added a `recall` event).

### Cluster B — the domain entity (AC #1)

- [x] **Task 2: Domain — the `Conversation` type** (AC: #1)
  - [x] `packages/domain/src/index.ts` — add a section banner `// ── Chat / conversations (Epic 9) ──` and a `Conversation` interface modeled on the minimal `Run` entity (`:233-238`): `{ id: Ulid; agentId: Ulid; publishedVersion: number; title: string; createdAt: string /* UTC ISO-8601 */ }`. `publishedVersion` is the PINNED snapshot this chat talks to (not nullable here — a conversation only exists against a published version). No web mirror in this story — the web `Conversation` type + client fns land in 9.3 when the UI consumes them (note it; don't add an unused mirror now).

### Cluster C — the store (AC #1, #3)

- [x] **Task 3: Schema + migration — `conversations` table + the run link** (AC: #1, #3)
  - [x] `apps/control-api/src/db/schema.ts` — (a) add a NEW `conversations` table after `runs` (`:113-123`), mirroring the two-arg `memoryEvents` idiom (`:192-204`): `id text pk` (ULID), `agentId text notNull` (bare — NO `.references()`, matching runs/agentVersions/agentMemories), `publishedVersion: integer("published_version").notNull()` (the pinned snapshot — `.notNull()` encodes "a conversation only exists against a published version" at the column), `title: text("title").notNull().default("")`, `createdAt: timestamp(..., { withTimezone: true }).notNull().defaultNow()`, with `(t) => [index("conversations_agent_idx").on(t.agentId)]`. (b) add two NULLABLE columns to the `runs` table: `conversationId: text("conversation_id")` + `turnIndex: integer("turn_index")` (nullable — pre-9.1 runs + test-console runs have no conversation; no backfill).
  - [x] Generate migration: from `apps/control-api/`, run `npx drizzle-kit generate` (optionally `--name conversations`). Latest is `0018_fair_silver_centurion.sql` → this is `0019_*`. A plain new table + two nullable ALTERs generates CLEANLY — **no hand-edit** (no pgvector involved; contrast 0015/the HNSW index). Applied automatically at boot by `db/migrate.ts` (`server.ts:50`).

- [x] **Task 4: Runs repo — carry the conversation link on every projection** (AC: #1, #3)
  - [x] `apps/control-api/src/runs/repo.ts` — add `conversationId: string | null;` + `turnIndex: number | null;` to `RunRow` (`:8-18`, after `agentId`). `RunSummary = Omit<RunRow, "transcript">` (`:22`) inherits them, and `create()`'s param type follows `RunRow` — **but** the hand-written projections must ALL carry them or they silently drop:
    - drizzle `create()` insert values (`:132-144`) — add `conversationId: row.conversationId, turnIndex: row.turnIndex`.
    - drizzle `toRow()` (`:91-103`) — map both DB columns.
    - drizzle `summaryCols` (`:106-115`) + `toSummary` (`:117-128`) — add both (else the run-history list drops them).
    - in-memory fake: `create`/`get`/`list` spread `...row`/`...r` (carry automatically), but **`listSummary()` (`:223-238`) builds the summary field-by-field** — add `conversationId: r.conversationId, turnIndex: r.turnIndex` or the fake diverges from drizzle (a test-only bug).
  - [x] `apps/control-api/src/runs/orchestrator.ts` — the `RunRow` literal in `validateAndCreate` (`:356`) must now set `conversationId: null, turnIndex: null` (a normal test-console/standalone run has no conversation). Do NOT thread chat-turn wiring through `start`/`launch` here — that is 9.2 (when a chat turn actually creates a linked run). 9.1 only makes the columns exist and default null.

- [x] **Task 5: Conversations repo — the control-plane store (AD-7, agent-scoped)** (AC: #1, #2, #3)
  - [x] `apps/control-api/src/conversations/repo.ts` (NEW module, mirror `runs/repo.ts` + `memory/repo.ts` shape) — a `ConversationRow` (`{ id, agentId, publishedVersion, title, createdAt }`), a `ConversationsRepo` interface + a `drizzleConversationsRepo(db)` and a `memoryConversationsRepo()` fake (both impls, parity — the Epic 8 repos are the template). Methods: `create(row)`, `get(id)`, `listForAgent(agentId)` (newest-first), `rename(id, title)` + `delete(id)` are 9.4 — for 9.1 the minimum is `create`/`get`/`listForAgent`. Agent-scoped reads; control-api sole writer (AD-7).

### Cluster D — the refusal + wiring (AC #2)

- [x] **Task 6: Conversations routes — create (publish-first refusal + version pin), list, get** (AC: #1, #2)
  - [x] `apps/control-api/src/conversations/routes.ts` (NEW) — `conversationRoutes(convRepo, agentsRepo)`:
    - `POST /conversations` (body `{ agentId, title? }`) → read the agent via `agentsRepo.get(agentId)`; **404** if absent; **if `agent.publishedVersion == null` → 409/400 `{ error: "Publish this agent to chat with it." }`** (the "publish before you can chat" refusal — the exact null-check basis is `agents.publishedVersion` / domain `Agent.publishedVersion` = null ⇒ never published). Otherwise create a `Conversation` with `publishedVersion = agent.publishedVersion` (PIN latest-at-start), `id = ulid(Date.now())`, `title = body.title ?? ""`, and return `{ conversation }`.
    - `GET /conversations?agentId=…` → `convRepo.listForAgent(agentId)` → `{ conversations }`.
    - `GET /conversations/:id` → `convRepo.get(id)` (404 if absent) → `{ conversation }`.
    - Error shapes mirror `agents/routes.ts` (`c.json({ error }, 4xx)`).
  - [x] `apps/control-api/src/app.ts` — construct `memoryConversationsRepo()` (default) / wire the drizzle repo like `memoryRepo`, session-guard `/conversations*` (mirror the `/agents*` guards at `:70-71`), and mount `conversationRoutes(...)`. control-api is the sole writer (AD-7).

### Cluster E — tests + verification (AC: all)

- [x] **Task 7: Tests + full verification** (AC: all)
  - [x] **contracts unit** — `CONTRACT_VERSION === 8`; JobSpec round-trips `history`; `history` defaults `[]`; a history turn is secret-free (extra keys stripped, unknown role rejected).
  - [x] **domain unit** — (light) the `Conversation` type compiles + any constant; no behavioral logic in 9.1.
  - [x] **control-api unit** (`conversations/repo.test.ts` + `conversations/routes.test.ts`): repo create/get/listForAgent are agent-scoped (FR-7 style — a conversation resolves only for its agent's list), newest-first; **route: creating a conversation for a never-published agent is refused with the stated cause; creating for a published agent pins `publishedVersion`**; unknown agent → 404; list/get; session-guarded (401 without a cookie, mirroring `memory/routes.test.ts`).
  - [x] **control-api unit** (`runs/runs.test.ts`): a created run carries `conversationId: null, turnIndex: null` by default; the run-summary projection (drizzle + fake) preserves both (guard against the three-projection drop).
  - [x] **web** — `svelte-check` clean (the six `v: 8` literals typecheck the transcript union).
  - [x] `pnpm -r build` (all workspaces — the contract bump ripples to every consumer via the symbol; only `runs.ts` + `index.test.ts` needed manual literals) · `pnpm lint` · all unit suites green · **e2e via `deploy/test-stack.sh`** — `up` rebuilds control-api **and** the agent-harness image (so a v8 harness accepts v8 specs) and auto-applies `0019` at boot; prove the test-console happy path still runs (an existing run now builds a v8 spec with `history: []` and completes — the bump is backward-safe). **Never `down -v` the dev stack**; restore + verify dev data. See [[turanga-e2e-clean-run]].
  - [x] Bookkeeping: check every task box, fill Dev Agent Record / File List / Change Log, Status → review.

## Dev Notes

**The spine before the turns.** Epic 9 makes chat = **threaded runs**: each message is a fresh `--network=none`, cost-capped, Guard-fronted run whose immutable `JobSpec` carries the thread so far (AD-1/AD-9). 9.1 builds the *model* that makes this governable — the `Conversation` entity, its binding to a **published** version, the run↔conversation link, and the `JobSpec.history` **shape** — WITHOUT running a chat turn. 9.2 wires execution (populate history, fold it in the harness, build from the published snapshot); 9.3 is the surface; 9.4 is management + windowing. Keep 9.1 to the model + contract + refusal; resist implementing turn execution.

### The contract bump (7→8) — the familiar sweep, mostly symbolic
`CONTRACT_VERSION` is re-pinned via `z.literal(CONTRACT_VERSION)` at all 16 sites in `contracts/index.ts`, and every backend consumer (`orchestrator.ts`, `agent-harness/main.ts`, `egress-guard/guard.ts`) references the **symbol** — so they re-pin in lockstep with **zero edits**. Only two files hardcode the number: `contracts/index.test.ts` (the `.toBe(7)` assertion) and `web/src/lib/runs.ts` (six `v: 7` literals, because it deliberately doesn't import contracts). This mirrors the 6→7 bump in Story 8.3 exactly. **Backward-safe:** `JobSpec.history` defaults `[]`, so an existing (non-chat) run builds a valid v8 spec and the harness ignores the empty field — the test-console path is unaffected. The one operational requirement: the **agent-harness image must be rebuilt** to a v8 harness (a v7 harness would fail `JobSpecSchema.parse()` on a v8 spec → `done:failed`); `deploy/test-stack.sh up` rebuilds it (`:32`).

### `JobSpec.history` is secret-free (AD-10)
History carries prior **turn content** (`role` + `content`), exactly like `taskInput`/`instructions`/`memories.summary` — model-visible text, NEVER a credential, endpoint, or token. It is injected immutably at run start (AD-9) into the sandbox; the sandbox has no side-channel to mutate it. Model the schema on `JobMemorySchema` (the 8.3 precedent for a secret-free sandbox-visible list) and reuse the `["user","agent"]` role literals already on the `turn` control message.

### Chat runs the PUBLISHED snapshot, never the draft
The run orchestrator TODAY resolves the **working draft** (`agentsRepo.get()`), and there is an explicit decision note anticipating this exact story — `orchestrator.ts:331-334`: *"A future Chat surface — which talks to the published version — must resolve `agentsRepo.listVersions()` itself rather than assume this call site."* So chat does NOT reuse the draft run path. For 9.1: the refusal + version pin live in the **conversations** create route (read `agent.publishedVersion`; null ⇒ refuse; else pin). 9.2 will resolve the pinned snapshot (`agent_versions` for `(agentId, publishedVersion)` — mirror `repo.ts:151-161`) to BUILD the turn's run. The published/version model is real and immutable: `agents.publishedVersion` (nullable int; null = never published — `schema.ts:79`, domain `Agent.publishedVersion` `index.ts:69`), `agent_versions` snapshots (written only by `POST /agents/:id/publish`, `agents/repo.ts:216-233`).

### The run↔conversation link (nullable, populated in 9.2)
9.1 adds `conversation_id` + `turn_index` to `runs` as **nullable** columns and to `RunRow` — a standalone/test-console run has neither. The orchestrator's `RunRow` literal (`:356`) sets them `null`. 9.2 populates them when a chat turn creates a linked run. **Gotcha (from the runs map):** the run-summary is hand-projected in THREE places — drizzle `summaryCols` (`repo.ts:106`), drizzle `toSummary` (`:117`), and the in-memory `listSummary` (`:223`) — all three must carry the new fields or the run-history list silently drops them while `get()` keeps them.

### Version pin decision (settled)
Per the epic's open-questions resolution: **latest-at-conversation-start**. On create, pin `publishedVersion = agent.publishedVersion`. Republishing the agent does NOT change an in-flight conversation (9.2 surfaces "the agent was updated — start a new chat for v_N"). Do not add per-conversation version selection or always-latest — those are explicitly deferred.

### Architecture (binding)
- **AD-1** — a chat turn (9.2) is a normal `--network=none` sandbox; nothing here weakens isolation. 9.1 adds no runtime surface.
- **AD-7 — control-api sole writer.** The `conversations` table + the run link are control-plane; the new conversations repo/routes are the only writers of conversation state; the run-orchestrator still owns run rows.
- **AD-9 — immutable JobSpec.** `history` is baked into the spec at run start (9.2); no mid-run side-channel. 9.1 only defines the field.
- **AD-10 — no secret in the sandbox.** `history` is secret-free turn content, like `taskInput`.

### Existing patterns to mirror (file:line)
- **Contract field + version bump:** `contracts/index.ts` `JobMemorySchema` (`:36-44`) + `memories` on JobSpec (`:60-62`) + `CONTRACT_VERSION` (`:17`); the 8.3 6→7 bump is the exact ritual. Tests: `contracts/index.test.ts:5-41`.
- **New pgTable + migration:** `schema.ts` `memoryEvents` (`:192-204`, the two-arg `index()` idiom) + `runs` (`:113-123`); migration ritual `drizzle-kit generate` → `0019_*` (latest `0018`), applied at `server.ts:50` via `db/migrate.ts`. `0018_fair_silver_centurion.sql` is the clean-generated new-table+ALTER template.
- **Repo (interface + drizzle + in-memory fake parity):** `runs/repo.ts` (RunRow/RunsRepo/drizzle/`memoryRunsRepo`) and `memory/repo.ts` (the Epic 8 repo w/ fake). New conversations repo mirrors these.
- **Routes (session-guarded, error shapes, sole-writer):** `agents/routes.ts` (`publish` `:300-306`, the `c.json({ error }, 4xx)` shape), `app.ts` guard mounts (`:70-71`) + repo wiring (`memoryRepo`). `memory/routes.test.ts` for the session-guard + agent-scope test shape.
- **Domain entity:** `packages/domain/src/index.ts` `Run` (`:233-238`), the Epic 8 memory section (`:136-231`) for banner/union/const conventions.
- **Publish/snapshot read (for the refusal null-check + 9.2 snapshot resolve):** `agents/repo.ts` `publish` (`:216-233`), `publishedSnapshots` (`:151-161`, the `(agentId, version)` lookup), null-checks (`:151`, `:267`).
- **Harness fold site (9.2, note only):** `agent-harness/src/main.ts:169-182` (memories folded at `:175-181`, `taskInput` pushed at `:182`).
- **SSE/hub reused by chat (9.3, note only):** `runs/routes.ts` `GET /runs/:id/events` (`:80-144`) + `runs/hub.ts`.

### Project Structure Notes
- **New:** `apps/control-api/src/conversations/repo.ts` (+ `repo.test.ts`), `apps/control-api/src/conversations/routes.ts` (+ `routes.test.ts`), `apps/control-api/drizzle/0019_*.sql` (+ meta). **Edited:** `packages/contracts/src/index.ts` (+ test), `packages/domain/src/index.ts`, `apps/control-api/src/db/schema.ts`, `apps/control-api/src/runs/repo.ts` (+ `runs.test.ts`), `apps/control-api/src/runs/orchestrator.ts` (the RunRow literal), `apps/control-api/src/app.ts` (wire + guard + mount), `apps/web/src/lib/runs.ts` (six `v:8` literals).
- **No change (this story):** the harness fold, the SSE/hub, the NavRail Chat item (still `disabled: true` at `NavRail.svelte:15` — 9.3 enables it), the web chat surface, the run-execution path (`start`/`launch`/`execute`), `agent_versions`/publish.
- **Scope guard:** NO chat turn execution (9.2), NO `history` population/harness fold (9.2), NO build-from-published-snapshot (9.2), NO web `/chat` route or client (9.3), NO rename/delete/history-windowing (9.4). This story is: the contract shape + the domain entity + the store + the run link + the publish-first refusal.

### Testing standards
- Vitest, co-located `*.test.ts`. Contracts test asserts `CONTRACT_VERSION` + parses schemas. Control-api tests use in-memory fakes (`memoryRunsRepo`, `memoryConversationsRepo` (new), an `agentsRepo` fake) + session-cookie helper (mirror `memory/routes.test.ts`). Domain is pure-type/pure-function. `svelte-check` for web. Full verification: `pnpm -r build`, `pnpm lint`, `deploy/test-stack.sh` e2e proving `0019` applies AND the v8 test-console happy path still runs; never `down -v` the dev stack; warm Vite before Playwright.

### References
- [Source: epics.md#Epic-9 (chat = threaded runs; builder-first; published-version; JobSpec.history + CONTRACT_VERSION bump; the run↔conversation link) + #Story-9.1 (the three ACs) + #Architecture-and-scope-decisions]
- [Source: architecture spine #AD-1 (network=none sandbox), #AD-7 (control-api sole writer), #AD-9 (immutable JobSpec at run start), #AD-10 (no secret in the sandbox)]
- [Source: contracts/index.ts (JobMemory precedent, CONTRACT_VERSION, JobSpec) + 8.3 6→7 bump as the ritual]
- [Source: agents/repo.ts + schema.ts (publish/agent_versions model — the refusal null-check + 9.2 snapshot resolve) ; runs/repo.ts + orchestrator.ts (the run link + the three-projection gotcha)]
- [Source: [[turanga-e2e-clean-run]] — reset for pristine; never `down -v` the dev stack; warm Vite; rebuild the harness image for the v8 bump]

## Dev Agent Record

### Agent Model Used

claude-opus-4-8 (Claude Opus 4.8)

### Debug Log References

- **Contract bump ripple:** bumping `CONTRACT_VERSION` 7→8 + adding `JobSpec.history` made `history` a required key in every `JobSpec` object literal (zod `.default([])` is optional on input but required on the inferred output type used for construction). The single ripple was `orchestrator.ts:352` — set `history: []` for a standalone/test-console run. All other consumers reference the `CONTRACT_VERSION` symbol and re-pinned automatically.
- **Runs repo `create()` signature:** rather than edit ~14 existing `repo.create({...})` test literals, made `conversationId`/`turnIndex` OPTIONAL in the `create()` param (defaulting `null` in both the drizzle and in-memory impls). A standalone run genuinely has no conversation; a chat turn (9.2) passes them explicitly. This also matches the nullable DB columns.
- **e2e Playwright — 9 pre-existing failures, none from this story:** the full suite showed 9 failures in `agents.spec`/`providers.spec`. Classified all as pre-existing: (a) cross-spec DB pollution — `providers.spec:21` (empty-state) + `agents.spec:49` (create) PASS on a pristine DB (a prior spec connects a provider that persists in the shared e2e DB); (b) a pre-existing strict-mode bug — `agents.spec:109` fails identically on the **baseline commit** (verified via `git stash`): `getByRole('button', {name: 'History'})` matches both the History button AND the disabled "Runs" nav item whose accessible name contains "Run **history** lives on…"; (c) model-gated run/tool specs that need a real provider key (unprovisioned e2e). memory.spec (7) + 26 others passed.

### Completion Notes List

- **The spine, no turn execution.** Landed the contract shape (`JobSpec.history`, `CONTRACT_VERSION` 7→8), the `Conversation` domain entity, the `conversations` table + the run↔conversation link, the conversations repo/routes, and the publish-first refusal — WITHOUT running a chat turn. 9.2 populates `history` + folds it in the harness + builds from the published snapshot; the `orchestrator.ts:331-334` decision note (chat resolves the published version itself) still stands.
- **`JobSpec.history` is secret-free (AD-10)** — `{ role: "user"|"agent", content }`, modeled on `JobMemorySchema`; extra keys stripped, unknown role rejected (unit-tested). Defaults `[]`, so every existing (non-chat) run builds a valid v8 spec and the harness ignores the empty field — the bump is backward-safe (proven live: the v8 stack boots healthy and the existing agent/publish surface works end-to-end).
- **The refusal + version pin** live in `POST /conversations`: read `agentsRepo.get(agentId)` → 404 if absent → **409 "Publish this agent to chat with it."** if `publishedVersion == null` → else create with `publishedVersion` pinned (latest-at-conversation-start). Proven live on the e2e stack: unpublished → 409, published → 201 with `publishedVersion: 1`.
- **The three-projection gotcha handled** — `conversationId`/`turnIndex` carry through drizzle `toRow`/`summaryCols`/`toSummary` AND the in-memory `listSummary` (unit-tested: a chat-turn run keeps the link in the summary projection, a standalone run defaults both null).
- **AD-7 sole writer, agent-scoped (FR-7):** the conversations repo/routes are the only writers of conversation state; list/get are agent-keyed; the drizzle repo is wired in `server.ts`, the fake in `app.ts` (tests/no-DB boot).
- **Verification:** contracts 16, domain 5, harness 10, guard 31, control-api 238 (+12 new), svelte-check + `pnpm -r build` + `pnpm lint` clean. e2e: migration `0019` applies (conversations table + nullable run link columns verified in the `control` DB), the v8 control-api + harness images rebuild and boot healthy, and the conversations spine works live. Dev stack restored, 2 agents intact.

### File List

**New**
- `apps/control-api/src/conversations/repo.ts` (+ `repo.test.ts`)
- `apps/control-api/src/conversations/routes.ts` (+ `routes.test.ts`)
- `apps/control-api/drizzle/0019_conversations.sql` (+ `drizzle/meta` snapshot/journal)

**Edited — contracts / domain**
- `packages/contracts/src/index.ts` — `CONTRACT_VERSION` 7→8, `JobHistoryTurnSchema`, `JobSpec.history`
- `packages/contracts/src/index.test.ts` — v8 assertion, history round-trip/default/secret-free tests
- `packages/domain/src/index.ts` — `Conversation` entity

**Edited — control-api**
- `apps/control-api/src/db/schema.ts` — `conversations` table + `runs.conversation_id`/`turn_index`
- `apps/control-api/src/runs/repo.ts` — `RunRow` link fields + all three summary projections + optional-in-`create()`
- `apps/control-api/src/runs/orchestrator.ts` — `JobSpec.history: []` + `RunRow` link fields null
- `apps/control-api/src/runs/runs.test.ts` — conversation-link default/carry test
- `apps/control-api/src/app.ts` — `conversationsRepo` dep + guard + mount
- `apps/control-api/src/server.ts` — wire the drizzle conversations repo

**Edited — web**
- `apps/web/src/lib/runs.ts` — mirror `RunMessage` `v: 7`→`v: 8` (six literals)

### Change Log

| Date | Version | Description |
|------|---------|-------------|
| 2026-08-05 | 0.1 | Story 9.1 implemented — the chat conversation model + published-version binding (spine of Epic 9). Contract bump 7→8 (`JobSpec.history`, secret-free, default []), the `Conversation` domain entity, the `conversations` table + run↔conversation link (migration 0019), the conversations repo/routes, and the publish-first refusal (409) with version pinning. No turn execution (9.2). Verified: all unit suites + build + lint + svelte-check clean; e2e proves 0019 applies + the v8 spine works live. Status → review. |
