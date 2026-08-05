---
baseline_commit: 1bdcb707dcac70b4a26972beb2fd06858e3d6cae
---
# Story 8.5: Memory observability + management

Status: review

<!-- FIFTH story of Epic 8. The loop now WORKS (8.3 recall + 8.4 reflect) but it's a black box: the
     builder can't see what an agent has learned, which memory changed a run, or fix a wrong one. This
     makes memory INSPECTABLE + CURATABLE: a per-agent memory list (kind, summary, salience, usage,
     source run, validity), the per-run "learned → recalled" causal chain (the recall transcript event
     + the sourceRunId link 8.4 wrote), and curation — pin (protect from prune), edit (re-embed), forget.
     control-api is the sole writer (AD-7); agent-scoped (FR-7). It does NOT gate learning (no staged
     approval / quarantine / learning-changelog — that's 8.6); it shows + curates what already exists. -->

## Story

As the builder,
I want to see and curate what an agent has learned,
so that I can trust the loop — inspect what it knows, see which memory changed a run, and forget anything wrong.

## Acceptance Criteria

1. **Given** a memory-enabled agent, **when** its memory is viewed, **then** the builder sees the agent's memories — **kind**, **summary**, **salience**, **usage** (`useCount` / `lastUsedAt`), the **source run** it was learned from (`sourceRunId`, linkable), and whether it's **superseded** (`validUntil` in the past) or **pinned** — on a dedicated per-agent surface; and **per run** the builder sees **which memories it recalled** (from the run's `recall` transcript event) and **which it learned** (memories whose `sourceRunId` is that run) — the visible "learned → recalled → improved" causal chain (NFR-4). Agent-scoped — no cross-agent memory is ever shown (FR-7). [Source: epics.md#Story-8.5 AC1, NFR-4, FR-7]

2. **Given** a memory, **when** the builder acts on it, **then** they can **pin** it (protect it from the reflect prune / decay), **edit** its content + summary (which **re-embeds** it so recall stays accurate), or **forget** (delete) it — each through **control-api as the sole writer** (AD-7). Curation is agent-scoped; a memory can carry real user data, shown only to its authorizing operator (the 8.2 agent-scoped privacy default; no cross-agent exposure, no redaction added here). [Source: epics.md#Story-8.5 AC2, AD-7, the 8.2 privacy default]

## Tasks / Subtasks

- [x] **Task 1: The `pinned` column + the repo update primitive** (AC: #1, #2)
  - [x] `apps/control-api/src/db/schema.ts` — add `pinned: boolean("pinned").notNull().default(false)` to `agentMemories` (`schema.ts:147-172`; `boolean` is already imported). Then `pnpm --filter @turanga/control-api exec drizzle-kit generate` → `drizzle/0017_*.sql` — a plain boolean column generates cleanly (NO hand-edit, unlike the pgvector migrations).
  - [x] `apps/control-api/src/memory/repo.ts` — add `pinned: boolean` to `MemoryRow` (`:18-33`) + `toRow` (`:61-78`, `pinned: r.pinned`) + the `createMemory` insert (`:102-119`, `pinned: row.pinned`) + the in-memory fake `createMemory`. Add a scoped update method to the `MemoryRepo` interface + BOTH impls (mirror `bumpSalience`/`supersede` at `:168-179`, the `and(eq(id), eq(agentId))` scope-guard, FR-7):
    - `updateMemory(agentId: string, id: string, patch: { content?: string; summary?: string; embedding?: number[]; pinned?: boolean }): Promise<void>` — applies only the defined keys (`.set({...})` built from the patch; skip if empty). The fake mutates the `Map` entry.
  - [x] Every existing `MemoryRow` construction gains `pinned: false` — the `memRow` test helpers (`memory/repo.test.ts` + `memory/routes.test.ts`), the orchestrator reflect insert (`orchestrator.ts` `reflectRun` — the new-memory literal, `pinned: false`), and any other `MemoryRow` literal (build will flag them).

- [x] **Task 2: Reflect prune must never forget a pinned memory** (AC: #2)
  - [x] `apps/control-api/src/runs/orchestrator.ts` — the prune block in `reflectRun` (`:268-275`): filter out pinned before sort/slice — `const prunable = all.filter((m) => !m.pinned)`, take `doomed` from `prunable` (keep the `all.length - MAX_MEMORIES_PER_AGENT` budget math). A pinned memory is protected from the "forget" step. (This is the only delete-many path in reflection; it's already fail-safe.)

- [x] **Task 3: Memory routes — list, edit/pin (re-embed), forget** (AC: #1, #2)
  - [x] `apps/control-api/src/memory/routes.ts` — widen the factory to `memoryRoutes(repo: MemoryRepo, gateway: ModelGateway)` (`:36`). The gateway is already constructed in `app.ts:80` (before the mount at `:94`) — pass it: `app.route("/", memoryRoutes(memoryRepo, gateway))`. Add three routes after the bulk purge (`:53-58`):
    - `GET /memory/agents/:agentId` → `repo.listForAgent(agentId)` mapped to a **view** (drop `embedding` — huge + useless to the UI): `{ id, kind, summary, content, topic, salience, useCount, lastUsedAt, sourceRunId, validFrom, validUntil, pinned, createdAt }`. Sort **pinned first, then salience desc, then createdAt desc**. Return `{ memories: [...] }`.
    - `PATCH /memory/agents/:agentId/:id` → parse the body `{ content?: string; summary?: string; pinned?: boolean }` (a `parseMemoryEdit` validator mirroring `parseGlobalConfig` at `:12-34`; reject non-string content/summary, non-boolean pinned, 400). `const existing = await repo.getMemory(agentId, id); if (!existing) return 404`. Build the patch; **if `content` changed, re-embed**: `const embedding = await gateway.embed(content, (await repo.getGlobalConfig()).embeddingModel)` — best-effort (on throw, update the text but keep the old embedding; a stale-but-present vector beats a failed edit). `await repo.updateMemory(agentId, id, patch)`; return the updated memory view (`repo.getMemory` again → view).
    - `DELETE /memory/agents/:agentId/:id` → `if (!(await repo.getMemory(agentId, id))) return 404; await repo.deleteMemory(agentId, id); return { ok: true }`. (Forget ONE — distinct from the existing bulk purge `DELETE /memory/agents/:agentId`.)
  - [x] Session-guarded already via the `/memory/*` wildcard (`app.ts:76-77`) — no new guard.

- [x] **Task 4: The web memory client + the per-agent memory page** (AC: #1, #2)
  - [x] `apps/web/src/lib/memory.ts` — add a local `MemoryView` type (the route's view shape) + client fns mirroring `purgeAgentMemory` (`memory.ts:38-40`, `encodeURIComponent` both path params): `listAgentMemories(agentId): Promise<Result<MemoryView[]>>` (GET, unwrap `{ memories }`); `editMemory(agentId, id, patch: { content?; summary?; pinned? }): Promise<Result<MemoryView>>` (PATCH); `setMemoryPinned(agentId, id, pinned)` (thin wrapper over `editMemory`); `forgetMemory(agentId, id): Promise<Result<{ ok: true }>>` (DELETE).
  - [x] **NEW** `apps/web/src/routes/(app)/agents/[id]/memory/+page.svelte` — mirror the run-history page `agents/[id]/runs/+page.svelte` (the seq-guarded `load()`, the loading/error/empty/list states, the back-arrow header, the `.run`-style card rows). Render each memory as a row: a **kind** tag + the **summary** (click to expand the full `content`); a meta row (`salience`, `useCount`× used, `lastUsedAt` via `$lib/datetime` `formatTimestamp`, a **source-run link** → `/agents/{id}/runs/{sourceRunId}` when set, a "superseded" marker when `validUntil` is past); and a **pinned** indicator (a `Pin` lucide icon + the literal word "Pinned" — never colour-only, UX-DR11/NFR-6). Per-row actions: **Pin/Unpin** (toggle → `setMemoryPinned` → reload), **Edit** (inline textarea for content + summary → `editMemory` → reload), **Forget** (a confirm step, mirror the `AgentMemoryTab` danger button styling at `:304-326` → `forgetMemory` → reload). Empty state: "This agent hasn't learned anything yet." (+ a note that memory must be on + reflect must have run).
  - [x] `apps/web/src/routes/(app)/agents/[id]/+page.svelte` — add a `<a class="ghost" href="/agents/{agent.id}/memory">Memory</a>` in the header `.head-actions` cluster (`:446`, next to the "Runs" ghost link).

- [x] **Task 5: The per-run causal chain on the run detail page** (AC: #1)
  - [x] `apps/web/src/routes/(app)/agents/[id]/runs/[runId]/+page.svelte` — between the `.task` and `.transcript` blocks (`:79-91`), add a **"Memory" card** (only when there's something to show): **Recalled** = the memory ids from the run's `recall` transcript events (`run.transcript.filter((m) => m.type === "recall").flatMap((m) => m.memoryIds)`), resolved to summaries by a best-effort `listAgentMemories(id)` load; **Learned** = those memories whose `sourceRunId === runId`. Each links to `/agents/{id}/memory`. This is the visible causal chain (recall event + sourceRunId — both already written by 8.3/8.4). If the memory fetch fails, the section is simply omitted (best-effort — never break the run view). Do NOT add `recall` to `RunTranscript`'s render chain (recall is shown in this dedicated card, not inline in the message stream).

- [x] **Task 6: Tests + verification** (AC: all)
  - [x] **control-api unit** (`memory/routes.test.ts`, mirror the app-session harness): `GET /memory/agents/:id` returns the agent's memories as a view **without `embedding`**, sorted pinned-first; `PATCH` edits content+summary and **re-embeds** (assert the fake gateway's `embed` was called + the stored embedding changed) and toggles `pinned`; a bad body ⇒ 400, an unknown id ⇒ 404; `DELETE /memory/agents/:id/:memId` forgets one (and 404s an unknown id); ALL agent-scoped — agent B can't read/edit/forget agent A's memory (FR-7); session-guarded (401 without cookie).
  - [x] **control-api unit** (`memory/repo.test.ts`): `updateMemory` applies only defined keys, agent-scoped (wrong agent = no-op); a fresh + a reflect-written memory carry `pinned: false`.
  - [x] **control-api unit** (`runs/runs.test.ts`): the reflect prune **never deletes a pinned memory** — seed the budget with a pinned lowest-salience row + fill past `MAX_MEMORIES_PER_AGENT`, run reflect, assert the pinned row survives and an unpinned lowest-salience one is pruned.
  - [x] **web** — `svelte-check` clean; a Playwright spec (extend or new `tests/memory.spec.ts`): the agent header has a **Memory** link → the memory page renders the empty state for a fresh agent; (with a seeded memory via the API) a row shows its summary + meta, **Pin** toggles the pinned indicator across a reload, **Edit** changes the summary, **Forget** removes the row; and the run detail page shows the "Memory" causal-chain card for a run with a recall event. (These are config/CRUD — not run-dependent; still `reset` for a pristine DB per [[turanga-e2e-clean-run]].)
  - [x] `pnpm -r build` (8 workspaces) · `pnpm lint` · `svelte-check` · all unit suites green · **e2e via `deploy/test-stack.sh`** — rebuild images (schema/migration change → `0017` applies; NO contract bump). Prove `0017` applies on a fresh DB + the memory routes serve. **Never `down -v` the dev stack**; `pnpm -r build` before any Docker build; restore + verify dev data. See [[turanga-e2e-clean-run]].

## Dev Notes

**Make the loop legible + trustworthy.** 8.3/8.4 made an agent learn + recall; this story lets the builder SEE it (per-agent memory list + per-run causal chain) and FIX it (pin/edit/forget). It's the trust surface for a self-improving agent with real access — the necessary companion to the "it learns" story. It reads + curates existing memory; it does not gate learning (8.6).

### What already exists (do NOT rebuild)
- **The store + writer:** `agent_memories` (all the fields the list shows — `salience`, `useCount`/`lastUsedAt`, `sourceRunId`, `validUntil`, `kind`, `content`/`summary`, `topic`; `db/schema.ts:147-172`) minus `pinned` (this story adds it). `MemoryRepo` (`repo.ts`) has `listForAgent`/`getMemory`/`deleteMemory`/`createMemory`/`updateMemory`(new); every accessor is agent-keyed (FR-7 — `repo.ts:36-37`).
- **The causal links 8.3/8.4 already wrote:** the `recall` transcript event `{ type:"recall", memoryIds, count }` (contracts, on the run row at creation) records which memories a run recalled; each written memory's `sourceRunId` (set by `reflectRun`, `orchestrator.ts:258`) records which run taught it. The web already types `recall` in `RunMessage` (`$lib/runs.ts:16`). This story just RENDERS those two links — no new recording.
- **The routes/client idiom:** `memory/routes.ts` (`memoryRoutes`, the `parse*` validator shape, the bulk-purge `DELETE /memory/agents/:agentId`); `$lib/memory.ts` (the `req`/`Result` wrapper + `purgeAgentMemory`). The gateway (`embed`) is already in `app.ts` scope for the edit re-embed.
- **The list-page skeleton:** `agents/[id]/runs/+page.svelte` (seq-guarded load, loading/error/empty/list, back-arrow header, card rows). The header "Runs" ghost link (`agents/[id]/+page.svelte:446`) is the template for the "Memory" link.

### Architecture (binding)
- **AD-7 — control-api sole writer.** Pin/edit/forget all go through `memoryRoutes` → `MemoryRepo`. The web never writes memory directly; the sandbox/harness never touch it.
- **FR-7 — agent-scoped.** Every route + repo method is keyed by `agentId` (the URL carries it; the repo re-checks it). Agent B can never see or curate agent A's memory. There is no cross-agent list. Assert this in tests.
- **NFR-4 — auditable causality.** The per-run Recalled + Learned view IS the "learned → improved" chain the epic's keystone demands. It's derived from the recall event + sourceRunId, both already persisted.
- **Privacy (8.2 default).** Memories can carry real user data; they are shown ONLY on their own agent's surface to the authorizing operator (agent-scoped). No redaction is added here (a deferred flag). Do not add a cross-agent or "all memories" view.
- **NFR-6 / UX-DR11.** `pinned` / superseded state renders as icon/dot + WORD, never colour-only.

### Design decisions to bake in
- **Pin = a hard protect, not high salience.** A dedicated `pinned` boolean the prune excludes — deterministic, unlike salience-as-pin. (The review W-cluster noted salience is fuzzy; a boolean is the right primitive.)
- **Edit re-embeds on content change** so recall similarity stays accurate; best-effort (a re-embed failure updates the text, keeps the old vector — never fails the edit). Editing only the summary/pinned does not re-embed.
- **The per-run view joins client-side** (the run's transcript recall event + a `listAgentMemories` fetch filtered by id / `sourceRunId`) — no new cross-repo backend route; keeps the memory routes repo-only + the join in the web where both are already loaded.
- **Sort:** pinned first, then salience desc, then newest — the operator sees protected + important + recent first.

### Existing patterns to mirror (file:line)
- **Routes + validator + mount:** `memory/routes.ts:12-34` (`parseGlobalConfig` → `parseMemoryEdit`), `:36` (widen to `(repo, gateway)`), `:53-58` (the purge route shape); `app.ts:80` (gateway), `:94` (mount).
- **Repo scoped update:** `repo.ts:168-179` (`bumpSalience`/`supersede` — the `and(eq(id), eq(agentId))` guard) → `updateMemory`; `:102-119` (`createMemory` insert) for the `pinned` field; both `drizzleMemoryRepo` + `memoryMemoryRepo`.
- **Re-embed:** `orchestrator.ts:237` (`modelGateway.embed(content, global.embeddingModel)`) — the exact call to mirror in the edit route.
- **Prune-exclude-pinned:** `orchestrator.ts:268-275`.
- **Web list page:** `agents/[id]/runs/+page.svelte` (whole file) → `agents/[id]/memory/+page.svelte`; the run row grid CSS (`:149-160`) + meta cluster (`:65-68`/`:182-188`).
- **Run detail memory section:** `runs/[runId]/+page.svelte:79-91` (between task + transcript); recalled ids `run.transcript.filter(m => m.type === "recall")`.
- **Client fns:** `$lib/memory.ts:38-40` (`purgeAgentMemory`) → the four new fns. **Timestamps:** `$lib/datetime.ts` `formatTimestamp`. **Dot+word:** `StatusDot.svelte`, `AgentMemoryTab.svelte:82-83`; **danger button:** `AgentMemoryTab.svelte:304-326`. **Icons:** `@lucide/svelte` (`Pin`).

### Project Structure Notes
- **New:** `apps/control-api/drizzle/0017_*.sql` (+ meta), `apps/web/src/routes/(app)/agents/[id]/memory/+page.svelte`. **Edited:** `apps/control-api/src/db/schema.ts`, `apps/control-api/src/memory/repo.ts` (+ test), `apps/control-api/src/memory/routes.ts` (+ test), `apps/control-api/src/app.ts` (mount with gateway), `apps/control-api/src/runs/orchestrator.ts` (prune-exclude-pinned + the reflect insert `pinned:false`) (+ `runs.test.ts`), `apps/web/src/lib/memory.ts`, `apps/web/src/routes/(app)/agents/[id]/+page.svelte` (header link), `apps/web/src/routes/(app)/agents/[id]/runs/[runId]/+page.svelte` (causal-chain card), `apps/web/tests/memory.spec.ts`.
- **No change:** `packages/contracts` (NO `CONTRACT_VERSION` bump — no new wire/transcript type; the recall event already exists), `packages/domain`, the reflector/gateway (the edit reuses `embed`).
- **Scope guard:** NO staged-approval / pending-memory gate, NO quarantine, NO learning-changelog / version-by-version diff (all 8.6); NO cross-agent or all-agents view; NO redaction/PII scrubbing (deferred flag); NO retention/decay reaper. This story is view + curate (pin/edit/forget) + the causal chain, on existing memory.

### Testing standards
- Vitest: memory routes (list view without embedding + sort; edit re-embeds via the fake gateway + toggles pinned; forget-one; 400/404; agent-scoped FR-7; session guard), repo `updateMemory` (scoped, partial), orchestrator prune-excludes-pinned. `svelte-check` for the web. Playwright (config/CRUD, not run-dependent): the Memory link + page + pin/edit/forget across reloads + the run causal-chain card. Full verification: `pnpm -r build`, `pnpm lint`, `deploy/test-stack.sh` e2e proving `0017` applies; never `down -v` the dev stack.

### References
- [Source: epics.md#Epic-8 (auditable causality; "see which memory changed a run"; pin/edit/forget curation) + #Story-8.5]
- [Source: 8-3-recall (the `recall` transcript event) + 8-4-reflect (the `sourceRunId` link + the prune this story makes pin-aware) — the causal links this renders]
- [Source: 8-1/8-2 (the store, the memory routes + client idiom, the agent-scoped privacy default)]
- [Source: architecture spine #AD-7 (sole writer), #FR-7 (agent-scoped), #NFR-4 (auditable), #NFR-6 + UX-DR11 (dot + word)]
- [Source: [[turanga-e2e-clean-run]] — reset for pristine; never `down -v` the dev stack; warm Vite]

## Dev Agent Record

### Agent Model Used

claude-opus-4-8[1m] (Claude Code)

### Debug Log References

- The `pinned` column addition rippled to every `MemoryRow` literal (the reflect insert + four test helpers/literals) — the build surfaced all five; each got `pinned: false`.
- e2e reach: memories are only written by reflection (needs a model provider the isolated stack lacks), so the Playwright surface test covers the Memory link + page + empty state end-to-end; the full list/pin/edit/forget curation is covered by the 12 control-api route tests (deterministic via the fake gateway for re-embed).

### Completion Notes List

- **Make the loop legible + curatable.** A per-agent memory page (`/agents/[id]/memory`), the per-run "learned → recalled" causal chain on the run detail page, and pin/edit/forget curation — all through control-api (sole writer, AD-7), agent-scoped (FR-7).
- **`pinned` is a hard protect** (a boolean column, migration `0017` — clean, no hand-edit) that the reflect prune excludes from its candidate set; deterministic, not fuzzy salience. Verified: the prune forgets an unpinned lowest-salience row but never a pinned one.
- **Curation routes:** `GET /memory/agents/:id` (view without the embedding, pinned-first sort), `PATCH /memory/agents/:id/:id` (edit content/summary/pinned — **re-embeds on content change**, best-effort so a LiteLLM outage doesn't fail the edit), `DELETE /memory/agents/:id/:id` (forget one, distinct from the bulk purge). All agent-scoped (a URL agentId mismatch ⇒ 404, another agent's row untouched — FR-7) + session-guarded.
- **The causal chain** on the run detail page joins client-side: **Recalled** = the run's `recall` transcript-event ids (8.3), **Learned** = memories with `sourceRunId === runId` (8.4), resolved via one best-effort `listAgentMemories` fetch — no new cross-repo backend route. If the fetch fails the card is simply omitted (never breaks the run view).
- **Privacy:** a memory can carry real user data; it's shown ONLY on its own agent's surface (agent-scoped, the 8.2 default). No cross-agent/all-agents view; no redaction (a deferred flag).
- **Verification:** `pnpm -r build` (8 workspaces) ✓, `pnpm lint` ✓, `svelte-check` 0 errors ✓, all unit suites green — control-api **213** (+7: 4 curation-route, 2 repo `updateMemory`/pinned, 1 prune-excludes-pinned). e2e via `deploy/test-stack.sh` (schema change, no contract bump): `0017` `pinned` column applies on a fresh DB; the memory page + link render (3/3 memory specs green). Dev stack restored, data intact.
- **Scope kept:** NO staged-approval / pending-memory gate, NO quarantine, NO learning-changelog / version diff (all 8.6); NO cross-agent view; NO redaction; NO retention/decay reaper.

### File List

- **Edited** `apps/control-api/src/db/schema.ts` — `pinned` boolean column on `agent_memories`.
- **New** `apps/control-api/drizzle/0017_dry_bulldozer.sql` (+ meta) — the `pinned` migration.
- **Edited** `apps/control-api/src/memory/repo.ts` (+ test) — `pinned` on `MemoryRow`/`toRow`/`createMemory`; `updateMemory` (interface + drizzle + fake).
- **Edited** `apps/control-api/src/memory/routes.ts` (+ test) — `memoryRoutes(repo, gateway)`; `view`/`parseMemoryEdit`; GET list / PATCH edit-pin / DELETE forget-one.
- **Edited** `apps/control-api/src/app.ts` — pass the gateway to `memoryRoutes`.
- **Edited** `apps/control-api/src/runs/orchestrator.ts` (+ `runs.test.ts`) — reflect insert `pinned:false`; prune excludes pinned.
- **Edited** `apps/web/src/lib/memory.ts` — `MemoryView` + `listAgentMemories`/`editMemory`/`setMemoryPinned`/`forgetMemory`.
- **New** `apps/web/src/routes/(app)/agents/[id]/memory/+page.svelte` — the per-agent memory list + curation surface.
- **Edited** `apps/web/src/routes/(app)/agents/[id]/+page.svelte` — the header "Memory" link.
- **Edited** `apps/web/src/routes/(app)/agents/[id]/runs/[runId]/+page.svelte` — the per-run Recalled/Learned causal-chain card.
- **Edited** `apps/web/tests/memory.spec.ts` — the Memory link + page e2e.

### Change Log

| Date | Version | Description |
|------|---------|-------------|
| 2026-08-05 | 0.1 | Story 8.5 implemented — per-agent memory list + per-run causal chain + pin/edit/forget curation; `pinned` column (0017); reflect prune protects pinned. Status → review. |
