---
baseline_commit: 61b7458e37dc730eb34440269f5efb373b558268
---
# Story 8.3: Recall — inject relevant memories into a run

Status: review

<!-- THIRD story of Epic 8 (Agent memory — the self-improving loop). 8.1 modeled memory + the pgvector
     store + the resolver; 8.2 made it configurable (global + per-agent, off by default). This is the
     FIRST behavior story: before a run's JobSpec is built, the orchestrator embeds the task input,
     runs a scoped pgvector similarity query over the agent's memories, and injects the top-k into a NEW
     sandbox-visible `JobSpec.memories` field (CONTRACT_VERSION 6→7); the harness folds them into the
     model's system context. Recall is embedding-only (zero LLM cost, off the cost cap), gated by
     `effectiveMemoryConfig(...).recall`, agent-scoped (FR-7), fail-OPEN (a recall failure never blocks a
     run), and records which memories it recalled (auditable causality). REFLECT (the write half, 8.4)
     produces the embedded memories this recalls; 8.3 is tested by seeding an embedded memory. -->

## Story

As the builder,
I want a memory-enabled agent to start each run with what it has learned that's relevant to the task,
so that it doesn't repeat past mistakes or re-derive what it already knows.

## Acceptance Criteria

1. **Given** a memory-enabled agent with **recall on**, **when** a run is launched, **then** the orchestrator (control-plane, **before** building the JobSpec) embeds the task input via LiteLLM `/embeddings`, runs a **scoped similarity query** over that agent's memories (agent-scoped — FR-7; filtered by temporal validity + the agent's enabled kinds; non-null embedding only), and injects the top-k as a **sandbox-visible `JobSpec.memories`** field — secret-free text (`id`, `kind`, `summary`), immutable at run start (AD-9/AD-10). This is a `CONTRACT_VERSION` **6→7** bump. [Source: epics.md#Story-8.3 AC1, AD-9, AD-10, FR-7]

2. **Given** the harness, **when** it assembles the model context, **then** it folds the recalled memories into the **system context** (a `role: "system"` block, mirroring the instructions/tool-outcome fold), and the run **records which memories it recalled** — a `recall` transcript event with the memory ids (auditable causality) plus a per-memory `useCount`/`lastUsedAt` bump. [Source: epics.md#Story-8.3 AC2, NFR-4]

3. **Given** recall, **when** it runs, **then** it is **embedding-similarity only** — the embed call uses the control-plane master key (the per-run cost key isn't even minted yet), so recall is **never charged to the run's cost cap**; and recall is **gated + fail-open**: it fires only when `effectiveMemoryConfig(global, agent).recall` is true (off ⇒ `memories: []`), and any embed/query failure degrades to `memories: []` — a run is **never blocked** because recall failed. [Source: epics.md#Story-8.3 AC3, Epic-8 "observed, not metered", AD-1]

## Tasks / Subtasks

- [x] **Task 1: Contracts — `JobSpec.memories` + the `recall` transcript event + `CONTRACT_VERSION` 6→7** (AC: #1, #2)
  - [x] `packages/contracts/src/index.ts` — bump `CONTRACT_VERSION` `6 as const` → `7 as const` (line 14) and add a changelog comment line in the block at :6-13 (mirror the v5→v6 idiom): `// v7 (Story 8.3): sandbox-visible JobSpec.memories folded into system context; a recall transcript event. Recall is embedding-only.`
  - [x] Add a top-level `JobMemorySchema` (mirror `JobToolSchema` at :26-31) — **secret-free** fields only: `z.object({ id: z.string(), kind: z.enum(["episodic","semantic","procedure"]), summary: z.string() })` + `export type JobMemory = z.infer<...>`. **Never** put a credential/endpoint in it (AD-10) — `summary` is distilled text, like instructions.
  - [x] Add `memories: z.array(JobMemorySchema).default([])` to `JobSpecSchema` (:34-50), next to `tools`/`connections`. The `.default([])` keeps older/omitting construction valid (the stated idiom at :41-45) and gives the harness `spec.memories` typed automatically.
  - [x] Add a `recall` variant to `ControlChannelMessageSchema` (:53-77, the discriminated union): `z.object({ type: z.literal("recall"), v: z.literal(CONTRACT_VERSION), memoryIds: z.array(z.string()), count: z.number() })`. This is an **orchestrator-authored transcript event** (not a harness/guard stream message) — it records what recall injected. **NOTE:** the version bump re-pins `v: z.literal(CONTRACT_VERSION)` on EVERY schema in this file (JobSpec, ControlChannelMessage, GuardModelRequest/Response, Guard*, ToolCall*, GuardRunEvent) — intentional, in lockstep (exactly how 6.5 did 5→6). Every service must rebuild to speak v7.

- [x] **Task 2: The embeddings client — `ModelGateway.embed(text)`** (AC: #1, #3)
  - [x] `apps/control-api/src/litellm/gateway.ts` — add `embed(text: string, model?: string): Promise<number[]>` to the `ModelGateway` interface (:23-34).
  - [x] `httpModelGateway` (:44-179) — implement `embed`: POST `${litellmBaseUrl}/embeddings` with the existing `llmHeaders` (`authorization: Bearer <masterKey>`, `content-type: application/json`, :45) and body `{ model: model ?? "text-embedding-3-small", input: text }`; parse `json.data[0].embedding` as `number[]`. Uses the **master key** (control-plane, unmetered) — NOT a per-run cost key (recall runs before `execute()` mints one). Throw on a non-ok response / malformed body (the orchestrator catches → fail-open, see Task 4).
  - [x] `fakeModelGateway` (:190-236) — add a **deterministic** `async embed(text)` returning a fixed-length `number[]` of 1536 (e.g. a hash-of-text-seeded vector, or a constant vector so every memory is equidistant — enough to test the plumbing). `fakeCatalog` (:185) already lists `text-embedding-3-small`. Optionally record embed calls (like `mintedKeys` at :191-194) for assertions.
  - [x] No `server.ts`/`app.ts` construction change — `embed` rides on the already-injected `modelGateway` (server.ts :59-61/91, app.ts :78/100).

- [x] **Task 3: Memory repo — `recall(...)` + `markRecalled(...)` + the pgvector index** (AC: #1, #2)
  - [x] `apps/control-api/src/memory/repo.ts` — imports (:1) gain `cosineDistance` (verified exported by drizzle-orm 0.45.2) + `isNull, isNotNull, or, gt` from `drizzle-orm`.
  - [x] Add to the `MemoryRepo` interface (:35-49):
    - `recall(agentId: string, queryEmbedding: number[], k: number, opts?: { kinds?: MemoryKind[] }): Promise<MemoryRow[]>` — agent-scoped nearest-neighbor.
    - `markRecalled(agentId: string, ids: string[]): Promise<void>` — bump usage counters on the recalled rows.
  - [x] `drizzleMemoryRepo` `recall`: `db.select().from(agentMemories).where(and( eq(agentMemories.agentId, agentId), isNotNull(agentMemories.embedding), or(isNull(agentMemories.validUntil), gt(agentMemories.validUntil, new Date())), <kinds filter via inArray when opts.kinds set> )).orderBy(cosineDistance(agentMemories.embedding, queryEmbedding)).limit(k)`. Map with the existing `toRow` (:51-68). (Cosine to match the HNSW index below; smaller distance = more similar. If the `cosineDistance` helper's vector cast is finicky, fall back to a raw `sql\`${agentMemories.embedding} <=> ${vecLiteral}::vector\`` order — the same raw-`sql` idiom `runs/repo.ts` uses.)
  - [x] `drizzleMemoryRepo` `markRecalled`: `db.update(agentMemories).set({ useCount: sql\`use_count + 1\`, lastUsedAt: new Date() }).where(and(eq(agentMemories.agentId, agentId), inArray(agentMemories.id, ids)))` (guard `ids.length === 0` → no-op).
  - [x] `memoryMemoryRepo` (:155-189) — a fake `recall` (filter the in-memory rows by agentId + non-null embedding + validity + kinds, sort by JS cosine distance to `queryEmbedding`, take `k`) and a fake `markRecalled` (bump the map rows). **Agent-scoped** — never returns another agent's rows (FR-7).
  - [x] **The HNSW index migration** (`0016_*.sql`, 8.1 deferred it to here): prefer expressing it in `db/schema.ts` `agentMemories` index array (:165) via drizzle's `index("agent_memories_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops"))`, run `drizzle-kit generate`, and **verify the emitted `0016` contains `USING hnsw ("embedding" vector_cosine_ops)`**; if drizzle-kit doesn't emit the opclass cleanly, **hand-write** `0016` (like the hand-added `CREATE EXTENSION` in `0015`): `CREATE INDEX "agent_memories_embedding_idx" ON "agent_memories" USING hnsw ("embedding" vector_cosine_ops);`. Applied on boot by `db/migrate.ts`. (The index is a pure perf add — recall works via seq-scan without it on the spine's tiny data; it must match the cosine op used by `recall`.)

- [x] **Task 4: Orchestrator — the recall step (gate → embed → query → inject → record), fail-open** (AC: #1, #2, #3)
  - [x] `apps/control-api/src/runs/orchestrator.ts` — add `memoryRepo` to the deps destructure at :94 (declared in `OrchestratorDeps` :75 but not yet destructured).
  - [x] Add a private `resolveRecall(agent, taskInput): Promise<{ memories: JobMemory[]; recalledIds: string[] }>` helper (mirror `resolveRunConnections` :109-136 / `resolveRunTools` :145-173), wrapped in try/catch that returns `{ memories: [], recalledIds: [] }` on ANY failure (**fail-open** — AC3):
    - If `!memoryRepo` or `!modelGateway` → return empty.
    - Resolve the effective config: `const eff = effectiveMemoryConfig(await memoryRepo.getGlobalConfig(), await memoryRepo.getAgentMemoryConfig(agent.id))`. If `!eff.recall` → return empty (the gate; killSwitch/off/inherit-off all resolve here — no `AgentLike` change needed, memory config comes from the memory repo).
    - `const embedding = await modelGateway.embed(taskInput)`.
    - `const rows = await memoryRepo.recall(agent.id, embedding, TOP_K, { kinds: eff.kinds })` (a module const `TOP_K = 5`).
    - Map → `memories: JobMemory[]` = `rows.map(r => ({ id: r.id, kind: r.kind, summary: r.summary || r.content }))` (secret-free; prefer summary, fall back to content).
    - Return `{ memories, recalledIds: rows.map(r => r.id) }`.
  - [x] Call it at ~:205 (with the other `resolve*` calls, before the spec) and spread `memories` into the JobSpec literal at :209.
  - [x] **Record causality** (best-effort, never blocks): when `recalledIds.length > 0`, push a `recall` control-channel event `{ type: "recall", v: CONTRACT_VERSION, memoryIds: recalledIds, count: recalledIds.length }` into `row.transcript` BEFORE `runsRepo.create(row)` (:210-211), and fire-and-forget `void memoryRepo.markRecalled(agent.id, recalledIds)` (bump usage). A `markRecalled` failure must not affect the run.
  - [x] **Cost posture (AC3):** recall runs entirely before the cost-key mint in `execute()` (:236-243) and uses the master key — so it never touches the per-run key or the cost cap. Add a one-line comment making that explicit.

- [x] **Task 5: Harness — fold `spec.memories` into the system context** (AC: #2)
  - [x] `apps/agent-harness/src/main.ts` — in `runHarness()` (:169-171), between the instructions push (:170) and the user-task push (:171), fold the recalled memories into a `role: "system"` message when `spec.memories.length > 0`: a labeled block, e.g. `Relevant things you've learned from past runs:\n` + `spec.memories.map(m => \`- (${m.kind}) ${m.summary}\`).join("\n")`. Mirrors the instructions fold + the `outcome.system` fold (:187). `readJobSpec` (:27-29) already `JobSpecSchema.parse`s, so `spec.memories` is typed + defaulted; a v6-style spec (no memories) yields `[]` → nothing folded.

- [x] **Task 6: Tests + verification** (AC: all)
  - [x] **contracts unit** — a `JobSpec` with `memories` round-trips through `JobSpecSchema`; a spec omitting `memories` parses to `[]` (the `.default`); `CONTRACT_VERSION === 7`; the `recall` control message parses. (Mirror the existing contracts tests if present; else a small vitest.)
  - [x] **gateway unit** (`litellm/gateway.test.ts`) — `httpModelGateway.embed` POSTs to `/embeddings` with the master-key header + `{ model, input }` and returns `data[0].embedding` (fetch mocked); `fakeModelGateway.embed` returns a 1536-length vector deterministically.
  - [x] **memory repo unit** (`memory/repo.test.ts`) — seed embedded memories for agent A + B; `recall(A, vec, k)` returns ONLY A's rows (FR-7), respects `k`, excludes null-embedding + expired (`validUntil` in the past) rows, and filters by `opts.kinds`; `markRecalled` bumps `useCount`/`lastUsedAt` only for the given agent's given ids.
  - [x] **orchestrator unit** (`runs/runs.test.ts`) — with `fakeModelGateway` + a `memoryMemoryRepo` seeded with an embedded memory for a **recall-on** agent (set via `setAgentMemoryConfig` + a global `defaultEnabled`/`mode:"on"`): launching a run builds a JobSpec whose `memories` contains the seeded memory, the transcript gains a `recall` event with its id, and `markRecalled` bumped its `useCount`. With recall **off** (default inherit + global off) ⇒ `memories: []`, no `recall` event. With `modelGateway.embed` throwing ⇒ **fail-open**: the run still launches with `memories: []` (assert no throw). Recall never mints/charges the cost key.
  - [x] **harness** — if `apps/agent-harness` has a test, assert `spec.memories` produces a `role:"system"` message in the assembled `messages`; otherwise the contract + orchestrator tests cover the wire and this is a code-review check.
  - [x] `pnpm -r build` (8 workspaces) · `pnpm lint` · `svelte-check` · all unit suites green · **e2e via `deploy/test-stack.sh`** — **REBUILD ALL IMAGES** (a `CONTRACT_VERSION` bump means every service — harness, guard, control-api — must speak v7; `test-stack.sh up` rebuilds). Prove: the existing run specs still pass (a v7 run round-trips end-to-end), and pgvector index migration `0016` applies on a fresh DB. **Never `down -v` the dev stack**; `pnpm -r build` before any Docker build; restore + verify dev data after. See [[turanga-e2e-clean-run]] (reset for pristine; wait for LiteLLM key-readiness; warm Vite).

## Dev Notes

**The FIRST behavior story of Epic 8 — recall (the read half of the loop).** 8.1 modeled memory + the pgvector store + `effectiveMemoryConfig`; 8.2 made it configurable (off by default). This injects what an agent has learned into its next run: embed the task → scoped similarity query → `JobSpec.memories` (immutable, secret-free) → harness folds it into the model's system context. **Reflect (8.4) writes the embedded memories this recalls** — so 8.3's own tests SEED an embedded memory (the repo `createMemory` takes an `embedding`); the full fail→learn→succeed demo lands when 8.4 ships.

### What already exists (do NOT rebuild)
- **Store + config (8.1/8.2):** `agent_memories` (`embedding vector(1536)` **nullable**, `validFrom`/`validUntil`, `salience`, `useCount`/`lastUsedAt`, `kind`, `summary`/`content`, `agentId` — `db/schema.ts:147-166`); `memory_settings`; `agents.memory_config`. The `MemoryRepo` (`memory/repo.ts`) has agent-scoped CRUD + `getGlobalConfig`/`getAgentMemoryConfig`. `effectiveMemoryConfig(global, perAgent)` (`packages/domain` :195-207) → `{ enabled, recall, reflect, kinds }` — **the gate**; `killSwitch`/off/inherit-off all resolve `recall:false`.
- **Orchestrator wiring:** `memoryRepo?` is already a dep (`orchestrator.ts:75`) — just not destructured (:94) or used. `modelGateway` is injected + available (server.ts, app.ts). The JobSpec is built at `orchestrator.ts:209` after the `resolve*` helpers (:203-205); the run row is created at :210-211.
- **Contracts:** zod schemas; `CONTRACT_VERSION = 6` (:14); `JobSpecSchema` (:34-50); `JobToolSchema` (:26-31) is the shape template; every schema pins `v: z.literal(CONTRACT_VERSION)`.

### The recall step (the design, binding)
- **Control-plane only, before the spec (AD-1/AD-9).** Embed + query + inject happen in the orchestrator; the sandbox never touches memory or the DB. The injected `memories` are immutable spec content (AD-9) — the sandbox can't fetch more or mutate them.
- **Secret-free (AD-10).** `JobMemory` is `{ id, kind, summary }` — distilled text, never a credential/endpoint. Memory content is secret-free by construction (8.4 distills run outcomes).
- **Gated (8.2) + fail-OPEN (the key robustness rule).** Recall fires only when `effectiveMemoryConfig(...).recall`. Any failure — no memoryRepo, embed error, query error — degrades to `memories: []`. **A run must NEVER fail because recall failed**; recall is strictly additive. (Contrast the cost-key mint, which DOES fail-closed — recall is different: it's an enhancement, not a guardrail.)
- **Zero LLM cost / off the cap (AC3, "observed not metered").** The embed uses the control-plane **master key**, and runs *before* `execute()` mints the per-run cost key (:236-243) — so it structurally cannot touch the cost cap or trip kill-on-breach. Embedding similarity itself is a DB op (no LLM).
- **Agent-scoped (FR-7).** `recall(agentId, ...)` filters by `agentId`; there is no cross-agent query. Same posture as every other `MemoryRepo` method.
- **Auditable causality (AC2/NFR-4).** A `recall` transcript event records the injected `memoryIds`; `markRecalled` bumps `useCount`/`lastUsedAt`. (The reverse link — a memory's `sourceRunId` — is set at WRITE time in 8.4, not here.) 8.5 renders this "learned → recalled" chain; 8.3 just records it.

### The chicken-and-egg (recall vs reflect) — how 8.3 is testable now
Memories get their `embedding` at **write** time (8.4 reflect embeds `content` before storing). Nothing writes memories until 8.4, so 8.3 is exercised by **seeding** an embedded memory directly via `memoryRepo.createMemory({ ..., embedding })` in tests (the fake gateway's deterministic `embed` produces both the seed and the query vector, so they match). This is expected: 8.3 delivers recall, 8.4 delivers reflect, and 8.3+8.4 together close the visible loop. Do NOT add embedding-on-write here (that's 8.4).

### Similarity query specifics (verified)
- **`drizzle-orm@0.45.2` exports `cosineDistance(column, value: number[])`** (`drizzle-orm/sql/functions/vector` — confirmed importable from `drizzle-orm`). Use it in `.orderBy(...)` for nearest-neighbor; smaller = more similar. Filters via `isNotNull`/`isNull`/`or`/`gt`/`inArray` helpers (all in `drizzle-orm`). Raw `sql\`... <=> ...::vector\`` is the fallback if the helper's cast misbehaves.
- **HNSW + `vector_cosine_ops`** to match the cosine order (8.1 deferred the index to here). drizzle-kit won't emit the opclass from the DSL cleanly → verify the generated `0016`, hand-edit like `0015`'s `CREATE EXTENSION`. Index is perf-only; recall is correct without it.
- **`text-embedding-3-small` = 1536 dims** — matches the fixed column. The embed model is `memory_settings.embeddingModel` (8.2, read-only) — pass it through, defaulting to the constant.

### Existing patterns to mirror (file:line)
- **Contracts field + version bump:** `packages/contracts/src/index.ts` — `JobToolSchema` (:26-31) for `JobMemorySchema`; `JobSpec` `tools`/`connections` `.default([])` (:43-46) for `memories`; the changelog-comment + `CONTRACT_VERSION` bump idiom (:6-14), as in the 5→6 (Story 6.5) commit.
- **Resolve-before-spec helpers:** `orchestrator.ts` `resolveRunConnections` (:109-136) / `resolveRunTools` (:145-173) → `resolveRecall`; the JobSpec literal (:209); the run-row create (:210-211).
- **Gateway method + fake:** `litellm/gateway.ts` `ModelGateway` (:23-34), `httpModelGateway` fetch idiom (`llmHeaders` :45, a POST call :77-89), `fakeModelGateway` (:190-236, `fakeCatalog` :185).
- **Repo query idiom:** `memory/repo.ts` `listForAgent`/`getMemory`/`deleteMemory` (`and`/`eq`, :82-113); `runs/repo.ts` raw `sql\`\`` usage for the fallback.
- **Harness system fold:** `agent-harness/src/main.ts` instructions push (:170) + `outcome.system` fold (:187); `readJobSpec` (:27-29).
- **Transcript event precedent:** Story 6.5 recorded tool observability as transcript-derived (no new column) — the `recall` event follows that.

### Project Structure Notes
- **Edited:** `packages/contracts/src/index.ts` (version, `JobMemorySchema`, `JobSpec.memories`, `recall` msg), `apps/control-api/src/litellm/gateway.ts` (`embed`), `apps/control-api/src/memory/repo.ts` (`recall`/`markRecalled` + fakes), `apps/control-api/src/db/schema.ts` (hnsw index), `apps/control-api/src/runs/orchestrator.ts` (recall step), `apps/agent-harness/src/main.ts` (fold). **New:** `apps/control-api/drizzle/0016_*.sql` (+ meta). Tests: `contracts` (add if none), `litellm/gateway.test.ts`, `memory/repo.test.ts`, `runs/runs.test.ts`.
- **No change:** `server.ts`/`app.ts` wiring (modelGateway + memoryRepo already injected); the web (recall is invisible until 8.5's observability — a `recall` transcript entry is recorded but not yet rendered; ensure the existing transcript renderer **tolerates** an unknown `type` without crashing — verify, since v7 adds the variant).
- **Scope guard:** NO reflection/write (8.4 — the embedding-on-write + consolidation), NO memory curation/observability UI (8.5), NO learning changelog / staged approval (8.6), NO salience-weighted ranking beyond distance + validity (a noted refinement), NO recall token-budget tuning beyond `TOP_K` (noted). This story is recall injection + the wire + causality recording only.

### Testing standards
- Vitest: contracts (version + `memories` round-trip + `.default`), gateway `embed` (http mock + fake determinism), memory `recall`/`markRecalled` (agent-scoping FR-7 + validity/kind filters + k), orchestrator recall (gate on/off, fake embed → `JobSpec.memories` + `recall` transcript event + `markRecalled` bump, **fail-open on embed throw**, cost-key untouched). A `fakeModelGateway.embed` is the injectable double (no separate `fakeEmbedder` needed). e2e via `deploy/test-stack.sh` with **ALL images rebuilt** (contract-version bump) — a v7 run round-trips + `0016` applies; never `down -v` the dev stack.

### References
- [Source: epics.md#Epic-8 (Architecture & scope decisions: control-plane recall into the immutable spec, secret-free, observed-not-metered, auditable causality) + #Story-8.3]
- [Source: 8-1/8-2 stories — the store, `effectiveMemoryConfig` gate, the published/operational split, the `memoryRepo` threading]
- [Source: architecture spine #AD-1 (sandbox has no DB edge), #AD-9 (immutable spec), #AD-10 (no secret in sandbox), #FR-7 (agent-scoped); Epic-4 CONTRACT_VERSION lockstep precedent (6.5)]
- [Source: the design plan `~/.claude/plans/toasty-wishing-papert.md` — the three-seam recall architecture]
- [Source: [[turanga-e2e-clean-run]] — REBUILD ALL images on a contract bump; reset for pristine; never `down -v` the dev stack; warm Vite; LiteLLM key-readiness]

## Dev Agent Record

### Agent Model Used

claude-opus-4-8[1m] (Claude Code)

### Debug Log References

- **CONTRACT_VERSION 6→7 ripple (the expected sweep):** every schema re-pins `v: z.literal(7)`, so all hard-coded `v: 6` test/type literals broke the build. Fixed by importing `CONTRACT_VERSION` and replacing the literals in `runs.test.ts`, `hub.test.ts`, `app.test.ts`, `egress-guard/guard.test.ts`, and the web's local mirror `apps/web/src/lib/runs.ts` (bumped the union to `v: 7` + added the `recall` variant). Service SOURCE (harness/guard) already used `CONTRACT_VERSION`, so it moved automatically.
- **HNSW index — no hand-edit needed:** unlike `0015`'s `CREATE EXTENSION`, drizzle-kit 0.31.10 DID emit the opclass correctly from `index(...).using("hnsw", t.embedding.op("vector_cosine_ops"))` → `0016_glamorous_dust.sql` = `CREATE INDEX ... USING hnsw ("embedding" vector_cosine_ops)`. Verified applied on a fresh DB via psql.
- **Web transcript renderer tolerates the new `recall` variant:** `RunTranscript.svelte` uses `{:else if}` chains with no catch-all `{:else}`, so an unhandled `recall` message renders nothing (no crash). 8.5 adds proper rendering.

### Completion Notes List

- **The FIRST behavior story of Epic 8 — recall (the read half).** Before the JobSpec is built, the orchestrator embeds the task input → agent-scoped pgvector nearest-neighbor over the agent's memories → injects the top-k into the new `JobSpec.memories` (secret-free `{id, kind, summary}`) → the harness folds them into the model's system context. `CONTRACT_VERSION` 6→7.
- **Fail-OPEN, gated, off-the-cap (the three safety properties, all tested):** recall fires only when `effectiveMemoryConfig(...).recall`; any failure (no repo, embed throw, query error) degrades to `memories: []` and the run **still launches** (unit-tested with `embedThrows`); the embed uses the master key and runs *before* the per-run cost key is minted, so it structurally can't touch the cost cap.
- **Auditable causality:** a `recall` transcript event records the injected `memoryIds` (orchestrator-authored, pushed onto the row at creation), and `markRecalled` (fire-and-forget) bumps `useCount`/`lastUsedAt` — both agent-scoped (FR-7).
- **The chicken-and-egg is real + handled:** memories get embeddings at *write* time (8.4 reflect). 8.3 recalls against **seeded** embedded memories; the deterministic `fakeEmbed(text)` produces both the seed and the query vector, so an exact-text match ranks first. The full fail→learn→succeed demo lands with 8.4.
- **Verification:** `pnpm -r build` (8 workspaces) ✓, `pnpm lint` ✓, `svelte-check` 0 errors ✓, all unit suites green — contracts 15, domain 4, harness 10, egress-guard 31, web 22, control-api **189** (11 new: 3 gateway-embed + 4 memory-recall + 4 orchestrator-recall). **e2e via `deploy/test-stack.sh` with ALL images rebuilt (contract bump):** the `0016` HNSW index applies on a fresh DB; all services boot healthy on v7; a **real run round-trips end-to-end with all-v7 transcript messages** (`versions: [7]` — no version-mismatch crash), and with recall on + an empty store the run completes normally (fail-open confirmed in the real stack); the config e2e (`memory.spec.ts`) passes against v7. Dev stack restored, data intact.
- **Operator note:** the dev stack was restored with `docker compose up -d` (no `--build`), so it's still on the pre-bump image — dev data intact, untouched; `0016` + v7 apply on the next dev rebuild.
- **Scope kept:** no reflection/write (8.4), no curation/observability UI (8.5), no salience-weighted ranking beyond distance+validity, no token-budget beyond `RECALL_TOP_K=5`.

### File List

- **Edited** `packages/contracts/src/index.ts` — `CONTRACT_VERSION` 6→7 + changelog; `JobMemorySchema`/`JobMemory`; `JobSpec.memories`; the `recall` control-channel variant.
- **Edited** `packages/contracts/src/index.test.ts` — version 7, memories round-trip + `.default`, `JobMemory` secret-free, `recall` event.
- **Edited** `apps/control-api/src/litellm/gateway.ts` — `ModelGateway.embed` + `DEFAULT_EMBEDDING_MODEL` + http impl; exported `fakeEmbed`; `fakeModelGateway.embed` (+ `embedded`/`embedThrows`).
- **Edited** `apps/control-api/src/litellm/gateway.test.ts` — embed http + fake determinism tests.
- **Edited** `apps/control-api/src/memory/repo.ts` — `recall`/`markRecalled` (drizzle `cosineDistance` + fakes; JS `cosineDist` helper).
- **Edited** `apps/control-api/src/memory/repo.test.ts` — recall (nearest-first, FR-7, validity/kinds/k) + markRecalled tests.
- **Edited** `apps/control-api/src/db/schema.ts` — HNSW cosine index on `agent_memories.embedding`.
- **New** `apps/control-api/drizzle/0016_glamorous_dust.sql` (+ meta) — the HNSW index migration.
- **Edited** `apps/control-api/src/runs/orchestrator.ts` — `resolveRecall` (gate→embed→query→map, fail-open) + spec `memories` + the `recall` transcript event + `markRecalled`.
- **Edited** `apps/control-api/src/runs/runs.test.ts` + `hub.test.ts` + `app.test.ts` — version-sync + orchestrator recall tests.
- **Edited** `apps/agent-harness/src/main.ts` — fold `spec.memories` into the system context.
- **Edited** `apps/agent-harness/src/main.test.ts` — `readJobSpec` memories tests.
- **Edited** `apps/egress-guard/src/guard.test.ts` — version-sync.
- **Edited** `apps/web/src/lib/runs.ts` — `RunMessage` union → v7 + the `recall` variant.

### Change Log

| Date | Version | Description |
|------|---------|-------------|
| 2026-08-05 | 0.1 | Story 8.3 implemented — recall injects agent memories into the immutable JobSpec (CONTRACT_VERSION 6→7); embedding-only, gated, fail-open, auditable. Status → review. |
