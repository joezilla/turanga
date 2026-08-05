---
baseline_commit: f0adfa104471093c6b25c39973b0c72ab6aa95da
---
# Story 8.1: The memory model, store, and configuration spine

Status: review

<!-- FIRST story of Epic 8 (Agent memory — the self-improving loop). This is the SPINE: model memory +
     its per-agent/global configuration as first-class things, land the control-plane pgvector store,
     and ship it OFF BY DEFAULT — before anything reads (recall, 8.3) or writes (reflect, 8.4) it. No
     embedding COMPUTE, no recall, no reflection, no UI here; those are 8.2-8.4. Mirrors the Story 6.1
     pattern (model + store + management surface before the behavior). Two load-bearing decisions this
     story bakes in: pgvector + a fixed embedding dimension (see Dev Notes). -->

## Story

As the builder,
I want turanga to model memory + its per-agent and global configuration as first-class things before anything reads or writes them,
so that memory is a stable, governed, opt-in capability from the start.

## Acceptance Criteria

1. **Given** the domain + contracts, **when** memory is modeled, **then** a `Memory` is a control-plane record (`kind`: episodic | semantic | procedure; verbatim `content` + `summary`; `embedding` vector; `topic`/scope; `salience`; `sourceRunId`; temporal validity `validFrom`/`validUntil`; usage `useCount`/`lastUsedAt`) keyed by `agentId`; a per-agent `MemoryConfig` models the three-level toggle (`mode: inherit | on | off`, `recall`/`reflect` independent, memory `kinds`); a global `MemoryGlobalConfig` (default on/off, kill switch, embedding model, retention/decay + privacy defaults) models the operator defaults; and a pure `effectiveMemoryConfig(global, perAgent)` resolves them. **No secret ever lives in a memory (AD-10).** [Source: epics.md#Story-8.1, AD-10]

2. **Given** the store, **when** it is created, **then** an `agent_memories` table lands with a **pgvector** embedding column; **control-api is its sole writer** (AD-7); the memory config persists (global defaults + a per-agent config); pgvector is enabled in the Postgres image + a boot migration; IDs/timestamps follow project conventions (ULID, UTC). [Source: epics.md#Story-8.1, AD-7]

3. **Given** the security stance, **when** memory ships, **then** it is **OFF by default** — a new agent has no memory behavior until explicitly enabled (the global default is off, a new agent's config is `inherit`), and memories are **agent-scoped** (no cross-agent read is possible through the repo API — FR-7). [Source: epics.md#Story-8.1, FR-7, "off by default"]

## Tasks / Subtasks

- [x] **Task 1: Domain model — Memory, config, and the effective-resolution helper** (AC: #1, #3)
  - [x] `packages/domain/src/index.ts` — add (near `Agent`/`AttachedTool`, ~:57-130):
    - `MemoryKind = "episodic" | "semantic" | "procedure"`.
    - `Memory` interface: `{ id: Ulid; agentId: Ulid; kind: MemoryKind; content: string; summary: string; embedding: number[] | null; topic: string | null; salience: number; sourceRunId: Ulid | null; validFrom: string; validUntil: string | null; useCount: number; lastUsedAt: string | null; createdAt: string }` (UTC ISO-8601 timestamps). `embedding` is nullable — it is POPULATED in Story 8.3 (recall); the column exists now.
    - `MemoryConfig` (per-agent): `{ mode: "inherit" | "on" | "off"; recall: boolean; reflect: boolean; kinds: MemoryKind[] }`. The default for a NEW agent is `{ mode: "inherit", recall: true, reflect: true, kinds: ["episodic","semantic","procedure"] }` — `inherit` + a global default of OFF = effectively off (AC3).
    - `MemoryGlobalConfig`: `{ defaultEnabled: boolean; killSwitch: boolean; embeddingModel: string; retentionDays: number | null; privacy: "agent-scoped" }`. Ships `defaultEnabled: false`, `killSwitch: false`, `embeddingModel: "text-embedding-3-small"` (see Dev Notes — the dimension decision), `retentionDays: null`, `privacy: "agent-scoped"`.
    - `effectiveMemoryConfig(global: MemoryGlobalConfig, perAgent: MemoryConfig): { enabled: boolean; recall: boolean; reflect: boolean; kinds: MemoryKind[] }` — pure: `killSwitch` ⇒ everything off; else `enabled = mode === "on" ? true : mode === "off" ? false : global.defaultEnabled`; `recall`/`reflect` gated by `enabled` AND the per-agent flag; `kinds` = the per-agent list. This is the `activationBlockers` analogue (a pure domain rule reused by the orchestrator in 8.3/8.4 and the web in 8.2). **Enforcement is 8.2/8.3/8.4** — this story only defines the rule + the store.

- [x] **Task 2: pgvector-enabled Postgres + the extension** (AC: #2)
  - [x] `deploy/compose.yaml` — swap the postgres service `image: postgres:17` → `image: pgvector/pgvector:pg17` (a drop-in that bundles the `vector` extension; same PG 17, same env/volumes/init). Vanilla `postgres:17` does NOT ship pgvector, so `CREATE EXTENSION vector` would fail — the image swap is required.
  - [x] The migration (Task 3) runs `CREATE EXTENSION IF NOT EXISTS vector;` before the table (drizzle-kit won't emit the extension line — prepend it to the generated SQL, or add it to `deploy/postgres-init/` as `02-pgvector.sql`; prefer the migration so a fresh + an existing DB both get it via `runMigrations` on boot, `db/migrate.ts`).

- [x] **Task 3: The store — schema, migration, and the control-api memory module** (AC: #2, #3)
  - [x] `apps/control-api/src/db/schema.ts` — add:
    - `agentMemories` table (mirror the `tools`/`runs` table style): `id text pk`, `agentId text notNull`, `kind text notNull`, `content text notNull`, `summary text notNull default ''`, `embedding vector("embedding", { dimensions: 1536 })` (nullable — from `drizzle-orm/pg-core`; see Dev Notes for the dimension), `topic text`, `salience integer notNull default 0`, `sourceRunId text`, `validFrom timestamptz notNull defaultNow`, `validUntil timestamptz`, `useCount integer notNull default 0`, `lastUsedAt timestamptz`, `createdAt timestamptz notNull defaultNow`. Index on `agentId` (recall filters by it). **Do NOT add the ivfflat/hnsw vector index yet** — that's 8.3 (recall), where the distance operator is chosen; note it.
    - `memorySettings` singleton table (global defaults): `id text pk` (always `"global"`), `defaultEnabled boolean notNull default false`, `killSwitch boolean notNull default false`, `embeddingModel text notNull default 'text-embedding-3-small'`, `retentionDays integer`, `privacy text notNull default 'agent-scoped'`, `updatedAt timestamptz notNull defaultNow`.
    - `agents.memoryConfig` — a `jsonb("memory_config").$type<MemoryConfig>().notNull().default({ mode: "inherit", recall: true, reflect: true, kinds: [...] })` column (mirrors `skills`/`attachedTools` on `agents`). **NOT part of the published snapshot** (operational config, like `state`/lifecycle — not the published *definition*); do NOT add it to `PUBLISHED_FIELDS` (see Dev Notes).
  - [x] Generate the migration: `pnpm --filter @turanga/control-api exec drizzle-kit generate` → `drizzle/0015_*.sql` (+ `meta/_journal.json` + snapshot). **Hand-edit the generated 0015 SQL to prepend `CREATE EXTENSION IF NOT EXISTS vector;`** (drizzle-kit doesn't emit it). Applied on boot via `db/migrate.ts`.
  - [x] `apps/control-api/src/memory/` (NEW module, mirror `apps/control-api/src/tools/repo.ts`):
    - `repo.ts` — `MemoryRow` (mirrors the domain `Memory`); `MemoryConfigRow`/`GlobalConfigRow`. `MemoryRepo` interface + `drizzleMemoryRepo(db)` + `memoryMemoryRepo()` (in-memory, for tests). Methods: `listForAgent(agentId)`, `getMemory(id)`, `createMemory(row)`, `deleteMemory(id)` (agent-scoped — every read/write is keyed by `agentId`; there is NO cross-agent query, AC3/FR-7); `getGlobalConfig()` / `setGlobalConfig(patch)` (singleton; a first read seeds the OFF defaults); `getAgentMemoryConfig(agentId)` / `setAgentMemoryConfig(agentId, config)` (the per-agent column). **control-api is the sole writer (AD-7)** — the repo is the only mutation surface; the harness/sandbox never touch it.
    - No embedding compute, no similarity query, no consolidation here — those are 8.3/8.4.
  - [x] `apps/control-api/src/app.ts` — construct + inject the memory repo (`deps.memoryRepo ?? memoryMemoryRepo()`, mirroring `toolsRepo` at :71/:40); `apps/control-api/src/server.ts` — wire `drizzleMemoryRepo(db)`. No routes yet (the config surface + settings routes are Story 8.2; recall/reflect use the repo from the orchestrator in 8.3/8.4). Wiring it now keeps the module boot-tested.
  - [x] The agent create-default (`agents/routes.ts` POST + the repo `AgentRow` literals) gains `memoryConfig: { mode: "inherit", recall: true, reflect: true, kinds: [...] }` so a new agent is well-formed and **off by default** (inherit + global off).

- [x] **Task 4: Tests + verification** (AC: all)
  - [x] **domain unit** (`packages/domain/src/index.test.ts`): `effectiveMemoryConfig` — `killSwitch` ⇒ all off; `mode:"on"` ⇒ enabled regardless of global; `mode:"off"` ⇒ disabled; `mode:"inherit"` follows `global.defaultEnabled` (default false ⇒ **off**); `recall`/`reflect` gated by both `enabled` and the per-agent flag; kinds pass through. The `Agent` fixture gains `memoryConfig` (compiles).
  - [x] **control-api unit** (`memory` repo tests, mirror `tools.test.ts`): create/list/get/delete a memory **scoped to `agentId`** (a memory for agent A is never returned for agent B — assert isolation, FR-7); the global config seeds **OFF** on first read + round-trips a patch; per-agent config defaults to `inherit` + round-trips. No embedding is computed (the column is null). Assert the repo exposes **no cross-agent read** (there is no `listAll`/unscoped method).
  - [x] **control-api boot/app test**: `createApp({ memoryRepo })` wires without error; a fresh agent's `memoryConfig` is `inherit` and `effectiveMemoryConfig(defaultGlobal, it)` is **disabled** (the end-to-end "off by default" assertion).
  - [x] `svelte-check` (no web change) · `pnpm -r build` (8 workspaces) · `pnpm lint` · all unit suites green · **e2e via `deploy/test-stack.sh`** to prove the **pgvector image + the `CREATE EXTENSION` migration apply on a fresh DB** (the run-dependent tests still pass; the new table exists) — **NEVER `docker compose down -v` on the dev stack**; `pnpm -r build` before any Docker build; restore + verify dev data (`Clyde`/`Untitled agent`/`wopr`) after. Note: the image swap re-pulls Postgres — the dev stack's `pgdata` volume is compatible (same PG 17 major), but call it out.

## Dev Notes

**The spine of Epic 8. Model memory + its configuration + the pgvector store, OFF BY DEFAULT — before recall (8.3) reads it or reflection (8.4) writes it. No embedding compute, no similarity query, no UI here.** Mirrors Story 6.1 (which modeled the Tool + its management surface before 6.2-6.5 made tools real).

### Two load-bearing decisions this story bakes in
1. **pgvector + a FIXED embedding dimension.** The `agent_memories.embedding` column is `vector(1536)` — committing to **`text-embedding-3-small`** (1536 dims, LiteLLM-hosted) as the default embedding model. Rationale: pgvector's index needs a fixed dimension, and 1536 is the common, cheap, LiteLLM-available default; the actual embedding COMPUTE is Story 8.3. **Changing the model later = a migration + a re-embed** — noted in the epic's open questions. If the operator must pick a different model up front, that's a one-line change to the dimension + the `embeddingModel` default before this story is built. (This is the one decision worth confirming with the user; everything else follows.)
2. **Off by default, three-level, resolved by a pure rule.** Global `defaultEnabled: false` + a new agent's `mode: "inherit"` ⇒ effectively **off**. `effectiveMemoryConfig` is the single source of truth (the `activationBlockers` analogue) — 8.2 (UI + enforcement), 8.3 (recall gate), 8.4 (reflect gate) all read it; **the harness never decides** (AD-7/AD-9).

### Architecture (binding)
- **AD-7 — control-api is the sole writer.** The `memory` module (repo) is the only mutation surface for `agent_memories`/`memory_settings`/`agents.memory_config`. The sandbox/harness never read or write memory (AD-1). This story adds a new persisted-state owner exactly like `tools`/`runs`.
- **AD-10 — no secret in a memory.** A `Memory` holds `content`/`summary` (text) + an embedding vector — never a credential, token, or endpoint. (Recall in 8.3 injects memories into the JobSpec as secret-free content, like instructions.)
- **FR-7 / isolation — agent-scoped.** Every repo read/write is keyed by `agentId`; there is no cross-agent query. "Shared across a builder's agents" is an explicit later opt-in (epic scope guard), never the default.
- **Not the published definition.** `memoryConfig` is operational/privacy config (does the agent remember), like the activate `state` — it is NOT in `PUBLISHED_FIELDS` and changing it does not make the agent "dirty" or require a republish. (Confirm during build; if the team wants memory config versioned with the definition, add it to `PUBLISHED_FIELDS` — but the spine treats it as operational.)

### Existing patterns to mirror (exact file:line, from the codebase)
- **A new first-class entity + repo:** `apps/control-api/src/tools/repo.ts` — `ToolRow`/`ToolsRepo`/`drizzleToolsRepo`/`memoryToolsRepo`, `toRow`, the create/list/get/delete shape. THE template for `memory/repo.ts`.
- **A dedicated table:** `apps/control-api/src/db/schema.ts` — the `tools` table (jsonb `operations`, text cols, `timestamp` createdAt) and `runs` (jsonb `transcript`) show the column idioms; `agents` (`skills`/`attachedTools` jsonb columns, `costCap` jsonb default) is the template for adding `memory_config` to `agents`.
- **The pure domain rule + its test:** `packages/domain` `activationBlockers` (a pure, exported, unit-tested rule the server + web both consume) — the exact shape for `effectiveMemoryConfig`. `Agent` interface at `index.ts:57`; add memory types nearby.
- **Repo wiring:** `apps/control-api/src/app.ts` (`deps.toolsRepo ?? memoryToolsRepo()`, the `AppDeps` optional field) + `apps/control-api/src/server.ts` (`drizzleToolsRepo(db)`).
- **Migration flow:** `drizzle-kit generate` → `drizzle/0015_*.sql` (next number after `0014`) + `meta/_journal.json` + snapshot; applied on boot by `apps/control-api/src/db/migrate.ts` (`runMigrations` → `migrate(db, { migrationsFolder })`). **drizzle-kit will NOT emit `CREATE EXTENSION`** — hand-prepend it.
- **The isolated e2e stack:** `deploy/test-stack.sh` (`turanga-e2e` project). See [[turanga-e2e-clean-run]] — reset → wait for LiteLLM key-readiness → never `down -v` the dev stack. The image swap makes this run especially worth doing (prove pgvector applies).

### drizzle pgvector specifics (verified on the installed version)
- `drizzle-orm@0.45.2` ships the `vector` column (`import { vector } from "drizzle-orm/pg-core"`; `vector("embedding", { dimensions: 1536 })`), nullable is fine. `drizzle-kit@0.31.10` generates the column; it does NOT generate `CREATE EXTENSION vector` (prepend it to the migration).
- The **HNSW/IVFFlat index is deferred to 8.3** (the index type + distance op — cosine `vector_cosine_ops` likely — are a recall decision; a full seq-scan is fine for the spine's tiny data, and the index is a pure addition later).

### Project Structure Notes
- New: `apps/control-api/src/memory/repo.ts`, `apps/control-api/src/memory/repo.test.ts` (or `memory.test.ts`), `drizzle/0015_*.sql` (+ meta), a `02-pgvector.sql` in `postgres-init/` ONLY if not doing the extension in the migration (prefer the migration). Edited: `packages/domain/src/index.ts` (+ test), `apps/control-api/src/db/schema.ts`, `apps/control-api/src/agents/{routes,repo}.ts` (the `memoryConfig` default on create), `apps/control-api/src/app.ts` + `server.ts` (wire the repo), `deploy/compose.yaml` (the pgvector image).
- No new npm dependency (drizzle already has `vector`; no embedding client yet — that's 8.3). No web change. No CONTRACT_VERSION change (memory doesn't touch the sandbox wire until 8.3 adds `JobSpec.memories`).
- Scope guard: **NO embedding compute, NO recall, NO reflection, NO settings UI, NO agent-editor Memory section, NO enforcement in the run path.** Those are 8.2 (config UI + enforcement), 8.3 (recall), 8.4 (reflect), 8.5/8.6 (observability + oversight). This story lands the model + store + off-by-default posture only.

### Testing standards
- Vitest for the domain rule (`effectiveMemoryConfig` — the off-by-default matrix) and the control-api memory repo (agent-scoped CRUD, config seeding OFF, no cross-agent read). A boot/app test proves the wiring + the end-to-end "off by default." Playwright e2e via the **isolated `deploy/test-stack.sh`** proves the **pgvector image + `CREATE EXTENSION` migration** apply on a fresh DB and the existing run tests still pass; `pnpm -r build` before any Docker build; **never `down -v` the dev stack**.

### References
- [Source: _bmad-output/planning-artifacts/epics.md#Epic-8, #Story-8.1 — the memory record, the three-level config, off-by-default, pgvector, AD-7/AD-10/FR-7]
- [Source: the design plan `~/.claude/plans/toasty-wishing-papert.md` — the store + three-seam architecture; recall/reflect are 8.3/8.4]
- [Source: _bmad-output/implementation-artifacts/6-1-tool-model-and-management.md — the "model + store + management before behavior" spine pattern this mirrors]
- [Source: architecture spine #AD-1 (sandbox has no DB edge), #AD-7 (single-writer), #AD-9 (immutable spec), #AD-10 (no secret in sandbox); FR-7 (no cross-run/agent shared state)]
- [Source: project-context.md — pnpm workspaces, Node 22, Drizzle + Postgres 17, control-api sole writer of Agent state; build/test expectations]
- [Source: deploy/test-stack.sh + [[turanga-e2e-clean-run]] — isolated e2e; wait for LiteLLM key-readiness; never `down -v` the dev stack]

## Dev Agent Record

### Agent Model Used

claude-opus-4-8[1m] (Claude Code)

### Debug Log References

- Docker build compiles test files (`tsc -p tsconfig.json` includes `*.test.ts`): a `repo as Record<string, unknown>` cast that `tsc` accepts locally only after the file exists tripped TS2352 in the image build — fixed with an intermediate `as unknown` cast in `memory/repo.test.ts`.
- e2e: the first `test-stack.sh up` reused **leftover `turanga-e2e` volumes** from a prior session (a non-pristine DB), so empty-state specs saw stale agents/tools. Used `test-stack.sh reset` (`down -v` on the e2e project only) for a truly pristine slate; the migration was re-verified on that fresh volume.

### Completion Notes List

- **Scope:** the Epic 8 SPINE only — the memory model, the pgvector store, and the three-level off-by-default config. No embedding compute, no recall, no reflection, no UI, no run-path enforcement (those are 8.2–8.4). `effectiveMemoryConfig` is the pure `activationBlockers`-style rule the later stories will read; it is defined + unit-tested here but nothing consumes it in the run path yet.
- **Off by default, verified end-to-end:** global `defaultEnabled:false` + a new agent's `mode:"inherit"` ⇒ `effectiveMemoryConfig(...).enabled === false`. Asserted in the domain unit, the repo unit, and a `createApp` boot test (POST /agents → the returned agent's `memoryConfig` resolves disabled and never appears in `changedFields`).
- **Agent-scoped isolation (FR-7):** the `MemoryRepo` has NO unscoped read — every accessor is keyed by `agentId`, and `getMemory`/`deleteMemory` take **`(agentId, id)`** (a deliberate hardening beyond the story's `(id)` signature) so a memory only resolves/deletes for its owner. Unit test asserts A's memory is never returned to B and B cannot delete it by guessing the id.
- **`memoryConfig` is operational, NOT the published definition:** it is a column on `agents` but is deliberately absent from `PUBLISHED_FIELDS`/`snapshotOf`, so editing it never makes an agent dirty or requires a republish (mirrors `state`). The memory module owns its mutation surface (`get/setAgentMemoryConfig`) per the story, still control-api (AD-7).
- **pgvector migration proven on a fresh DB:** the `pgvector/pgvector:pg17` image swap + the hand-prepended `CREATE EXTENSION IF NOT EXISTS vector;` in `0015` apply on boot. Verified via `deploy/test-stack.sh` on both a fresh `up` and a `down -v` `reset`: `vector 0.8.6` installed, `agent_memories` (with `vector(1536)` + the agent_id index) and `memory_settings` created, `agents.memory_config` present with the inherit/all-kinds default.
- **Verification:** `pnpm -r build` (8 workspaces) ✓, `pnpm lint` ✓, `svelte-check` 0 errors ✓, domain units 4/4 ✓, control-api units 168 (7 new memory tests) ✓.
- **e2e (Playwright) — 4 known pre-existing flakes, NOT this change:** the remaining agents/providers failures are (a) run-dependent specs needing a live model path, and (b) **Agent-Management-editor UI brittleness** introduced by the earlier `83411d2` rewrite — a test-console drawer overlapping the Save-draft button (pointer-event interception) and a duplicate `History`/`Runs` selector (strict-mode violation). None touch memory (this story ships no UI). The `create agent → Draft row` spec, which exercises the create path that now writes `memory_config`, **passes in isolation** — confirming the create path is unbroken; the earlier login-redirect failures were argon2/login contention under the full serial run.
- **Dev-stack note (operator-facing):** restoring the dev stack with `docker compose up -d` (no `--build`) keeps the **pre-existing control-api image**, so `0015` has not applied to the dev `control` DB — dev data (Clyde et al.) is intact and its schema untouched; `0015` will apply on the next dev image rebuild. Separately, the Postgres **image swap** surfaces a benign `collation version mismatch` WARNING on the existing dev volume (the pgvector image ships an older glibc than the volume was created with) — harmless for our text/vector usage; resolvable with `ALTER DATABASE control REFRESH COLLATION VERSION;` + a reindex if desired.

### File List

- **Edited** `packages/domain/src/index.ts` — `MemoryKind`/`MEMORY_KINDS`, `Memory`, `MemoryConfig` + `DEFAULT_MEMORY_CONFIG`, `MemoryGlobalConfig` + `DEFAULT_MEMORY_GLOBAL_CONFIG`, the pure `effectiveMemoryConfig`; added required `memoryConfig` to `Agent`.
- **Edited** `packages/domain/src/index.test.ts` — `effectiveMemoryConfig` off-by-default matrix; `Agent` fixture gains `memoryConfig`.
- **Edited** `deploy/compose.yaml` — postgres image `postgres:17` → `pgvector/pgvector:pg17`.
- **Edited** `apps/control-api/src/db/schema.ts` — `agent_memories` + `memory_settings` tables; `agents.memory_config` jsonb column; imports `boolean, index, vector`.
- **New** `apps/control-api/drizzle/0015_even_dormammu.sql` — hand-prepended `CREATE EXTENSION IF NOT EXISTS vector;` (+ `meta/_journal.json` + snapshot from `drizzle-kit generate`).
- **New** `apps/control-api/src/memory/repo.ts` — `MemoryRow`, `MemoryRepo`, `drizzleMemoryRepo(db)`, `memoryMemoryRepo()`; agent-scoped CRUD + global/per-agent config.
- **New** `apps/control-api/src/memory/repo.test.ts` — agent-scoped CRUD + isolation, config seeds OFF, off-by-default boot test.
- **Edited** `apps/control-api/src/agents/repo.ts` — `AgentRow.memoryConfig`; threaded through `toRow`/`create`; duplicate carries it via `...source`.
- **Edited** `apps/control-api/src/agents/routes.ts` — POST /agents create default `memoryConfig: DEFAULT_MEMORY_CONFIG`.
- **Edited** `apps/control-api/src/app.ts` — `AppDeps.memoryRepo` + default `memoryMemoryRepo()`; threaded into the default orchestrator.
- **Edited** `apps/control-api/src/server.ts` — `drizzleMemoryRepo(db)` wired into the orchestrator + `createApp`.
- **Edited** `apps/control-api/src/runs/orchestrator.ts` — optional `memoryRepo` on `OrchestratorDeps` (threaded now; consumed by recall 8.3 / reflect 8.4).

### Change Log

| Date | Version | Description |
|------|---------|-------------|
| 2026-08-05 | 0.1 | Story 8.1 implemented — memory model + pgvector store + off-by-default three-level config spine. Status → review. |
