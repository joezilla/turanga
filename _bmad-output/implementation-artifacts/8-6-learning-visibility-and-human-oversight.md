---
baseline_commit: 6e0504025e3b19ed25ea230349d7d182c3fb271d
---
# Story 8.6: Learning visibility + human oversight

Status: done

<!-- SIXTH + FINAL story of Epic 8 — the oversight CAPSTONE. 8.1–8.5 made an agent learn (reflect),
     recall, and be inspectable/curatable. This closes the epic's promise: a self-improving agent with
     real access must NOT silently drift. It adds (A) a memory `status` model (active | pending |
     quarantined) + optional STAGED APPROVAL (new memories held PENDING until the builder accepts them
     — the strong human-in-the-loop; also the 8.1–8.3 code-review W1 prompt-injection mitigation), (B) a
     per-agent LEARNING CHANGELOG (an append-only memory-events log: learned/reinforced/superseded/
     forgotten/accepted/rejected/quarantined) + inline recall attribution in the transcript, and (C)
     QUARANTINE (disable non-destructively — the A/B-comparable rollback seam Epic 10 evals gate on).
     control-api sole writer (AD-7); agent-scoped (FR-7). Large story — three coherent clusters. -->

## Story

As the builder,
I want to see what an agent learned and be able to gate it before it takes effect,
so that a self-improving agent with real access can't silently drift — I stay in the loop.

## Acceptance Criteria

1. **Given** a run that produced new memories, **when** reflection completes, **then** a legible **"here's what I learned"** surface shows the new memories in plain language (each with pin / edit / forget from 8.5); and an **optional staged-approval mode** — a **per-agent** `requireApproval` toggle + a **global** `requireApprovalDefault` (both default **off** = auto-apply) — holds new memories **`pending`** until the builder **accepts** (→ `active`) or **rejects** (→ deleted). A `pending` (or `quarantined`) memory is **never recalled** — only `active` memories are injected into a run. The effective requirement is resolved control-plane (`effectiveMemoryConfig`), the harness never decides (AD-7/AD-9). [Source: epics.md#Story-8.6 AC1, the 8.1–8.3 code-review W1 deferral]

2. **Given** an agent's memory over time, **when** it is viewed, **then** a per-agent **learning changelog** shows what was **learned / reinforced / superseded / forgotten / accepted / rejected / quarantined**, newest-first — the "git-log for the agent's mind" (each event carries a summary snapshot so it reads even after the memory is gone); and where a run **recalled** a memory, it is **attributed inline** in that run's transcript (the recall event, rendered — the auditable causality made visible). [Source: epics.md#Story-8.6 AC2, NFR-4]

3. **Given** a memory suspected of hurting performance, **when** the builder flags it, **then** it can be **quarantined** — set `status = 'quarantined'` (disabled non-destructively, excluded from recall, NOT deleted) and later **un-quarantined** (→ `active`) — so a learning regression is rolled back and A/B-comparable. This is the seam Epic 10 (evals) will gate on (an eval-driven auto-quarantine is Epic 10; this story ships the manual primitive). [Source: epics.md#Story-8.6 AC3, Epic-10 seam] control-api sole writer (AD-7); agent-scoped (FR-7).

## Tasks / Subtasks

### Cluster A — the status model + staged approval + quarantine (AC #1, #3)

- [x] **Task 1: Data model — status column, global default, the events table, domain config** (AC: #1, #2, #3)
  - [x] `apps/control-api/src/db/schema.ts` — (a) add `status: text("status").notNull().default("active")` to `agentMemories` (`schema.ts:147-173`); (b) add `requireApprovalDefault: boolean("require_approval_default").notNull().default(false)` to `memorySettings` (`:177-185`); (c) add a NEW `memoryEvents` table (mirror the `agent_memories` style): `id text pk`, `agentId text notNull`, `memoryId text` (nullable — a forgotten memory's row may be gone), `kind text notNull`, `summary text notNull default ''` (a snapshot so the log reads after deletion), `sourceRunId text`, `at timestamptz notNull defaultNow`, with `index("memory_events_agent_idx").on(t.agentId)`. Then `drizzle-kit generate` → `drizzle/0018_*.sql` (plain columns + a plain table generate cleanly — NO hand-edit).
  - [x] `packages/domain/src/index.ts` — add `MemoryStatus = "active" | "pending" | "quarantined"` + `MEMORY_STATUSES`; `MemoryEventKind = "learned" | "reinforced" | "superseded" | "forgotten" | "accepted" | "rejected" | "quarantined" | "unquarantined" | "edited" | "pinned" | "unpinned"`. Add `requireApproval: boolean` to `MemoryConfig` (`:163-168`) + `false` in `DEFAULT_MEMORY_CONFIG` (`:172`). Add `requireApprovalDefault: boolean` to `MemoryGlobalConfig` (`:176-182`) + `false` in `DEFAULT_MEMORY_GLOBAL_CONFIG` (`:184-190`). Extend `effectiveMemoryConfig` (`:195-207`) return type with `requireApproval: boolean` = `enabled && (global.requireApprovalDefault || perAgent.requireApproval)` (**OR semantics** — a global default is a platform-wide floor the operator can mandate; a per-agent can additionally opt in; `killSwitch` ⇒ everything off incl. requireApproval false). Update the domain test's `effectiveMemoryConfig` matrix + the `Agent` fixture.
  - [x] `apps/web/src/lib/agents.ts` — mirror (KEEP IN SYNC, `:37-38`): `requireApproval` on `MemoryConfig` (`:44-49`) + `DEFAULT_MEMORY_CONFIG` (`:50`); `requireApprovalDefault` on `MemoryGlobalConfig` (`:54-60`); the `requireApproval` field + logic in the web `effectiveMemoryConfig` (`:65-72`). Also add a web `MemoryStatus` type (or reuse a string literal) for the view.

- [x] **Task 2: Memory repo — status filter, status setter, the events log** (AC: #1, #2, #3)
  - [x] `apps/control-api/src/memory/repo.ts` — add `status: MemoryStatus` to `MemoryRow` (`:18-34`) + `toRow` (`:65-83`, `status: r.status as MemoryStatus`) + `createMemory` insert (`:108-124`, `status: row.status`) + the in-memory fake createMemory. Add `status` to the `updateMemory` patch type (`:55`) + both impls (`:186-194` drizzle, `:319-329` fake) so a status change persists.
  - [x] **The recall gate (critical):** add `eq(agentMemories.status, "active")` to the `recall` filters (drizzle `:134-138`) AND the fake candidate filter (`:274-280`, `&& r.status === "active"`). Also add the same active-filter to `findSimilar` (drizzle `:157-173` + fake `:296-310`) — dedupe/supersede consider only active memories. **A pending or quarantined memory is never recalled and never a dedupe target.**
  - [x] Add a `MemoryEventRow` type (`{ id, agentId, memoryId: string | null, kind: MemoryEventKind, summary: string, sourceRunId: string | null, at: string }`) + two `MemoryRepo` methods (interface + both impls): `logMemoryEvent(event: MemoryEventRow): Promise<void>` (append) and `listMemoryEvents(agentId: string, limit?: number): Promise<MemoryEventRow[]>` (newest-first, agent-scoped — FR-7). The fake uses an array.

- [x] **Task 3: Reflect — pending status + changelog events** (AC: #1, #2)
  - [x] `apps/control-api/src/runs/orchestrator.ts` `reflectRun` (`:212-282`): read `eff.requireApproval` from the gate resolve (`:217`). In the `createMemory` literal (`:249-266`) set `status: eff.requireApproval ? "pending" : "active"`, and after the insert `void memoryRepo.logMemoryEvent({ ..., kind: "learned", summary: m.summary, memoryId: mem.id, sourceRunId: run.id })` (fire-and-forget, still inside the fail-safe try). On the **dedupe-bump** branch (`:239-243`) log `kind: "reinforced"`. On the **supersede** call (`:245-248`) log `kind: "superseded"` (the stale memory's summary). In the **prune** loop (`:269-278`) log `kind: "forgotten"` per deleted memory (its summary). All events are best-effort (never affect the run — the whole function is already fail-safe). Consider excluding `pending`/`quarantined` from the prune candidate count (they aren't recalled; don't let them force out active ones) — filter the `all` count to active+pending? Keep simple: prune only `active` non-pinned (add `m.status === "active"` to the `!m.pinned` filter at `:271`).

- [x] **Task 4: Routes — accept / reject / quarantine / unquarantine / changelog** (AC: #1, #2, #3)
  - [x] `apps/control-api/src/memory/routes.ts` — add `status` to the `view()` projection (`:39-55`). Add routes (all under the session-guarded `/memory/*`, agent-scoped — resolve `getMemory(agentId,id)` → 404 if absent, then act + log an event via `repo.logMemoryEvent`):
    - `POST /memory/agents/:agentId/:id/accept` → `updateMemory(status:"active")` + log `accepted` (a no-op event if it wasn't pending is fine; or 400 if not pending — accept only pending).
    - `POST /memory/agents/:agentId/:id/quarantine` → `updateMemory(status:"quarantined")` + log `quarantined`.
    - `POST /memory/agents/:agentId/:id/unquarantine` → `updateMemory(status:"active")` + log `unquarantined`.
    - `GET /memory/agents/:agentId/events` → `listMemoryEvents(agentId, N)` → JSON `{ events: [...] }` (the changelog).
    - **Reject** reuses the existing `DELETE /memory/agents/:agentId/:id` (8.5) — extend it to log `rejected` when the memory was `pending`, else `forgotten`. The **edit** `PATCH` (8.5) logs `edited` (and `pinned`/`unpinned` when `pinned` changed). The **bulk purge** need not log per-memory (or logs one `forgotten` batch — keep it simple, skip).
  - [x] `apps/control-api/src/agents/routes.ts` `parseMemoryConfig` (`:145-163`) — validate + include `requireApproval` (boolean, mirror `recall`/`reflect` at `:150-151`). `apps/control-api/src/memory/routes.ts` `parseGlobalConfig` (`:13-35`) — validate + include `requireApprovalDefault` (boolean, mirror `defaultEnabled` at `:18-21`).

### Cluster B — the oversight config toggles + web client (AC #1)

- [x] **Task 5: Config toggles + the web memory client** (AC: #1, #3)
  - [x] `apps/web/src/lib/memory.ts` — add `status: MemoryStatus` to `MemoryView` (`:12-26`); a `MemoryEvent` type; client fns (mirror `forgetMemory`/`editMemory`, `encodeURIComponent` the params): `acceptMemory(agentId,id)` (POST …/accept), `quarantineMemory(agentId,id)` + `unquarantineMemory(agentId,id)`, `rejectMemory(agentId,id)` (thin wrapper over the existing `forgetMemory` DELETE — a reject of a pending IS a delete), and `listMemoryChangelog(agentId): Promise<Result<MemoryEvent[]>>` (GET …/events, unwrap `{ events }`).
  - [x] `apps/web/src/routes/(app)/settings/memory/+page.svelte` — add a **"Require approval before new memories take effect"** switch card (mirror the "New agents remember by default" card at `:99-108`, `checked={cfg.requireApprovalDefault}` → `patch({ requireApprovalDefault })`).
  - [x] `apps/web/src/lib/components/AgentMemoryTab.svelte` — add a per-agent **"Require my approval before this agent's new memories take effect"** checkbox in the "What it does" section (`:99-120`, mirror the recall/reflect flags → `onchange({ ...value, requireApproval })`); show the effective note when the global default forces it on.

### Cluster C — the visibility surfaces (AC #1, #2)

- [x] **Task 6: Pending review + quarantine + changelog + inline attribution** (AC: #1, #2, #3)
  - [x] `apps/web/src/routes/(app)/agents/[id]/memory/+page.svelte` (8.5) — (a) a **"Pending review"** section ABOVE the main list showing `memories.filter(m => m.status === "pending")` with **Accept** (`acceptMemory` → reload) + **Reject** (`rejectMemory` → reload) per row; (b) a **quarantined** indicator (mirror the `.superseded` treatment) + a **Quarantine**/**Un-quarantine** action in the per-row button group; the main list groups/labels by status (active vs quarantined); (c) a **Changelog** surface (a section or a small toggle) rendering `listMemoryChangelog(id)` newest-first — each row: the event kind (a labeled dot/word, NFR-6), the summary snapshot, the time (`formatTimestamp`), and a source-run link when set.
  - [x] `apps/web/src/routes/(app)/agents/[id]/runs/[runId]/+page.svelte` (8.5) — in the **Learned** list of the causal-chain card (`:110-117`), when a learned memory is `status === "pending"`, show **Accept**/**Reject** inline (the "here's what I learned" gate right on the run that produced it).
  - [x] `apps/web/src/lib/components/RunTranscript.svelte` — add a `{:else if msg.type === "recall"}` branch (`:22-48`) that attributes the recall **inline**: a subtle "↺ Recalled N memories" line. To show the recalled *summaries* inline (not just the count), add an optional `memoryById?: Map<string, { summary: string }>` prop and, when provided (the run-detail page passes it from its already-fetched `memories`), list the summaries; otherwise show the count. Never colour-only (a `Circle`/icon + word, NFR-6/UX-DR11).

- [x] **Task 7: Tests + verification** (AC: all)
  - [x] **domain unit** — `effectiveMemoryConfig` resolves `requireApproval` (off by default; global default OR per-agent; killSwitch ⇒ false).
  - [x] **control-api unit** (`memory/repo.test.ts`): `recall` + `findSimilar` EXCLUDE `pending` and `quarantined` (only `active` is recalled/deduped — assert a pending + a quarantined seed are never returned); `updateMemory({status})` persists (agent-scoped); `logMemoryEvent`/`listMemoryEvents` round-trip newest-first, agent-scoped (FR-7). Fresh memory `status:'active'` by default.
  - [x] **control-api unit** (`runs/runs.test.ts`): with `requireApproval` on, a reflect-written memory is `pending` (assert it's NOT recalled by a follow-up run until accepted); with it off, `active` (the 8.4 closed loop still works). Reflect logs `learned`/`superseded`/`forgotten` events (assert via `listMemoryEvents`). Prune skips pending.
  - [x] **control-api unit** (`memory/routes.test.ts` + `agents/agents.test.ts`): accept (pending→active + `accepted` event), reject (delete + `rejected` event), quarantine/unquarantine (status + events), `GET …/events` returns the changelog, `status` is in the view; `parseMemoryConfig`/`parseGlobalConfig` accept + validate `requireApproval`/`requireApprovalDefault`; all agent-scoped + session-guarded.
  - [x] **web** — `svelte-check` clean; a Playwright spec (extend `memory.spec.ts`): the Settings + agent-tab approval toggles persist; (best-effort, config-only) the memory page shows the Pending-review + Changelog sections' empty states for a fresh agent; the run-detail + transcript render without error. (Seeded pending/quarantine flows are unit-covered — no model provider in the isolated stack.)
  - [x] `pnpm -r build` (8 workspaces) · `pnpm lint` · `svelte-check` · all unit suites green · **e2e via `deploy/test-stack.sh`** — rebuild images (schema change `0018`; NO contract bump). Prove `0018` applies (status column + `memory_events` table + `require_approval_default`). **Never `down -v` the dev stack**; `pnpm -r build` before any Docker build; restore + verify dev data. See [[turanga-e2e-clean-run]].

## Dev Notes

**The oversight capstone — keep the human in the loop.** Epic 8's promise is a self-improving agent you can TRUST with real access. 8.4 made it learn; the code-review flagged (W1) that recalled memory becomes system-context and could carry drift/poisoning. This lands the strong mitigation: **staged approval** (nothing takes effect until you accept), plus the visibility (**changelog** + **inline attribution**) and the rollback (**quarantine**) that make drift legible + reversible. It's large but cohesive — three clusters (status/approval/quarantine · config toggles · surfaces).

### The status model (the spine of this story)
- **`status: active | pending | quarantined`** on every memory. `active` is the only recall-eligible state — the `recall` (and `findSimilar`) query filters `status='active'`. This one filter makes both **pending** (staged-approval) and **quarantined** (rollback) work: a memory in either state exists, is visible + curatable, but is NEVER injected into a run.
- **pending** ← reflect writes it when `effectiveMemoryConfig(...).requireApproval`; **accept** → active, **reject** → deleted.
- **quarantined** ← a manual curation action (Epic 10 will drive it from evals); **unquarantine** → active. Non-destructive (the row + its embedding survive), so it's A/B-comparable.
- `pinned` (8.5) is orthogonal — prune-protection, not recall-eligibility.

### Config resolution (requireApproval)
`effectiveMemoryConfig` gains `requireApproval = enabled && (global.requireApprovalDefault || perAgent.requireApproval)` — **OR**: the operator can mandate approval platform-wide (a floor); an agent can opt in on top. Default both false ⇒ off ⇒ auto-apply (the loop behaves exactly as 8.4 today). `killSwitch` ⇒ everything off. This is the same pure resolver 8.3/8.4 already gate on; reflect reads `.requireApproval` the same way it reads `.reflect`. The harness never decides (AD-7/AD-9).

### The learning changelog (`memory_events`)
An **append-only** log (control-api sole writer, AD-7; agent-scoped, FR-7). Each event snapshots the memory `summary` at event time, so the changelog reads even after the memory is `forgotten`/`rejected` (its row is gone). Written best-effort from `reflectRun` (learned/reinforced/superseded/forgotten) + the curation routes (accepted/rejected/quarantined/unquarantined/edited/pinned). It's the "git-log for the agent's mind" — the drift audit. NOT a full diff engine; just the event stream.

### Inline recall attribution
The `recall` transcript event (8.3, `{ memoryIds, count }`) is currently ignored by `RunTranscript`. This renders it — the auditable causality made visible in the run's own stream (the epic notes it lands in Epic 9 chat too). The event carries only ids; to show summaries inline, the run-detail page passes its already-fetched `memories` as a `memoryById` map into `RunTranscript` (optional prop — the count alone renders without it).

### Architecture (binding)
- **AD-7 — control-api sole writer.** All status changes + every changelog event go through `memoryRoutes`/`reflectRun` → `MemoryRepo`. The harness/sandbox never touch status or events.
- **AD-9 / AD-7 — the harness never decides.** `requireApproval` is resolved control-plane; a pending memory is simply never in the recall result the orchestrator injects.
- **FR-7 — agent-scoped.** Status routes, `logMemoryEvent`/`listMemoryEvents`, and the changelog are all `agentId`-keyed. No cross-agent event or status change.
- **W1 mitigation.** Staged approval is the strong human-in-the-loop the code-review deferral asked for; combined with 8.4's neutral distillation + the 8.4 harness framing, drift/poisoning is gated + visible + reversible.

### Existing patterns to mirror (file:line — post-8.5)
- **Domain config + resolver:** `packages/domain/src/index.ts:163-207` (`MemoryConfig`/`MemoryGlobalConfig`/`effectiveMemoryConfig`) + the web mirror `apps/web/src/lib/agents.ts:44-72`.
- **Migration:** `drizzle/0017_dry_bulldozer.sql` (the `pinned` ALTER — the model for the `status` + `require_approval_default` ALTERs); `0015_even_dormammu.sql` (the model for a new table — `memory_events`). `db/migrate.ts:7-12`.
- **Repo field + method + fake parity:** `repo.ts` `pinned`/`updateMemory` (8.5) → `status`/`logMemoryEvent`/`listMemoryEvents`; the `recall` filter array (`:134-138`) + fake (`:274-280`) get the active filter.
- **Reflect:** `orchestrator.ts:212-282` (`reflectRun`) — the insert literal (`:249-266`), the supersede (`:245-248`), the prune (`:269-278`).
- **Routes:** `memory/routes.ts` (the 8.5 curation routes + `view()` + `parseMemoryEdit`) → accept/reject/quarantine/changelog; validators `agents/routes.ts:145-163` + `memory/routes.ts:13-35`.
- **UIs:** the Settings switch card (`settings/memory/+page.svelte:99-108`), the AgentMemoryTab flag (`AgentMemoryTab.svelte:102-115`), the memory page rows + `.superseded` treatment (`agents/[id]/memory/+page.svelte`), the run-detail Learned card (`runs/[runId]/+page.svelte:110-117`), the transcript chain (`RunTranscript.svelte:22-48`).

### Project Structure Notes
- **New:** `drizzle/0018_*.sql` (+ meta). **Edited (backend):** `db/schema.ts`, `packages/domain/src/index.ts` (+ test), `memory/repo.ts` (+ test), `runs/orchestrator.ts` (+ `runs.test.ts`), `memory/routes.ts` (+ test), `agents/routes.ts` (+ `agents.test.ts`), `app.ts` (no change — routes already mounted). **Edited (web):** `lib/agents.ts`, `lib/memory.ts`, `settings/memory/+page.svelte`, `AgentMemoryTab.svelte`, `agents/[id]/memory/+page.svelte`, `runs/[runId]/+page.svelte`, `RunTranscript.svelte`, `agents/[id]/+page.svelte` (the `globalMemory` default gains `requireApprovalDefault`), `tests/memory.spec.ts`.
- **No change:** `packages/contracts` (NO `CONTRACT_VERSION` bump — the recall event already exists; the changelog is a control-plane read, not a wire type). No new npm dep.
- **Scope guard:** NO eval-driven auto-quarantine (Epic 10 — this ships the manual primitive + the seam), NO chat integration (Epic 9), NO memory diff/versioning beyond the event log, NO redaction/PII, NO shared-per-builder scope, NO retention/decay reaper. This is: status model + staged approval + quarantine + the changelog + inline attribution.

### Testing standards
- Vitest: the domain resolver (requireApproval), the repo (active-only recall/findSimilar, updateMemory status, events log — agent-scoped), reflect (pending vs active, events written, prune skips pending), the routes (accept/reject/quarantine/unquarantine/changelog, `status` in view, validators, session-guard + FR-7). `svelte-check` for the web. Playwright (config-only) for the approval toggles + the empty-state surfaces. Full verification: `pnpm -r build`, `pnpm lint`, `deploy/test-stack.sh` e2e proving `0018` applies; never `down -v` the dev stack.

### References
- [Source: epics.md#Epic-8 (oversight; "gate it before it takes effect"; the learning changelog; quarantine as the Epic 10 seam) + #Story-8.6]
- [Source: 8.1–8.3 code-review W1 (deferred) — staged approval is the strong human-in-the-loop mitigation this lands]
- [Source: 8-4-reflect (the writer this gates + the events it logs) + 8-5-memory (the curation surface + status/`pinned` split this extends)]
- [Source: architecture spine #AD-7 (sole writer), #AD-9 (harness never decides), #FR-7 (agent-scoped), #NFR-4 (auditable), #NFR-6 + UX-DR11 (dot + word)]
- [Source: [[turanga-e2e-clean-run]] — reset for pristine; never `down -v` the dev stack; warm Vite]

## Dev Agent Record

### Agent Model Used

claude-opus-4-8 (Claude Opus 4.8)

### Debug Log References

- **Two same-millisecond changelog events** — `routes.test.ts` initially asserted the exact newest-first order of two curation events (quarantine→unquarantine, reject→forget) fired back-to-back. Their `at` timestamps collided within the millisecond, making the tiebreaker (id desc) non-deterministic across runs. Fixed by asserting membership (`.sort()`), keeping the explicit-timestamp changelog ordering assertions in the dedicated newest-first tests.
- **Changelog gated behind the memories-empty branch** — the "Learning history" section was first placed inside the memory page's `{:else}` (memories.length > 0) block, so a fresh agent (0 memories, empty-state branch) never rendered it. Moved it out to render whenever the page loaded ok — the history outlives the memories it records (rejected/forgotten memories leave a log but no row). This is what the config-only e2e test exercises.
- **e2e DB name** — the app schema lives in the `control` database (not `turanga`); verified `0018` applied there (status column + `memory_events` table + `require_approval_default`).

### Completion Notes List

- **The status model is the spine.** `status: active | pending | quarantined` on every memory; `active` is the only recall-eligible state. One `eq(status, "active")` filter on both `recall` and `findSimilar` makes staged-approval (`pending`) AND quarantine (rollback) work — a memory in either non-active state exists, is visible + curatable, but is never injected into a run and never a dedupe target.
- **`requireApproval` OR-semantics.** `effectiveMemoryConfig` gains `requireApproval = enabled && (global.requireApprovalDefault || perAgent.requireApproval)` — the operator can mandate approval platform-wide (a floor); an agent can opt in on top. Both default false ⇒ auto-apply (8.4's loop unchanged). `killSwitch` ⇒ everything off. Resolved control-plane; the harness never decides (AD-7/AD-9).
- **The learning changelog (`memory_events`)** is append-only (control-api sole writer, AD-7; agent-scoped, FR-7). Each event snapshots the memory `summary` so the log reads even after the memory is forgotten/rejected. Written best-effort from `reflectRun` (learned/reinforced/superseded/forgotten) + the curation routes (accepted/rejected/quarantined/unquarantined/edited/pinned). Never blocks a curation action.
- **Prune skips pending** — the reflect prune candidate filter is `!pinned && status === "active"`, so a pending memory is never force-forgotten to make budget room (unit-covered).
- **Inline recall attribution** — `RunTranscript` renders the `recall` transcript event (previously ignored); run-detail passes an `id→{kind,summary}` map so the recalled memories are named inline, not just counted (falls back to the count when the map is absent).
- **NO CONTRACT_VERSION bump** — the recall event already exists on the wire (8.3); the changelog is a control-plane read.
- **Verification:** domain 5, control-api 226 (+13 new: repo status-filter/events, routes oversight, reflect pending/prune), svelte-check clean, `pnpm -r build` + `pnpm lint` clean, memory.spec 6/6 (incl. 3 new 8.6 config-only e2e) on the isolated `turanga-e2e` stack with `0018` applied cleanly. Dev stack restored, 2 agents intact.

### File List

**New**
- `apps/control-api/drizzle/0018_fair_silver_centurion.sql` (+ `drizzle/meta` snapshot)

**Edited — backend**
- `apps/control-api/src/db/schema.ts` — `status` on `agentMemories`, `requireApprovalDefault` on `memorySettings`, new `memoryEvents` table + agent index
- `packages/domain/src/index.ts` — `MemoryStatus`/`MEMORY_STATUSES`, `MemoryEventKind`, `requireApproval`, `requireApprovalDefault`, `effectiveMemoryConfig` OR-semantics
- `packages/domain/src/index.test.ts` — matrix + requireApproval OR-semantics test
- `apps/control-api/src/memory/repo.ts` — `MemoryRow.status`, `MemoryEventRow`, active-only recall/findSimilar, `updateMemory` status, `logMemoryEvent`/`listMemoryEvents`, `requireApprovalDefault` in config
- `apps/control-api/src/memory/repo.test.ts` — status-filter + changelog tests
- `apps/control-api/src/runs/orchestrator.ts` — pending status on reflect, learned/reinforced/superseded/forgotten events, prune skips pending
- `apps/control-api/src/runs/runs.test.ts` — reflect-under-require-approval tests (pending vs active, events, prune skips pending)
- `apps/control-api/src/memory/routes.ts` — `status` in view, accept/quarantine/unquarantine routes, reject/forgotten logging, changelog GET, `requireApprovalDefault` validator
- `apps/control-api/src/memory/routes.test.ts` — oversight route + validator tests
- `apps/control-api/src/agents/routes.ts` — `requireApproval` in `parseMemoryConfig`
- `apps/control-api/src/agents/agents.test.ts` — `requireApproval` in memoryConfig assertions

**Edited — web**
- `apps/web/src/lib/agents.ts` — mirrored `MemoryStatus`, `MemoryEventKind`, `requireApproval`, `requireApprovalDefault`, `effectiveMemoryConfig`
- `apps/web/src/lib/memory.ts` — `MemoryView.status`, `MemoryEvent`, accept/reject/quarantine/unquarantine/listMemoryChangelog clients
- `apps/web/src/routes/(app)/settings/memory/+page.svelte` — require-approval-by-default switch card
- `apps/web/src/lib/components/AgentMemoryTab.svelte` — per-agent "Require my approval" checkbox
- `apps/web/src/routes/(app)/agents/[id]/+page.svelte` — `requireApprovalDefault` in the `globalMemory` default
- `apps/web/src/routes/(app)/agents/[id]/memory/+page.svelte` — pending-review section, quarantine action + indicator, learning-history changelog
- `apps/web/src/routes/(app)/agents/[id]/runs/[runId]/+page.svelte` — accept/reject on pending learned memories, `memoryById` for the transcript
- `apps/web/src/lib/components/RunTranscript.svelte` — `recall` attribution branch + optional `memoryById` prop
- `apps/web/tests/memory.spec.ts` — 3 new 8.6 config-only e2e tests

### Change Log

| Date | Version | Description |
|------|---------|-------------|
| 2026-08-05 | 0.1 | Story 8.6 implemented — the oversight capstone: status model (active/pending/quarantined), staged approval (per-agent + global `requireApproval`), the `memory_events` learning changelog, quarantine/unquarantine, and inline recall attribution. Migration 0018. No contract bump. Status → review. |
| 2026-08-05 | 0.2 | Code review of 8.4–8.6 (Blind Hunter + Edge Case Hunter + Acceptance Auditor): no High findings — security spine confirmed. Applied 7 patches: deferred supersede to accept-time (no recall gap under requireApproval; shared `memory/tuning.ts`), quarantine active-only (staged-approval bypass closed), prune budget over the active set (non-active rows no longer force-evict), per-item embed fail-safe, changelog error-retry, independent edited-vs-pin changelog events, and recall "N no longer present" attribution. 4 deferred (ULID intra-ms ordering, cross-builder tenancy, concurrent-reflect RMW, single-neighbor supersede) → deferred-work.md. Status → done. |

## Review Findings

_Code review of stories 8.4–8.6 (`5a4cec9..f0e8c90`), 2026-08-05 — Blind Hunter + Edge Case Hunter + Acceptance Auditor. No High findings: all three reviewers independently confirmed the security spine holds (active-only recall/findSimilar gate, no-secret-in-sandbox AD-10, control-plane `requireApproval` resolution AD-7/AD-9, fail-safe non-awaited reflect, no CONTRACT_VERSION bump). Findings below are Medium/Low correctness + robustness._

- [x] [Review][Decision→Patch] **Supersede + require-approval opens a recall gap** — RESOLVED (user chose: defer supersede to accept-time). Reflect now skips the supersede while the new memory is `pending` (leaving the stale fact recallable); the `/accept` route runs the supersede at approval-time (the accepted memory carries a stored embedding and, while still pending, is excluded from `findSimilar`'s active-only set, so it can't match itself). The active path also switched to lookup-before-insert then supersede-after-insert, so a failed insert can never orphan the prior fact. Shared `SUPERSEDE_MAX_DISTANCE` extracted to `memory/tuning.ts`. [orchestrator.ts reflectRun + memory/routes.ts accept]

- [x] [Review][Patch] **Quarantine accepts a `pending` memory → unquarantine promotes it to active, bypassing staged approval** — FIXED: quarantine from-set = `["active"]`; a pending memory can only reach active via `/accept`. Test added (quarantine-of-pending → 400). [apps/control-api/src/memory/routes.ts]

- [x] [Review][Patch] **Prune budget counts non-active rows, so pending/quarantined accumulation force-evicts the ACTIVE working set** — FIXED: the budget is measured over the ACTIVE set (non-active rows uncounted); pinned rows count toward the budget but are never candidates. An unreviewed pending backlog / accumulating quarantine no longer evicts active memories. [apps/control-api/src/runs/orchestrator.ts]

- [x] [Review][Patch] **Embedding failure mid-batch aborts remaining distilled memories AND skips the prune** — FIXED: each distilled item is wrapped in its own try/catch, so one bad embed skips only that item; the batch + prune continue. [apps/control-api/src/runs/orchestrator.ts]

- [x] [Review][Patch] **"Learning history" changelog never refetches after a failed load** — FIXED: `toggleChangelog` retries from the `"error"` state, and the error branch now shows a Retry button (shared `loadChangelog`). [apps/web/src/routes/(app)/agents/[id]/memory/+page.svelte]

- [x] [Review][Patch] **A combined content+pin PATCH drops the `edited` changelog event** — FIXED: the pin and edited logs are independent `if`s, so a PATCH that both re-writes content and flips the pin records both. [apps/control-api/src/memory/routes.ts]

- [x] [Review][Patch] **Recall attribution resolves against LIVE memory — count and named list can disagree** — FIXED: the recall row surfaces "N no longer present" for memories that no longer resolve, so the count and the named list reconcile visibly. [apps/web/src/lib/components/RunTranscript.svelte]

- [x] [Review][Defer] **Same-millisecond changelog events sort non-deterministically** — `ulid()` uses a `Math.random()` suffix (not monotonic); `listMemoryEvents` orders `desc(at), desc(id)`, so events minted in the same ms within one reflect pass (superseded/learned/reinforced) display in arbitrary order. [packages/domain/src/index.ts ulid + repo.ts listMemoryEvents] — deferred, shared-infra change (monotonic ULID factory).
- [x] [Review][Defer] **No cross-builder ownership check on memory routes** — routes read `agentId` from the URL with only `requireSession`; any authenticated operator can read/curate another's memories + full content. [apps/control-api/src/memory/routes.ts] — deferred, pre-existing: identical to `/agents`, `/runs`, `/connections` (platform is single-operator/all-trusted in pre-alpha; a real tenancy model is a cross-cutting epic).
- [x] [Review][Defer] **Concurrent reflect runs for one agent are an unguarded read-modify-write** — dedupe/insert/prune are separate awaited calls with no transaction/row-lock on Postgres; two near-simultaneous runs can both insert a near-dup or over-prune. [apps/control-api/src/runs/orchestrator.ts reflectRun] — deferred, pre-existing (8.4); in-memory path is single-threaded-safe.
- [x] [Review][Defer] **Supersede inspects only the single nearest neighbor's topic** — `findSimilar` returns one row; a same-topic stale fact shadowed by a closer different-topic memory is never superseded, so contradictory facts co-accumulate. [apps/control-api/src/runs/orchestrator.ts:252-256] — deferred, pre-existing 8.4 dedupe design (top-N-within-distance is a follow-up).
