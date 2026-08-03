---
baseline_commit: 08468274d258da441d03400f1e8ff783394ae1d8
---
# Story 6.1: Model tools and a Tools management surface

Status: review

<!-- First story of Epic 6 (Tools — the agent↔tool contract + remote MCP). Opens the epic. The
     agent↔tool CONTRACT is the epic's keystone (party-mode 2026-08-03): remote and containerized MCP
     are two endpoint TYPES behind one brokered path. This story lays the foundation — the entity, the
     versioned contract, and the management surface — with NO live MCP yet (remote connect + list-tools
     discovery is 6.2; the Guard broker + runtime invocation is 6.4). -->

## Story

As the builder,
I want turanga to treat a Tool as a first-class thing I manage in one place,
so that a tool's identity is stable and endpoint-type-agnostic before anything invokes it.

## Acceptance Criteria

1. **Given** the contracts package, **when** the agent↔tool contract is defined, **then** a tool invocation is a **versioned control-plane message** (a logical invoke request + result) carrying **no endpoint URL and no credential**. [Source: epics.md#Story-6.1 AC1, AD-9, AD-10, E4-AD-9]
2. **Given** a Tool entity, **when** it is created, renamed, or removed, **then** `control-api` is its **sole writer** (AD-7); it records an `endpoint` type (`remote` | `container`) so the type is an adapter, not a fork; IDs/timestamps follow project conventions (ULID, UTC). [Source: epics.md#Story-6.1 AC2, AD-7]
3. **Given** the Tools page, **when** it is viewed, **then** it lists every tool with its type + status (dot + word, never colour-only), with an empty state and an "Add a tool" action. [Source: epics.md#Story-6.1 AC3, FR-15, NFR-6]

## Tasks / Subtasks

- [x] **Task 1: The Tool + AttachedTool domain types + the versioned agent↔tool contract** (AC: #1, #2)
  - [x] `packages/domain/src/index.ts` (types-only, browser-safe) — add, alongside `Connection`/`AttachedSkill`:
    - `ToolEndpointType = "remote" | "container"` and `ToolStatus = "unverified" | "connected" | "error"`.
    - `ToolOperation` — a discovered MCP tool descriptor: `{ name: string; title?: string; description?: string; inputSchema?: unknown }` (mirrors MCP `tools/list` fields; **6.2** populates it via discovery, this story only defines the type).
    - `Tool = { id: string; name: string; endpoint: ToolEndpointType; status: ToolStatus; operations: ToolOperation[]; createdAt: string }` (endpoint-specific fields — remote url/credential, container image/manifest — are added by 6.2 / Epic 7; keep this the common core).
    - `AttachedTool = { toolId: string; operations: string[] }` — the agent↔tool grant (which operations of a tool an agent may call). This is the **AttachedSkill** analogue (Story 6.3 consumes it; define the type now).
  - [x] `packages/contracts/src/index.ts` — **bump `CONTRACT_VERSION` 4 → 5** (versioned harness↔Guard contract, E4-AD-9) and define, at `v: z.literal(CONTRACT_VERSION)`:
    - `JobToolSchema` — the **sandbox-visible logical handle** (the JobConnection analogue): `{ id: string; name: string; operations: string[] }` — the granted operation names only. **No URL, no credential** (AD-10). Add `tools: z.array(JobToolSchema).default([])` to `JobSpecSchema` (the `.default([])` keeps older specs valid — the backward-compat convention).
    - The **agent↔tool invoke contract** (harness↔Guard request/response, the `GuardConnectionRequest`/`GuardConnectionResponse` analogue): `ToolCallRequestSchema { v, toolId, operation, arguments: z.record(...)|z.unknown() }` → maps to MCP `tools/call` (name+arguments), the harness names the *logical* tool + operation, never the endpoint. `ToolCallResponseSchema { v, ok: boolean, content?: <MCP content blocks: text/…>, isError?: boolean, refusal?: { kind: "permission"|"egress"; detail: string } }` → maps to the MCP result (`content` + `isError`); a `refusal` is a Guard denial (distinct from a tool-execution `isError`). **This story only DEFINES these; the Guard broker that fulfills them is Story 6.4.**
  - [x] **Update the version literals** — bump every hard-coded `v: 4` to `v: 5` in: `apps/web/src/lib/runs.ts` (the RunMessage mirror union), `apps/control-api/src/runs/runs.test.ts`, `apps/control-api/src/runs/hub.test.ts`, `apps/control-api/src/app.test.ts`, `apps/egress-guard/src/guard.test.ts` (27 occurrences). Source files use the `CONTRACT_VERSION` constant and update automatically; `pnpm -r build` + the test suites must be green after the bump.

- [x] **Task 2: The `tools` table + repo (control-api, sole writer AD-7)** (AC: #2)
  - [x] `apps/control-api/src/db/schema.ts` — add a **dedicated `tools` table** (mirrors the standalone `dataConnections` table, NOT the kind-discriminated `connections` table): `id text pk` (ULID), `name text notNull`, `endpoint text notNull` (`remote`|`container`), `status text notNull`, `lastError text`, `operations jsonb.$type<ToolOperation[]>().notNull().default([])`, `createdAt timestamptz.notNull().defaultNow()`. Generate the migration (`drizzle-kit generate` → `drizzle/0011_*.sql` + the `meta/_journal.json` entry; both committed; applied on boot via `runMigrations`).
  - [x] `apps/control-api/src/tools/repo.ts` (NEW) — `ToolRow` interface + `ToolsRepo` interface + **both** impls (drizzle + memory), mirroring `connections/repo.ts` method-for-method: `listTools()`, `getTool(id)`, `createTool(row)`, `setStatus(id, status, lastError)`, `setOperations(id, operations)`, `deleteTool(id)`. (`createTool`/`setStatus`/`setOperations` are used by 6.2's connect flow + tests; this story exposes only read/delete routes — see Task 3.)

- [x] **Task 3: The `/tools` routes + wiring (control-api)** (AC: #2, #3)
  - [x] `apps/control-api/src/tools/routes.ts` (NEW) — `toolRoutes(repo: ToolsRepo)` → a `new Hono()`, mirroring `connectionRoutes`. A `view(r)` projection (establish the **secret-masking** pattern now, even though 6.1 stores no secret — 6.2 adds a Guard-held credential that `view()` must never return). Handlers: `GET /tools` (list → `{ tools: rows.map(view) }`), `GET /tools/:id` (404 if missing), `DELETE /tools/:id` (404 if missing → delete → `{ ok: true }`). **No create route this story** — creating a tool = connecting a remote endpoint (6.2) / deploying a container (Epic 7); the repo has `createTool` for those + tests.
  - [x] `apps/control-api/src/app.ts` — `app.use("/tools", requireSession(authRepo))` + `app.use("/tools/*", requireSession(authRepo))`; `app.route("/", toolRoutes(toolsRepo))`; add `toolsRepo?` to `AppDeps` defaulting to `memoryToolsRepo()` (mirrors `connectionsRepo`). `apps/control-api/src/server.ts` — wire `drizzleToolsRepo(db)`.

- [x] **Task 4: The Tools management surface (web)** (AC: #3)
  - [x] `apps/web/src/lib/tools.ts` (NEW) — `Tool` type (mirrors the masked `view()`: id, name, endpoint, status, operations, createdAt), the `Result<T>` + `req` helper pattern (copy from `$lib/connections.ts`), `listTools()` and `removeTool(id)`. (No create client this story — 6.2 adds `connectRemoteTool`.)
  - [x] `apps/web/src/routes/(app)/settings/tools/+page.svelte` (NEW) — mirror the providers page shell: `$state` list + loading + loadError, `load()` in `$effect`, and the list/empty/error blocks. Each tool card: name, **type** (remote/container), **status** (dot + word via a small status indicator — never colour-only, NFR-6/UX-DR11-style), a **Remove** action (armed confirm, like the providers Remove). **Empty state:** "No tools yet." + an **"Add a tool"** action. Since remote-connect is 6.2, the "Add a tool" button is present but routes to a placeholder / is disabled-with-note ("Connecting tools ships next") — do NOT build the connect flow here.
  - [x] `apps/web/src/routes/(app)/settings/+layout.svelte` — add `{ href: "/settings/tools", label: "Tools" }` to the sub-nav `items` (Tools lives under Settings, consistent with Model providers + Data connections — the tighter mirror of the connection entity; a top-level nav elevation can come later).
  - [x] Warm Ink tokens + a11y: status dot + word, keyboard-operable, mono where appropriate.

- [x] **Task 5: Tests + verification** (AC: all)
  - [x] **contracts unit** (`packages/contracts`): `CONTRACT_VERSION === 5`; `JobSpecSchema` parses a spec **without** `tools` (defaults to `[]`) and **with** tools; `JobToolSchema` rejects a handle that carries a `url`/secret field (belt-and-suspenders on AD-10 — extra keys are fine, but assert the *parsed* shape has no url/credential); `ToolCallRequestSchema`/`ToolCallResponseSchema` round-trip (incl. a `refusal` and an `isError` result).
  - [x] **control-api unit:** `tools/repo` (both impls) — create/list/get/setStatus/setOperations/delete; `GET /tools` → `{ tools: [] }` fresh; `GET /tools/:id` + `DELETE /tools/:id` 404 for unknown; **session-guarded** (401 without a session — add to `app.test.ts`, distinct `x-forwarded-for`). Existing `runs`/`hub`/`guard` suites stay green after the version bump.
  - [x] **web unit:** none new required (the client is thin `req` wrappers); add one if a pure helper appears.
  - [x] **Playwright e2e** (append to `tests/providers.spec.ts` or a new `tools.spec.ts`, serial): Settings → the **Tools** sub-nav tab is present and navigates to `/settings/tools`; the page shows the **"No tools yet."** empty state and the "Add a tool" affordance. (Creating/removing a real tool needs the 6.2 connect flow — gated to 6.2.)
  - [x] `svelte-check` 0 · `pnpm -r build` 6/6 · `pnpm lint` · all unit suites · e2e green · teardown. **Run e2e via the isolated `deploy/test-stack.sh` (project `turanga-e2e`) — NEVER `docker compose down -v` on the dev stack** (it wipes the operator's providers/agents; see the 2026-08-03 infra fix). Rebuild the control-api image for the e2e (schema/migration + routes changed); run `pnpm -r build` before the Docker build.

## Dev Notes

**Opens Epic 6. The keystone (party-mode 2026-08-03): the agent↔tool *contract* is the common denominator — remote MCP and containerized MCP are two endpoint TYPES behind one Guard-brokered path (`Tool = { endpoint: remote | container }`). This story builds the foundation only: the entity, the versioned contract, the management shell. NO live MCP — remote connect + `list-tools` discovery is 6.2; the Guard broker + runtime invocation is 6.4; per-operation grants on an agent is 6.3; observability is 6.5.**

**No user forks — the shape is set by the Epic 6 decisions + the connection/skill patterns this mirrors.**

### The MCP grounding (why the contract looks the way it does)
Research (MCP spec **2025-11-25**, the current stable revision) — feeds the contract but is NOT implemented until 6.2/6.4:
- **Transport = Streamable HTTP** (single endpoint, POST for calls, optional SSE). stdio is out (it would co-locate a process with the agent — a second hole in the sandbox). The Guard terminates + forwards HTTP.
- **Auth = a bearer token on every HTTP request**, held by the client. This is a **perfect fit** for turanga: whoever forwards the HTTP call sets `Authorization` — so the **Guard holds/injects the token and the agent never holds it** (AD-10). *Spec constraint for 6.2/6.4:* the broker must hold a token **bound to the target server's audience** (RFC 8707), NOT blind-forward an inbound token (the "confused deputy" ban).
- **`tools/list`** → descriptors (`name`, `title?`, `description?`, `inputSchema` JSON-Schema) — shapes `ToolOperation`.
- **`tools/call`** → `{ content: [blocks], structuredContent?, isError }` — shapes `ToolCallResponse`. **`isError` is a tool-execution error inside a 200** (distinct from a Guard `refusal`); the observability (6.5) must read `result.isError`, not HTTP status.
- **Client lib** (6.2/6.4, NOT this story): the official `@modelcontextprotocol/sdk` (v1 stable ~1.30, protocol 2025-11-25) — `Client` + `StreamableHTTPClientTransport`, `listTools()` (auto-paginates), `callTool()`. Do **not** add the dep in 6.1.
- **Deferred decision (6.4, not 6.1):** target stable `2025-11-25` (handle the `MCP-Session-Id` affinity a TLS-terminating broker must preserve) vs. the `2026-07-28` RC (stateless — no session id, simpler for a forwarding broker). The 6.1 *logical* contract is transport-agnostic, so this doesn't block 6.1.

### Architecture (binding)
- **AD-9 / E4-AD-9 — versioned, control-api-owned contract:** the tool-invoke message is a versioned control-channel message; the job spec is injected at run start. Bumping `CONTRACT_VERSION` to 5 is the honest cost of adding the `tools` field + tool-call messages. [Source: architecture spine #AD-9]
- **AD-10 — no secret in the sandbox:** the sandbox-visible `JobTool` carries only the logical id + granted operation names. The endpoint URL and the credential live Guard-side (6.2/6.4). Assert this in the contract shape. [Source: #AD-10]
- **AD-7 — control-api sole writer:** all Tool state writes go through control-api; the web reads + (later) POSTs. [Source: #AD-7]
- **AD-1/AD-5 (for later stories):** a tool reaches the agent, and the world, **only through the Guard** — the agent→tool broker is 6.4 (server-side); the tool→world broker is Epic 7 (client-side). Not built here, but the contract must not assume a direct edge.

### Existing patterns to mirror (do NOT reinvent) — from the codebase scan
- **Entity end-to-end** = the `connections` entity: `connections/repo.ts` (ProviderRow + interface + drizzle & memory impls, verb+Entity method names), `connections/routes.ts` (the `view()` secret-masking projection at :14-27, list/get/delete handlers, `ulid(Date.now())` ids), `app.ts` (`requireSession` on `/connections/*` :57, `route("/", …)` :67, repo default `?? memoryConnectionsRepo()` :65), `server.ts` (drizzle repo wiring :55). **A dedicated `tools` table mirrors `dataConnections` (schema.ts:42-53) — its own table, not kind-filtered.**
- **Migrations:** hand-edit `schema.ts` → `drizzle-kit generate` (config `drizzle.config.ts`) → new `0011_*.sql` + `meta/_journal.json`; applied on boot by `runMigrations` (`db/migrate.ts:7-12`, called `server.ts:46`). No npm script — run the CLI.
- **Contracts versioning:** `CONTRACT_VERSION` (:10), every message `v: z.literal(CONTRACT_VERSION)`; `JobSpecSchema` (:21-34) with `.default([])` fields for back-compat; `JobConnectionSchema` (:14-18, `{id, provider}`, no secret) = the `JobTool` template; `GuardConnectionRequest/ResponseSchema` (:80-101) = the `ToolCallRequest/Response` template.
- **Domain:** types-only, browser-safe (`ulid` is Math.random, not node-crypto); `AttachedSkill {skill, scope, send}` (:51-55) = the `AttachedTool` template; `Connection` (:69-75) = the `Tool` template.
- **Grants (for 6.3, define the type now):** `AttachedSkill` → agents `schema.ts:64` jsonb → `agents/routes.ts` `parseSkills` (:81-104) → `orchestrator.ts` `resolveRunConnections` builds `SkillGrant`/`RunProvision` (never the jobSpec). `AttachedTool` will follow this exact path in 6.3/6.4.
- **Web:** `$lib/connections.ts` (base URL, `Result<T>`, `req` helper) = the `$lib/tools.ts` template; `settings/providers/+page.svelte` (list/empty/card/remove-confirm) = the tools page template; `settings/+layout.svelte:4-8` sub-nav = where the Tools tab goes.
- **Collision check:** grep confirmed **zero** existing `tool`/`mcp` identifiers/routes/columns — all names (`Tool`, `AttachedTool`, `/tools`, the `tools` JobSpec field + table, `ToolCall*`) are free.

### Project Structure Notes
- New: `apps/control-api/src/tools/{repo,routes}.ts`, `drizzle/0011_*.sql`, `apps/web/src/lib/tools.ts`, `apps/web/src/routes/(app)/settings/tools/+page.svelte`. Edited: `packages/domain/src/index.ts`, `packages/contracts/src/index.ts` (+ version), `db/schema.ts`, `app.ts`, `server.ts`, `settings/+layout.svelte`, the 5 files with `v: 4` literals.
- Web still does **not** depend on `@turanga/domain` (browser-bundle constraint) — `$lib/tools.ts` mirrors the `Tool` shape locally, like `$lib/connections.ts` mirrors `Provider`.
- Scope guard: NO remote connect, NO `list-tools`, NO MCP SDK, NO Guard broker, NO agent Tools section, NO invocation — those are 6.2–6.5. This story is entity + contract + management shell only.

### Testing standards
- Vitest (contracts, control-api both repo impls, the version-bump regressions); Playwright serial e2e via the **isolated `deploy/test-stack.sh`** (project `turanga-e2e`) — the empty-state + sub-nav are deterministic; a real tool needs 6.2 (gated). Distinct `x-forwarded-for` per `appWithSession`/`signIn`; `pnpm -r build` before any Docker build. **Never `down -v` the dev stack.**

### References
- [Source: _bmad-output/planning-artifacts/epics.md#Epic-6, #Story-6.1]
- [Source: _bmad-output/planning-artifacts/architecture/architecture-turanga-2026-07-31/ARCHITECTURE-SPINE.md#AD-1, #AD-5, #AD-7, #AD-9, #AD-10]
- [Source: _bmad-output/planning-artifacts/architecture/epic-4-execution-plane/ARCHITECTURE-SPINE.md#E4-AD-9 (versioned contract), #E4-AD-10 (event ledger — 6.5)]
- [Source: MCP spec 2025-11-25 — transports (Streamable HTTP), server/tools (tools/list, tools/call, isError), basic/authorization (bearer, RFC 8707 audience binding, passthrough ban); official `@modelcontextprotocol/sdk`]
- [Source: party-mode brainstorm 2026-08-03 — the contract is the common denominator; endpoint type is an adapter; observe-only; AD-10 generalizes to any untrusted node]
- [Source: deploy/test-stack.sh + the 2026-08-03 infra fix — isolate e2e; never `down -v` the dev stack]

## Dev Agent Record

### Agent Model Used
claude-opus-4-8[1m]

### Debug Log References
- **`CONTRACT_VERSION` 4→5 + the `v: 4` literal ripple:** source uses the constant (auto-updated); bumped the 27 hard literals across `web/lib/runs.ts` + 4 test files. The contracts round-trip test also needed updating (the new `tools` default means a parsed spec now carries `tools: []` the input lacked — mirrored the `connections` fix + added a `tools` handle).
- **`tsc` caught what vitest didn't (the prior-story lesson):** a `.default([])` Zod field is optional on the INPUT type but **required** on the OUTPUT type (`z.infer`), so the orchestrator's `JobSpec` literal needed `tools: []`. `pnpm -r test` was green but `pnpm -r build` failed at `orchestrator.ts:147` — fixed by adding `tools: []` (agent tool grants populate it in 6.3). No other JobSpec-literal site (the harness parses the spec, so `tools` defaults there).
- **Isolated e2e (the 2026-08-03 infra fix):** ran via `deploy/test-stack.sh up` (project `turanga-e2e`, own throwaway volumes) → 25/25 → `test-stack.sh down` (`down -v` on the e2e project only). Verified the dev stack's data (`Clyde`, `Untitled agent`, `wopr`) survived — **never `down -v` the dev stack.** Migration `0011` applied cleanly on the fresh e2e DB (the `tools` table exists).

### Completion Notes List
- **Opens Epic 6. Foundation only — the entity, the versioned contract, the management shell; NO live MCP** (remote connect + discovery is 6.2; the Guard broker + invocation is 6.4; per-op grants on an agent is 6.3).
- **AC1 (contract):** bumped `CONTRACT_VERSION` to 5; added the sandbox-visible `JobTool` handle (id + granted op names — **no URL/credential**, AD-10) + `JobSpec.tools`; defined the harness↔Guard `ToolCallRequest`/`ToolCallResponse` (grounded in MCP `tools/call` → `content` + `isError`, with a Guard `refusal` distinct from a tool-execution `isError`). Domain gained `Tool`/`AttachedTool`/`ToolOperation`/`ToolEndpointType`/`ToolStatus`.
- **AC2 (entity, sole writer):** a dedicated `tools` table (migration 0011) + `tools/repo.ts` (drizzle + memory, full CRUD) + `/tools` routes (list/get/delete + the secret-masking `view()`; **no create route** — that's the 6.2 connect flow); session-guarded via `/tools*`; wired in `app.ts` + `server.ts`.
- **AC3 (management surface):** `$lib/tools.ts` client + a `settings/tools` page (list, empty state "No tools yet.", per-tool card with type + status dot+word + armed Remove) + a **Tools** tab in Settings. The "Add a tool" button is present but disabled-with-note (connecting ships in 6.2).
- **MCP grounding (research, spec 2025-11-25):** the contract targets Streamable HTTP + bearer-token auth — a *perfect* fit since a forwarding broker sets `Authorization`, so the Guard holds the token and the agent never does (AD-10). Not implemented here; the `@modelcontextprotocol/sdk` dep is NOT added (6.2/6.4). The stable-vs-`2026-07-28`-RC session-model choice is deferred to 6.4 (the logical contract is transport-agnostic).
- **Scope held:** no remote connect, no MCP SDK, no Guard broker, no agent Tools section, no invocation.
- **Verification:** `pnpm -r build` 6/6 · `svelte-check` 0/0 · `pnpm lint` clean · unit — domain 3, web 22, contracts 12 (+3), agent-harness 4, egress-guard 23, control-api 129 (+5, +1 skipped) · **25/25 Playwright e2e** on the isolated stack incl. the new tools test · migration 0011 applied · dev data preserved.

### File List
**Added**
- apps/control-api/src/tools/repo.ts
- apps/control-api/src/tools/routes.ts
- apps/control-api/src/tools/tools.test.ts
- apps/control-api/drizzle/0011_slippery_the_santerians.sql (+ drizzle/meta snapshot + journal)
- apps/web/src/lib/tools.ts
- apps/web/src/routes/(app)/settings/tools/+page.svelte

**Modified**
- packages/domain/src/index.ts
- packages/contracts/src/index.ts
- packages/contracts/src/index.test.ts
- apps/control-api/src/db/schema.ts
- apps/control-api/src/app.ts
- apps/control-api/src/app.test.ts
- apps/control-api/src/server.ts
- apps/control-api/src/runs/orchestrator.ts
- apps/control-api/src/runs/runs.test.ts
- apps/control-api/src/runs/hub.test.ts
- apps/egress-guard/src/guard.test.ts
- apps/web/src/lib/runs.ts
- apps/web/src/routes/(app)/settings/+layout.svelte
- apps/web/tests/providers.spec.ts

### Change Log
| Date | Change |
| --- | --- |
| 2026-08-03 | Story 6.1 implemented (opens Epic 6): the `Tool` entity (dedicated table + repo + `/tools` read/delete routes + `settings/tools` page + Settings tab), the versioned agent↔tool contract (`CONTRACT_VERSION`→5; `JobTool` handle + `JobSpec.tools`; `ToolCall` request/response grounded in MCP, no URL/credential — AD-10), and `Tool`/`AttachedTool` domain types. No live MCP (remote connect is 6.2). Verified: build 6/6, svelte-check 0/0, lint clean, unit (contracts 12, control-api 129, web 22, …), 25/25 e2e on the isolated stack, migration 0011 applied, dev data preserved. Status → review. |
