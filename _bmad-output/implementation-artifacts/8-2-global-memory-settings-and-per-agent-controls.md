---
baseline_commit: c9ecf1850a7dc78220f28d0e63d43695f20dc2df
---
# Story 8.2: Global memory settings + per-agent memory controls

Status: review

<!-- SECOND story of Epic 8 (Agent memory — the self-improving loop). Story 8.1 landed the MODEL +
     pgvector store + the pure `effectiveMemoryConfig` resolver + the memory repo (get/set global +
     per-agent config), all OFF BY DEFAULT with NO surface to change it. This story builds the SURFACE:
     a Settings → Memory global-defaults screen, a per-agent Memory section in the agent editor, and the
     control-api wiring (routes + PATCH validation) that persists both — control-api the sole writer
     (AD-7). Recall (8.3) and reflect (8.4) — the code that READS the config in the run path — come next;
     this story makes the decision configurable + governed, not yet acted upon. -->

## Story

As the builder,
I want a global memory settings screen and a per-agent memory toggle,
so that I decide — per agent, and by default — whether an agent remembers, what it remembers, and whether it recalls, reflects, or both.

## Acceptance Criteria

1. **Given** Settings → Memory (a new surface alongside Model providers / Data connections / Tools), **when** it is used, **then** the operator sets the **global defaults** — the memory on/off default for new agents (`defaultEnabled`), a global **kill switch** (`killSwitch`, master-off that overrides every agent), the retention/decay policy (`retentionDays`, blank = keep indefinitely), and sees the embedding model + the agent-scoped privacy posture — and **control-api is the sole writer** (AD-7); the current state renders as a dot + word (NFR-6, never colour-only — UX-DR11). [Source: epics.md#Story-8.2 AC1, AD-7, NFR-6]

2. **Given** the agent-definition surface, **when** the new **Memory** section (a tab next to Tools) is used, **then** the builder sets this agent's memory to `inherit` (the global default), `on`, or `off`; independently toggles **recall** and **reflect**; and selects which memory **kinds** apply (episodic / semantic / procedure) — saved via the existing explicit **Save draft** through `PATCH /agents/:id` (control-api validates + is the sole writer, AD-7); the section shows the **effective** result ("memory is effectively off — the global default is off") so the three-level resolution is legible. [Source: epics.md#Story-8.2 AC2, FR-3 default-deny posture, AD-7]

3. **Given** the toggles, **when** they are saved, **then** the effective config is the server-authoritative `effectiveMemoryConfig(global, perAgent)` resolution (the single rule the run path will gate on in 8.3/8.4 — the harness never decides, AD-7/AD-9); a per-agent memory config that is invalid (bad `mode`, non-boolean flags, unknown `kind`) is **rejected 400**; and disabling an agent's memory offers an explicit, opt-in **"Forget all memories"** purge (control-api sole writer) that removes that agent's memories and no other's (FR-7). [Source: epics.md#Story-8.2 AC3, AD-7/AD-9, FR-7]

## Tasks / Subtasks

- [x] **Task 1: Global memory settings — control-api routes, web client, Settings → Memory page** (AC: #1)
  - [x] **NEW** `apps/control-api/src/memory/routes.ts` — `export function memoryRoutes(repo: MemoryRepo)` returning a `Hono()` (mirror `apps/control-api/src/tools/routes.ts:26,75`):
    - `GET /memory/config` → `c.json(await repo.getGlobalConfig())` (returns `DEFAULT_MEMORY_GLOBAL_CONFIG` when unset — no write-on-read; the OFF default is the seed).
    - `PATCH /memory/config` → parse the body with a `parseGlobalConfig(input)` validator (`{ ok: true, value } | { ok: false, error }`, mirroring `parseCostCap` at `agents/routes.ts:50-58`): `defaultEnabled`/`killSwitch` must be booleans if present; `retentionDays` must be `null` or a positive integer if present; **`embeddingModel` and `privacy` are read-only in this story** — ignore/reject attempts to change them (the embedding dimension is fixed at 1536 for `text-embedding-3-small`; changing the model needs a migration + re-embed — see Dev Notes; `privacy` has one value, `agent-scoped`). On success `c.json(await repo.setGlobalConfig(patch))` (the repo upsert accepts a `Partial<MemoryGlobalConfig>`, `memory/repo.ts:44`); on validation failure `c.json({ error }, 400)`.
  - [x] `apps/control-api/src/app.ts` — session-guard + mount: add `app.use("/memory", requireSession(authRepo)); app.use("/memory/*", requireSession(authRepo));` (next to the `/tools` guards at `app.ts:71-72`) and `app.route("/", memoryRoutes(memoryRepo));` (memoryRepo already constructed at `app.ts:83`). No `server.ts` change (repo already wired there in 8.1).
  - [x] **NEW** `apps/web/src/lib/memory.ts` — mirror `apps/web/src/lib/tools.ts` (the `base`/`Result<T>`/`req<T>()` head at `tools.ts:4,28-39`, `credentials: "include"`): export `getMemoryConfig(): Promise<Result<MemoryGlobalConfig>>` (GET `/memory/config`, unwrap the object) and `setMemoryConfig(patch: Partial<MemoryGlobalConfig>): Promise<Result<MemoryGlobalConfig>>` (PATCH, `content-type: application/json`, `JSON.stringify(patch)`). Re-export the `MemoryGlobalConfig` type from `@turanga/domain`.
  - [x] `apps/web/src/routes/(app)/settings/+layout.svelte` — add a fourth nav item to the `items` array (`settings/+layout.svelte:13-30`): `{ href: "/settings/memory", label: "Memory", blurb: "What your agents remember — the default for new agents, retention, and a master kill switch." }`. The layout supplies the heading/breadcrumb/blurb from the matched item, so the page renders body only.
  - [x] **NEW** `apps/web/src/routes/(app)/settings/memory/+page.svelte` — mirror `settings/connections/+page.svelte` (a read-config-then-edit page; the `$effect(() => { load(); })` + `async load()` shape at `tools/+page.svelte:21-34`). Render: a **"New agents remember by default"** toggle (`defaultEnabled`), a **kill switch** ("Disable memory for all agents"), a **retention** input ("Forget memories older than N days" — blank = keep indefinitely, maps to `retentionDays: null`), and a read-only line for the **embedding model** + **privacy = agent-scoped**. Each change calls `setMemoryConfig({...})` and adopts the returned config (server-authoritative). Show the current platform state as a **dot + word** (mirror the inline `Circle` + `dotColor()` pattern at `settings/tools/+page.svelte:65-67,113-116`) — e.g. `● Memory on for new agents` / `● Kill switch active` — word always visible (NFR-6/UX-DR11).
  - [x] Optional (only if `/settings` doesn't already 307 correctly): confirm `settings/+page.ts` redirect still points at `providers` (no change needed — Memory is just a new sibling).

- [x] **Task 2: Per-agent memory controls — PATCH validation + the agent-editor Memory tab** (AC: #2, #3)
  - [x] `apps/control-api/src/agents/routes.ts` — add a `parseMemoryConfig(input): { ok: true; value: MemoryConfig } | { ok: false; error: string }` validator (mirror `parseSkills`/`parseTools` at `:84-140`): require `mode ∈ {"inherit","on","off"}`, `recall`/`reflect` booleans, `kinds` an array ⊆ `MEMORY_KINDS` (dedupe, reject unknowns). In the PATCH handler (`:165-244`): add `memoryConfig?: unknown` to the body destructure (`:166-175`) and a parse+apply block mirroring `costCap` (`:233-237`): `if (body.memoryConfig !== undefined) { const parsed = parseMemoryConfig(body.memoryConfig); if (!parsed.ok) return c.json({ error: parsed.error }, 400); patch.memoryConfig = parsed.value; }`.
  - [x] `apps/control-api/src/agents/repo.ts` — `AgentPatch` interface (`:55-65`) gains `memoryConfig?: MemoryConfig;`; `applyPatch` (`:130-143`) gains `...(patch.memoryConfig !== undefined ? { memoryConfig: patch.memoryConfig } : {})`; the drizzle `update()` (`:194-204`) gains `if (patch.memoryConfig !== undefined) set.memoryConfig = patch.memoryConfig;`. **`memoryConfig` stays OUT of `PUBLISHED_FIELDS`/`snapshotOf`/`diffFields`** — it is operational config (like `state`); editing + saving it must NOT set `dirty` or appear in `changedFields` (verified in 8.1; keep it that way).
  - [x] **NEW** `apps/web/src/lib/components/AgentMemoryTab.svelte` — a **controlled** component mirroring `AgentToolsTab.svelte` (props `{ value: MemoryConfig, effective: {...}, onchange: (next: MemoryConfig) => void }`; it never saves — the parent's `save()` PATCHes). Renders: a `mode` segmented control (`inherit` / `on` / `off`); `recall` + `reflect` toggles (independent); a `kinds` checkbox group over `MEMORY_KINDS`; and an **effective-state line** computed from `effectiveMemoryConfig(global, value)` — e.g. "Effectively **off** — the global default is off. Turn this agent **on** to override." Recall/reflect/kinds controls are visible but visually **de-emphasised/disabled when the agent is effectively off** (they still persist, but the copy makes clear they're inert until enabled). On any change → `onchange(next)`.
  - [x] `apps/web/src/routes/(app)/agents/[id]/+page.svelte` — wire the tab:
    - `Tab` union (`:67`) gains `"memory"`; the `tabs` array (`:148-153`) gains `{ key: "memory", label: "Memory", count: null }`; the tab-body switch (`:496-614`) gains `{:else if tab === "memory"}` rendering `<AgentMemoryTab value={memoryConfig} effective={...} onchange={(next) => (memoryConfig = next)} />` (parallel to the Tools branch at `:573`).
    - Local editable state: add `let memoryConfig = $state<MemoryConfig>(DEFAULT_MEMORY_CONFIG)` (with the others at `:58-65`); seed `memoryConfig = { ...a.memoryConfig, kinds: [...a.memoryConfig.kinds] }` in `seed()` (`:85-94`).
    - Dirty tracking: in `unsavedFields` (`:112-124`) add `if (stable(memoryConfig) !== stable(agent.memoryConfig)) out.push("memoryConfig");` (**use `stable()`** — `MemoryConfig` is an object + an array; raw `JSON.stringify` would false-positive on key/opaque re-ordering, the exact bug fixed for `costCap` in 52f1c84). Add `memoryConfig: "Memory"` to `FIELD_LABEL` (`:128-137`).
    - Per-tab unsaved dot: the tab change-dot currently keys off `FIELD_TAB` (`agents.ts:175-184`, typed `Record<PublishedField, …>`) — but `memoryConfig` is **not** a `PublishedField`. Handle the Memory tab's unsaved dot from the `unsavedFields` list directly (widen the tab-dot predicate to also light `memory` when `unsavedFields` includes `"memoryConfig"`), without adding `memoryConfig` to `PublishedField`.
    - Save: add `memoryConfig` to the `AgentPatch` object built in `save()` (`:246-255`), so the single explicit Save draft persists it via `updateAgent(target, patch)`.
    - Load the global config once (for the effective-state copy) via `getMemoryConfig()` from `$lib/memory` (or pass a sensible default if the fetch fails — the copy is advisory, not a gate).
  - [x] `apps/web/src/lib/agents.ts` — ensure the web `Agent` type carries `memoryConfig: MemoryConfig` (control-api already returns it on the AgentView since 8.1; the web type must include it so `seed()`/`unsavedFields` compile). Re-export `MemoryConfig`, `MEMORY_KINDS`, `DEFAULT_MEMORY_CONFIG`, `effectiveMemoryConfig` from `@turanga/domain` where the editor imports them.

- [x] **Task 3: Enforcement posture + the opt-in purge** (AC: #3)
  - [x] The **effective config is server-authoritative**: `effectiveMemoryConfig` (domain, 8.1) is the one rule; the Settings + editor UIs read it for their copy, and **8.3 (recall) / 8.4 (reflect) gate the run path on it** — the orchestrator's recall/reflect steps do not exist yet, so this story does NOT add run-path branching (no speculative dead code). Document in Dev Notes that AC3's "orchestrator skips recall/reflect" is realized where those steps land, reading the config this story makes configurable. **No change to `orchestrator.ts` in this story.**
  - [x] **Purge (opt-in):** add `DELETE /memory/agents/:agentId` to `memoryRoutes` — resolve the agent's memories via `repo.listForAgent(agentId)` and `repo.deleteMemory(agentId, id)` for each (agent-scoped — never touches another agent's rows, FR-7); return `c.json({ purged: n })`. In `AgentMemoryTab.svelte`, when the agent is being set to `off` (or via an explicit "Forget all memories" button), offer the purge as a **confirmed, opt-in** action (destructive → a confirm step), calling a new `purgeAgentMemory(agentId)` in `$lib/memory`. Default is **non-destructive** (disabling stops future memory; it does not auto-delete) — purge is a deliberate click. (There are no memories to purge until 8.4 writes them; the plumbing + isolation are built + tested now.)

- [x] **Task 4: Tests + verification** (AC: all)
  - [x] **control-api unit** — `apps/control-api/src/memory/routes.test.ts` (mirror `tools/tools.test.ts` app-session harness): `GET /memory/config` returns the OFF defaults on a fresh app; `PATCH /memory/config` round-trips `defaultEnabled`/`killSwitch`/`retentionDays` and rejects a bad `retentionDays` (negative / non-integer) 400 and an attempt to change `embeddingModel`/`privacy` (ignored or 400); `DELETE /memory/agents/:id` purges only that agent's memories (seed two agents' memories via the repo, purge A, assert B intact — FR-7). All session-guarded (401 without cookie).
  - [x] **control-api unit** — extend `apps/control-api/src/agents/agents.test.ts`: `PATCH /agents/:id { memoryConfig }` persists + is returned on the agent, and **does NOT** set `dirty` / appear in `changedFields` (operational, not published); an invalid `memoryConfig` (bad mode / unknown kind / non-boolean) is **400**; the crafted-PATCH state-guard still holds (memoryConfig can't flip `state`).
  - [x] **web** — `svelte-check` clean; a Playwright spec (extend `tests/providers.spec.ts` or a new `tests/memory.spec.ts`): Settings → Memory renders, toggling "new agents remember by default" persists across reload; the agent editor **Memory** tab sets `on` + toggles recall/reflect + a kind, **Save draft** persists (reload shows it), and it does **not** show an "unpublished changes" marker (operational config). Note the run-dependent-flake guidance in [[turanga-e2e-clean-run]] — Memory tests are config-only (no model call), so they're not run-dependent.
  - [x] `pnpm -r build` (8 workspaces) · `pnpm lint` · `svelte-check` · all unit suites green · **e2e via `deploy/test-stack.sh`** (config-only surface — no LiteLLM key needed, but still `reset` for a pristine DB; **never `down -v` the dev stack**; `pnpm -r build` before any Docker build; restore + verify dev data after).

## Dev Notes

**The configuration SURFACE for Epic 8. Story 8.1 modeled memory + built the resolver + the repo, all off with no way to change it. This story adds the two places a human sets the policy (global Settings + per-agent editor) and the control-api wiring that persists them — control-api the sole writer (AD-7). It does NOT read the config in the run path; recall (8.3) and reflect (8.4) do that, gating on the `effectiveMemoryConfig` this story makes configurable.**

### What already exists (Story 8.1 — do NOT rebuild)
- **Domain (`packages/domain/src/index.ts`):** `MemoryKind` (:140), `MEMORY_KINDS` (:141), `MemoryConfig` (:163-168), `DEFAULT_MEMORY_CONFIG` (:172), `MemoryGlobalConfig` (:176-182), `DEFAULT_MEMORY_GLOBAL_CONFIG` (:184-190, ships OFF: `defaultEnabled:false, killSwitch:false, embeddingModel:"text-embedding-3-small", retentionDays:null, privacy:"agent-scoped"`), and the pure `effectiveMemoryConfig(global, perAgent)` (:195-207 — `killSwitch` wins; `inherit` follows `global.defaultEnabled`; `recall`/`reflect` gated by `enabled` AND the per-agent flag). **This is the single source of truth for whether + how memory runs — reuse it, never re-implement.**
- **Repo (`apps/control-api/src/memory/repo.ts`):** `MemoryRepo` with `getGlobalConfig()`/`setGlobalConfig(patch: Partial<…>)` (singleton upsert, seeds OFF), `getAgentMemoryConfig(agentId)`/`setAgentMemoryConfig(agentId, config)`, and agent-scoped CRUD (`listForAgent`, `getMemory(agentId,id)`, `createMemory`, `deleteMemory(agentId,id)` — **every accessor is agent-keyed; there is no cross-agent read**, FR-7). `drizzleMemoryRepo` + `memoryMemoryRepo` (in-memory for tests). Constructed in `app.ts:83`, passed to the orchestrator; **not yet HTTP-exposed** — this story adds `memoryRoutes`.
- **Store:** `memory_settings` singleton (`schema.ts:170-176`, keyed `'global'`), `agent_memories` (`:147-166`), and `agents.memory_config` jsonb (`schema.ts:73`) already migrated (`drizzle/0015`). `agents.memoryConfig` is carried on the `AgentRow`/`AgentView` (returned by every agent GET/PATCH since 8.1) and defaulted on create.
- **The published/operational split:** `memoryConfig` is deliberately **absent from `PUBLISHED_FIELDS`** (domain `:76-85`) and `snapshotOf`/`diffFields` (`agents/repo.ts:84-103`). Editing it does not make an agent "dirty" or require a republish — it is operational config like `state`. **This story must preserve that** (add to `AgentPatch`/`applyPatch`/`update`, but NOT to `PUBLISHED_FIELDS`).

### The three-level model → the two surfaces
- **Global (`MemoryGlobalConfig`)** → Settings → Memory. Fields this story exposes as EDITABLE: `defaultEnabled` (the value a new/`inherit` agent resolves to), `killSwitch` (master-off), `retentionDays` (retention/decay policy — stored now; the actual pruning sweep is 8.4/later, note it). **Read-only** this story: `embeddingModel` (the pgvector column is fixed at 1536 dims for `text-embedding-3-small` — changing the model requires a migration + a re-embed of every memory, out of scope; show it, don't let it be edited) and `privacy` (`agent-scoped` is the only value; the "shared-per-builder" scope is a deliberate later opt-in per the epic).
- **Per-agent (`MemoryConfig`)** → the editor Memory tab: `mode` (`inherit`|`on`|`off`), independent `recall`/`reflect`, and `kinds`. Default posture is **inherit + all-kinds** (`DEFAULT_MEMORY_CONFIG`), which with the OFF global default is effectively off — the FR-3 "default-deny / most-restrictive when unset" posture the Skills/Tools grants use.
- **Effective** = `effectiveMemoryConfig(global, perAgent)`. Surface it in BOTH UIs as human copy so the resolution is legible ("effectively off — the global default is off"). This is the same rule 8.3/8.4 gate the run on.

### The consolidation-trigger note (deliberately deferred)
The epic's AC1 mentions "the consolidation trigger." `MemoryGlobalConfig` does **not** model one yet — consolidation is the reflection behavior (8.4). Do **not** invent a config field for a behavior that doesn't exist. When 8.4 lands reflection it will add its trigger config (every-run vs threshold) then. Scope 8.2's global settings to what the model carries: `defaultEnabled`, `killSwitch`, `retentionDays`, plus the read-only `embeddingModel`/`privacy`.

### Architecture (binding)
- **AD-7 — control-api sole writer.** All persistence goes through `memoryRoutes` → `MemoryRepo` (global config, purge) and `PATCH /agents` → `AgentsRepo` (per-agent config). No other writer; the harness/sandbox never touch memory config.
- **AD-7/AD-9 — the harness never decides.** The effective toggle is resolved control-plane. This story persists the decision; 8.3/8.4 read it before recall/reflect. Nothing in the sandbox reads or influences it.
- **FR-7 — agent-scoped.** The purge deletes only the target agent's memories (the repo is agent-keyed; assert isolation in a test). No cross-agent operation exists.
- **NFR-6 / UX-DR11 — status is a dot + WORD, never colour-only.** Both surfaces render state as coloured dot + text.

### Existing patterns to mirror (exact file:line)
- **Settings sub-nav + shell:** `apps/web/src/routes/(app)/settings/+layout.svelte` — `items` array (:13-30, add the Memory entry), `current` derivation (:32), nav item markup (:50-52), pane head (:74-80). `settings/+page.ts` 307-redirects `/settings`→`/settings/providers` (no change).
- **A Settings sub-page (load-config-then-edit):** `settings/connections/+page.svelte` (`Promise.all([getConfig(), listData()])` at :15-22) and `settings/tools/+page.svelte` (`$effect`→`async load()` at :21-34; the inline `Circle`+`dotColor()` status at :65-67,113-116).
- **control-api route module + singleton mutation:** `apps/control-api/src/tools/routes.ts` (factory :26,75; GET :29-31; POST with body-parse+400 :36-60). Session guard is applied in `app.ts` (:71-72 for `/tools`), NOT the module. **No singleton-config route exists yet — author it fresh** (`GET`/`PATCH /memory/config`).
- **Web API client:** `apps/web/src/lib/tools.ts` (base :4; `Result<T>`+`req<T>()` with `credentials:"include"` :28-39; GET :41-46; mutation :55-61) and `connections.ts` (PUT example `setEnabledModels` :78-84).
- **Agent editor tabs + controlled section:** `apps/web/src/routes/(app)/agents/[id]/+page.svelte` (`Tab` :67; `tabs` :148-153; body switch :496-614; Tools branch :573; local state :58-65; `seed()` :85-94; **`stable()` serializer :100-108**; `unsavedFields` :112-124; `FIELD_LABEL` :128-137; `save()`+patch :239-273/246-255). `AgentToolsTab.svelte` — the controlled `{value,onchange}` contract (props :20; `onchange(next)` at :54-63); the Memory tab mirrors it exactly.
- **PATCH /agents field validation:** `apps/control-api/src/agents/routes.ts` — handler :165-244; body destructure :166-175; per-field parse+apply for `costCap` :233-237 / `attachedTools` :228-232 / `skills` :223-227; validators `parseCostCap` :50-58, `parseSkills` :84-107, `parseTools` :114-140 (the shape for `parseMemoryConfig`). `DEFAULT_MEMORY_CONFIG` already imported at :2 (used by POST /agents :152).
- **Status dot component (if a component is preferred over inline):** `apps/web/src/lib/components/StatusDot.svelte` (:1-28) — but it's typed for agent lifecycle only; the Settings inline `Circle`+`dotColor` pattern is the closer fit here.

### The `dirty`/`stable()` trap (learned in 52f1c84 / Story 8.1)
`memoryConfig` is an object with an array (`kinds`). The editor's `unsavedFields` MUST compare it with the `stable()` serializer (sorts object keys), NOT raw `JSON.stringify` — Postgres jsonb round-trips object keys in a normalized order, and `seed()` rebuilds the object, so a raw compare would show a phantom "Memory" unsaved change on every agent (exactly the `costCap` `{perRun,perDay}` vs `{perDay,perRun}` bug fixed in 52f1c84). Keep array order for `kinds` (order is not semantically meaningful, but `stable()` preserves array order — dedupe on the server in `parseMemoryConfig` so a re-add doesn't grow the array).

### Project Structure Notes
- **New:** `apps/control-api/src/memory/routes.ts` (+ `routes.test.ts`), `apps/web/src/lib/memory.ts`, `apps/web/src/routes/(app)/settings/memory/+page.svelte`, `apps/web/src/lib/components/AgentMemoryTab.svelte`, `apps/web/tests/memory.spec.ts` (or extend `providers.spec.ts`).
- **Edited:** `apps/control-api/src/app.ts` (guard + mount `memoryRoutes`), `apps/control-api/src/agents/routes.ts` (`parseMemoryConfig` + PATCH block), `apps/control-api/src/agents/repo.ts` (`AgentPatch` + `applyPatch` + `update`), `apps/control-api/src/agents/agents.test.ts` (memoryConfig PATCH tests), `apps/web/src/routes/(app)/settings/+layout.svelte` (nav item), `apps/web/src/routes/(app)/agents/[id]/+page.svelte` (Memory tab wiring), `apps/web/src/lib/agents.ts` (Agent type carries `memoryConfig` + re-exports).
- **No change:** `packages/domain` (8.1 already ships everything), `apps/control-api/src/server.ts` (repo already wired), `apps/control-api/src/runs/orchestrator.ts` (run-path gating is 8.3/8.4), `deploy/compose.yaml`, `CONTRACT_VERSION` (memory doesn't touch the sandbox wire until 8.3 adds `JobSpec.memories`).
- **Scope guard:** NO recall, NO reflection, NO run-path branching, NO embedding compute, NO memory-list/curation UI (that's 8.5), NO learning-changelog / staged approval (8.6). This story is the config surface + its persistence + the opt-in purge only.

### Testing standards
- Vitest for the control-api routes (global config GET/PATCH round-trip + validation 400s + session guard; agent `memoryConfig` PATCH persists-but-not-dirty + invalid-400; purge isolation FR-7) — mirror `tools/tools.test.ts` (the app-session harness) and `agents/agents.test.ts`. `svelte-check` for the web. Playwright (config-only, not run-dependent) for the Settings page + the editor Memory tab persistence + the no-unpublished-marker assertion. Full verification: `pnpm -r build`, `pnpm lint`, unit suites, `deploy/test-stack.sh` e2e (reset for pristine; never `down -v` the dev stack; restore dev after).

### References
- [Source: _bmad-output/planning-artifacts/epics.md#Epic-8 (Architecture & scope decisions) + #Story-8.2 — the two surfaces, off-by-default, three-level config, AD-7 enforcement, NFR-6]
- [Source: _bmad-output/implementation-artifacts/8-1-memory-model-store-and-config-spine.md — the model + repo + resolver this story surfaces; the published/operational split; the `stable()`/`dirty` trap]
- [Source: architecture spine #AD-7 (control-api sole writer), #AD-9 (immutable spec / harness never decides), #FR-7 (agent-scoped, no cross-agent), #NFR-6 + UX-DR11 (status dot + word)]
- [Source: 52f1c84 — the phantom-dirty `stable()` fix; apply the same serializer to `memoryConfig`]
- [Source: project-context.md — SvelteKit 2 / Svelte 5 runes, Hono, Drizzle, control-api sole writer; build/test expectations]
- [Source: [[turanga-e2e-clean-run]] — isolated e2e; reset for pristine; never `down -v` the dev stack]

## Dev Agent Record

### Agent Model Used

claude-opus-4-8[1m] (Claude Code)

### Debug Log References

- The web deliberately does NOT depend on `@turanga/domain` (it keeps local "keep in sync" type copies — see `agents.ts`). The story's "re-export from @turanga/domain" guidance was wrong for this repo; the memory types were added **locally** to `apps/web/src/lib/agents.ts` instead, and `memory.ts` imports `MemoryGlobalConfig` from `$lib/agents`.
- Naming a `$derived` variable `state` in the Settings page collided with the `$state` rune (Svelte parsed `$state` as an auto-subscribe to the local `state`); renamed to `platform`.
- The Docker/`tsc` build compiles `*.test.ts`, so `(await res.json()).x` (unknown) needed an explicit cast in `routes.test.ts`.
- e2e toggle debugging (three real bugs the unit tests couldn't catch, all fixed): (1) the switch `<input>` had **no accessible name** — `title` on the wrapping `<label>` doesn't name the input; added `aria-label`. (2) the visible `.track` span rendered over the `opacity:0` input and **intercepted the click**; added `pointer-events: none` to `.track`. (3) the Settings toggle binds to **server** state (`cfg`), which lags the async PATCH, so Playwright `.check()` retry-stormed and settled off — switched the test to a single `.click()` + poll. (The editor's Memory-tab checkboxes bind to *local* state, so they never had this problem.)
- Two e2e-authoring pitfalls fixed: `getByText(/Off by default/)` matched both the nav blurb and the status line (used exact status text); the "on" status word is identical to the card's row title (asserted on the switch state instead).

### Completion Notes List

- **The config SURFACE for Epic 8** — Settings → Memory (global defaults) + a per-agent Memory tab + the control-api wiring that persists both. control-api is the sole writer (AD-7). Deliberately **no run-path code**: recall (8.3) / reflect (8.4) will gate on the `effectiveMemoryConfig` this story makes configurable; `orchestrator.ts` is untouched (no speculative dead code).
- **Global settings (`GET`/`PATCH /memory/config`):** `defaultEnabled`, `killSwitch`, `retentionDays` editable; `embeddingModel` + `privacy` read-only (the pgvector dimension is fixed; `agent-scoped` is the only privacy value) — sending them is ignored, not 400'd, so a full-object round-trip PATCH still succeeds. Off by default is preserved end-to-end.
- **Per-agent config:** `PATCH /agents/:id { memoryConfig }` with a `parseMemoryConfig` validator (mode ∈ {inherit,on,off}, boolean recall/reflect, kinds ⊆ MEMORY_KINDS deduped). It stays OUT of `PUBLISHED_FIELDS`, so editing it **never sets `dirty` / never appears in `changedFields`** (asserted). The editor's `unsavedFields` compares it with the `stable()` serializer (52f1c84) so PG jsonb key-ordering isn't a phantom "Memory" change; the per-tab dot maps `memoryConfig` → the Memory tab (it's not a `PublishedField`).
- **Purge (opt-in, non-destructive default):** `DELETE /memory/agents/:id` deletes ONLY that agent's memories (FR-7, asserted A-purged/B-intact); surfaced as a confirmed "Forget all memories" in the Memory tab. Disabling memory does not auto-delete.
- **Effective-state legibility:** both surfaces render the resolved state as human copy ("Effectively off — the global default is off") + a dot + word (NFR-6/UX-DR11).
- **Web/domain decoupling honored:** memory types live locally in `apps/web/src/lib/agents.ts` (mirroring @turanga/domain, per the existing convention), not imported from the domain package.
- **Verification:** `pnpm -r build` (8 workspaces) ✓, `pnpm lint` ✓, `svelte-check` 0 errors ✓, domain 4/4 ✓, control-api 178 (10 new: 8 memory-route + 2 agent-memoryConfig) ✓. **Playwright memory.spec.ts — both tests green** (Settings toggle persists across reload; editor Memory tab set-on + reflect/kind toggle + Save draft persists with no unpublished marker) against the isolated `deploy/test-stack.sh` stack on a pristine `reset` DB. Dev stack restored, data intact.
- Did NOT run the full agents/providers e2e suite (their known pre-existing UI-overlay/run-dependent flakes from 8.1 are unrelated); the Memory-tab spec exercises the editor create→tab→save→reload path end-to-end, proving the editor is unbroken by the new 5th tab.

### File List

- **New** `apps/control-api/src/memory/routes.ts` — `memoryRoutes(repo)`: `GET`/`PATCH /memory/config` (+ `parseGlobalConfig`), `DELETE /memory/agents/:agentId` (agent-scoped purge).
- **New** `apps/control-api/src/memory/routes.test.ts` — global-config round-trip + validation 400s + read-only ignore + session guard; purge isolation (FR-7).
- **New** `apps/web/src/lib/memory.ts` — `getMemoryConfig`/`setMemoryConfig`/`purgeAgentMemory` client.
- **New** `apps/web/src/routes/(app)/settings/memory/+page.svelte` — the global-defaults screen (toggles, retention, read-only rows, dot+word status).
- **New** `apps/web/src/lib/components/AgentMemoryTab.svelte` — the controlled per-agent Memory section (mode / recall / reflect / kinds + effective-state + opt-in purge).
- **New** `apps/web/tests/memory.spec.ts` — the two config-only e2e tests.
- **Edited** `apps/control-api/src/app.ts` — session-guard `/memory*` + mount `memoryRoutes`.
- **Edited** `apps/control-api/src/agents/routes.ts` — `parseMemoryConfig` + the PATCH `memoryConfig` block + imports.
- **Edited** `apps/control-api/src/agents/repo.ts` — `AgentPatch.memoryConfig` + `applyPatch` + drizzle `update`.
- **Edited** `apps/control-api/src/agents/agents.test.ts` — memoryConfig PATCH persists-not-dirty + invalid-400/dedupe tests.
- **Edited** `apps/web/src/routes/(app)/settings/+layout.svelte` — the Memory nav item.
- **Edited** `apps/web/src/routes/(app)/agents/[id]/+page.svelte` — Memory tab wiring (state, seed, unsavedFields, FIELD_LABEL, per-tab dot, tabs, save patch, global-config fetch, body branch).
- **Edited** `apps/web/src/lib/agents.ts` — local memory types (`MemoryKind`/`MemoryConfig`/`MemoryGlobalConfig`/`DEFAULT_MEMORY_CONFIG`/`effectiveMemoryConfig`) + `Agent.memoryConfig` + `AgentPatch.memoryConfig`.

### Change Log

| Date | Version | Description |
|------|---------|-------------|
| 2026-08-05 | 0.1 | Story 8.2 implemented — Settings → Memory global defaults + per-agent Memory tab + control-api config wiring + opt-in purge. Status → review. |
