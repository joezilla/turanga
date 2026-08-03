---
baseline_commit: 36a59ca9ade21e1eb5a8d1828edf968581ebf4c7
---
# Story 6.2: Connect a remote MCP tool

Status: review

<!-- Second story of Epic 6. Builds on 6.1's Tool entity + contract. Connects a REMOTE MCP endpoint
     (URL + credential): verify by an MCP handshake, discover its operations (list-tools), and store
     the connection with the credential held per AD-10. NO runtime invocation yet (the Guard broker is
     6.4); NO per-agent grants yet (6.3). Two user decisions (2026-08-03): (1) use the official
     @modelcontextprotocol/sdk; (2) build a tiny stub MCP server so the connect+discover flow is
     deterministically e2e-testable (reused by 6.4). -->

## Story

As the builder,
I want to connect an external MCP server by URL and credential and see the operations it offers,
so that I can later grant those operations to agents without ever exposing the credential to an agent.

## Acceptance Criteria

1. **Given** the "Add a tool → Remote" flow, **when** I enter a URL + credential and connect, **then** the credential is **held per AD-10** (encrypted at rest, never returned to the browser, never reachable by an agent); the connection is **verified** by an MCP handshake; failure shows a stated cause; a stored credential is masked (never echoed). [Source: epics.md#Story-6.2, FR-13-style, AD-5, AD-10]
2. **Given** a connected remote tool, **when** the connection is established, **then** turanga performs a **`list-tools` handshake** and surfaces the operations the server offers (so the builder sees exactly what they can grant). [Source: epics.md#Story-6.2, MCP tools/list]

## Tasks / Subtasks

- [x] **Task 1: The MCP verify/discover client (control-api) + the SDK dependency** (AC: #1, #2)
  - [x] Add the official SDK: `pnpm --filter @turanga/control-api add @modelcontextprotocol/sdk` (decision 2026-08-03 — the maintained reference impl; handles Streamable HTTP, the SSE-vs-JSON branch, session-id, pagination, bearer injection). ESM (`.js` imports); Node 22.
  - [x] `apps/control-api/src/tools/mcp.ts` (NEW) — an injectable **verifier** (the `ModelGateway` analogue):
    - `McpVerifyInput = { url: string; credential?: string }`; `McpVerifyResult = { ok: true; operations: ToolOperation[] } | { ok: false; error: string }`.
    - `McpVerifier` interface: `verify(input): Promise<McpVerifyResult>`.
    - `httpMcpVerifier()` (real) — connect a `Client` + `StreamableHTTPClientTransport(new URL(url))`, injecting the bearer via the transport's request headers (`Authorization: Bearer <credential>`) when present; `await client.connect(transport)` (the `initialize` handshake) then `await client.listTools()` (auto-paginates). Map the returned tool descriptors → `ToolOperation[]` (`{ name, title?, description?, inputSchema? }`). Wrap in try/catch → a human `error` on any failure (unreachable, auth rejected, not an MCP server, bad protocol) — **fail-closed** (Story 2.1 verify posture). Close the transport in a finally.
    - `fakeMcpVerifier(opts?: { ok?: boolean; error?: string; operations?: ToolOperation[] })` (test double, mirrors `fakeModelGateway`) — returns canned operations or an error; the default returns a couple of representative operations so connect tests have something to persist.
  - [x] **No `CONTRACT_VERSION` bump** — 6.2 changes nothing on the sandbox wire (the endpoint URL + credential are server-side only; the 6.1 `JobTool`/`ToolCall` contract already anticipates the runtime broker).

- [x] **Task 2: The tool's remote endpoint config + encrypted credential (schema + repo, AD-10)** (AC: #1)
  - [x] `apps/control-api/src/db/schema.ts` — add to the `tools` table: `url text` (nullable — a container tool has none) and `encCredential text` (nullable — the MCP bearer token **encrypted at rest**, mirroring `dataConnections.encRefreshToken`; some servers need no auth). Generate the migration (`pnpm --filter @turanga/control-api drizzle-kit generate` → `drizzle/0012_*.sql` + `meta/_journal.json` + `0012_snapshot.json`; applied on boot).
  - [x] `apps/control-api/src/tools/repo.ts` — extend `ToolRow` with `url: string | null` and `encCredential: string | null`; thread through `toRow`, `createTool`, and both impls. **`encCredential` is internal-only** (6.4 decrypts it) — like `DataConnRow.encRefreshToken`, it is NEVER surfaced by the route `view()`.
  - [x] `apps/control-api/src/secrets/crypto.ts` — reuse `encryptSecret`/`decryptSecret` (AES-256-GCM, `TOKEN_ENC_KEY`); do NOT add a new crypto path.

- [x] **Task 3: The connect route (control-api)** (AC: #1, #2)
  - [x] `apps/control-api/src/tools/routes.ts` — inject the verifier: `toolRoutes(repo, verifier: McpVerifier)`. Add `POST /tools` (connect a remote tool): validate `{ name, url, credential? }` (name + url required; `endpoint` is `remote`). **Verify FIRST** (`await verifier.verify({ url, credential })`) — on failure return `400 { error }` and persist **nothing** (fail-closed; no orphan error rows — the discover-style UX). On success: `encCredential = credential ? encryptSecret(credential) : null`; `createTool({ id: ulid(...), name, endpoint: "remote", status: "connected", lastError: null, url, encCredential, operations })` → `201 { tool: view(...) }`.
  - [x] Update `view(r)` to include `url` (safe) + a derived `credentialSet: boolean` (`!!r.encCredential`), and to **never** return `encCredential`. Keep list/get/delete from 6.1 (delete stays a hard delete — no external de-registration needed for a remote tool; a container tool's teardown is Epic 7).
  - [x] `apps/control-api/src/app.ts` — construct the verifier (`deps.mcpVerifier ?? fakeMcpVerifier()`, mirroring `modelGateway`) and pass it to `toolRoutes(toolsRepo, verifier)`. `apps/control-api/src/server.ts` — wire `httpMcpVerifier()`.

- [x] **Task 4: The connect form + activated "Add a tool" (web)** (AC: #1, #2)
  - [x] `apps/web/src/lib/tools.ts` — add `connectTool(input: { name: string; url: string; credential?: string }): Promise<Result<{ tool: Tool }>>` (POST `/tools`). Add `credentialSet?: boolean` + `url?: string | null` to the `Tool` type (mirror the server view).
  - [x] `apps/web/src/routes/(app)/settings/tools/+page.svelte` — activate the disabled "Add a tool" button into a connect form (mirror the providers add-form): fields **Name**, **URL**, **Credential** (`type=password`, optional — note "leave blank if the server needs no auth"), a **Connect** button (busy state), and an inline error on failure. On success clear + reload. Each connected tool card lists its **operations** (names) + the count, and shows `url` + a "credential set" indicator (never the credential). Keep Remove.
  - [x] Voice/UX: cause→consequence errors (UX-DR16), status dot + word (NFR-6), mono for the URL/op ids.

- [x] **Task 5: A stub MCP server for deterministic e2e (decision 2026-08-03)** (AC: #1, #2)
  - [x] `apps/mcp-stub/` (NEW workspace package) — a tiny MCP **server** using `@modelcontextprotocol/sdk` (server + `StreamableHTTPServerTransport`) that exposes 1–2 canned tools (e.g. `echo`, `get_time`) over Streamable HTTP on a fixed port + path (e.g. `:9000/mcp`). Minimal: `package.json` (type:module), `tsconfig.json`, `src/server.ts`, a `Dockerfile` (mirror `apps/egress-guard/Dockerfile`). It is a **test/dev fixture** — a real MCP endpoint control-api can handshake in the docker network.
  - [x] `deploy/compose.yaml` — add an `mcp-stub` service (`build:` from the new Dockerfile) reachable at `http://mcp-stub:9000/mcp` (internal only — no host port needed; the browser never talks to it, control-api does). It runs in both the dev stack and the isolated `turanga-e2e` stack (both use `up -d --build`, so no `test-stack.sh` change). Optionally require no auth (or a canned token) — keep it simple.
  - [x] This makes the connect+discover flow **deterministically e2e-testable** and gives a live MCP server for manual dev testing; 6.4's runtime broker reuses it.

- [x] **Task 6: Tests + verification** (AC: all)
  - [x] **control-api unit:** the connect route with `fakeMcpVerifier` — success → a `connected` tool with the discovered `operations` persisted, `credentialSet:true` when a credential was given, and the response **never** contains the raw credential (assert the encrypted blob ≠ plaintext + `view()` has no `encCredential`); verify-failure → `400` with the stated error and **no** tool persisted; name/url required (400). The verifier's mapping (a fake server descriptor → `ToolOperation`) if it's a pure step. Distinct `x-forwarded-for` per `appWithSession`. `TOKEN_ENC_KEY` set in the test env (mirror the connections/oauth tests' `beforeAll`).
  - [x] **Playwright e2e (isolated stack incl. `mcp-stub`, serial — append to the tools e2e):** Settings → Tools → **Add a tool** → enter the stub URL (`http://mcp-stub:9000/mcp`) + connect → the tool appears **connected** and lists the stub's operations. A bad URL → a stated error, no tool added. (This replaces 6.1's gated/manual note — the flow is now deterministic.)
  - [x] `svelte-check` 0 · `pnpm -r build` (now 7 workspaces incl. mcp-stub) · `pnpm lint` · all unit suites · e2e green · teardown. **Run e2e via `deploy/test-stack.sh` (project `turanga-e2e`) — NEVER `docker compose down -v` on the dev stack.** Rebuild the control-api image + the new mcp-stub for the e2e; `pnpm -r build` before the Docker build.

## Dev Notes

**Builds directly on 6.1 (the Tool entity + the versioned contract). This story makes a remote tool real: connect by URL + credential, verify via a live MCP handshake, discover its operations, store it with the credential held per AD-10. It does NOT invoke tools at runtime (the Guard broker is 6.4) and does NOT attach tools to agents (6.3).**

**User decisions (2026-08-03, load-bearing, resolved):** (1) use the official `@modelcontextprotocol/sdk` for the handshake (a new control-api dep — approved as part of the tools epic); (2) build a tiny **stub MCP server** in the e2e stack so connect+discover is deterministically e2e-testable (reused by 6.4).

### Credential custody — the decision, grounded (AD-10)
Two precedents; the **OAuth one fits, the LiteLLM one doesn't**:
- **LiteLLM (provider keys):** control-api verifies with the key then hands it to LiteLLM, keeping only `keyLast4`. There is **no external vault** for an arbitrary MCP server → this precedent does NOT apply.
- **OAuth (Gmail, the right template):** the long-lived refresh token is **encrypted at rest in control-api** (`dataConnections.encRefreshToken`, `encryptSecret`), never in `view()`; at run time the orchestrator decrypts it and hands a credential to the Guard via `RunProvision` (control-plane only, never the sandbox jobSpec).
- **So for 6.2:** store the MCP bearer token as `encCredential` (encrypted, `crypto.ts`), mask it in `view()`. **Runtime custody is 6.4** — the orchestrator will decrypt it and attach it to a new `ProvisionTool` on `RunProvision`; the egress-guard holds it for the run and reaps it at teardown (its `RunState.credentials` per-run model, extended with a tool adapter at the `ADAPTERS` seam). 6.2 builds only the *storage*; nothing in 6.2 puts the credential on the wire to a sandbox.

### The MCP handshake (from the spec research, 2025-11-25 stable)
- **Transport:** Streamable HTTP (single endpoint, POST for calls, optional SSE). The SDK's `StreamableHTTPClientTransport` speaks it.
- **Auth:** a bearer token on every request — the client (control-api, here) sets `Authorization`. A remote MCP's OAuth is between control-api and the server; the *agent* never participates (AD-10). For MVP the builder pastes a static bearer token; full interactive OAuth is out of scope.
- **Discovery:** `client.connect()` runs `initialize`; `client.listTools()` returns descriptors (`name`, `title?`, `description?`, `inputSchema` JSON-Schema) → `ToolOperation[]`. `listTools()` auto-paginates.
- **Errors:** a protocol failure throws (caught → `error`); this story doesn't call tools, so `isError` (a 200-with-tool-error) is a 6.4 concern.
- **Client lib:** `@modelcontextprotocol/sdk` — `import { Client } from "@modelcontextprotocol/sdk/client/index.js"`, `import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"` (v1 stable, protocol 2025-11-25). Verify the exact import subpaths + the header-injection API on the installed version at dev time.

### Architecture (binding)
- **AD-10:** the credential is encrypted at rest, masked in `view()`, never returned to the browser, never on the sandbox wire. Assert it in tests.
- **AD-5 (verify at the control plane):** control-api performs the connect-time handshake directly (like `gateway.verify` hits `/v1/models`) — this is the trusted control plane verifying a connection, NOT the sandbox reaching out. The sandbox→tool runtime path (through the Guard) is 6.4.
- **AD-7:** control-api is the sole writer of Tool state.
- **Story 2.1 fail-closed verify:** never persist a bad connection — a failed handshake returns the error, stores nothing.

### Existing patterns to mirror (from the codebase scan)
- **Connect+verify+mask:** `connections/routes.ts` `POST /connections/providers` (verify-first at :92; `keyLast4`/`view()` masking at :14-27,:83). Mirror the sequence; substitute the MCP handshake for `gateway.verify`, and `encCredential` (encrypted) for the LiteLLM hand-off.
- **Encrypted-at-rest credential:** `dataConnections.encRefreshToken` (schema.ts:51), `dataRepo.ts` (encRefreshToken never in `view`), `secrets/crypto.ts` (`encryptSecret`/`decryptSecret`, `TOKEN_ENC_KEY`), `oauth/routes.ts:73` (encrypt on connect), `orchestrator.ts` resolveRunConnections:104-116 (decrypt→provision at run time — the 6.4 template).
- **Injectable verifier (test double):** `litellm/gateway.ts` `ModelGateway` + `fakeModelGateway` — the exact shape for `McpVerifier` + `fakeMcpVerifier`; injected in `app.ts` (`deps.modelGateway ?? fakeModelGateway()`).
- **Connect form:** `settings/providers/+page.svelte` add-form (name/baseUrl/apiKey, `onConnect`, error display, busy gating, the discovered-items list from 2.4) → the tools connect form template.
- **6.1 foundation:** `tools/repo.ts` (ToolRow/ToolsRepo — extend), `tools/routes.ts` (view mask + list/get/delete — add connect), `$lib/tools.ts` + `settings/tools/+page.svelte` (activate "Add a tool"), contracts `JobTool`/`ToolCall*` (unchanged), domain `Tool`/`ToolOperation`/`ToolStatus` (`unverified`→`connected`/`error`).
- **A new Docker service fixture:** `apps/egress-guard/Dockerfile` + its `compose.yaml` service block (:105-133) = the template for `mcp-stub`.
- **Migration:** next is `0012`; `drizzle-kit generate` (house command); applied on boot via `db/migrate.ts`.

### Project Structure Notes
- New: `apps/control-api/src/tools/mcp.ts`, `drizzle/0012_*.sql`, `apps/mcp-stub/**` (a new workspace app + Dockerfile), a `mcp-stub` compose service. Edited: `tools/{repo,routes}.ts`, `db/schema.ts`, `app.ts`, `server.ts`, `$lib/tools.ts`, `settings/tools/+page.svelte`, `apps/control-api/package.json` (+ SDK), `deploy/compose.yaml`, the tools e2e + unit tests.
- The SDK is a **new dependency** (approved). The stub app raises the workspace count to 7 (build is `pnpm -r`).
- Scope guard: NO runtime tool invocation, NO agent Tools section, NO per-op grants, NO container tools. Those are 6.3 / 6.4 / Epic 7.

### Testing standards
- Vitest for the control-api connect route (with `fakeMcpVerifier`; `TOKEN_ENC_KEY` set) — assert AD-10 (no plaintext credential in the row/view, encrypted blob present) + fail-closed (no persist on verify failure). Playwright serial e2e via the **isolated `deploy/test-stack.sh`** now including the `mcp-stub` service — the connect+discover flow is deterministic (Add a tool → stub URL → connected + operations listed). Distinct `x-forwarded-for` per `signIn`; `pnpm -r build` before any Docker build; **never `down -v` the dev stack.**

### References
- [Source: _bmad-output/planning-artifacts/epics.md#Epic-6, #Story-6.2]
- [Source: _bmad-output/implementation-artifacts/6-1-tool-model-and-management.md — the Tool entity, repo, routes, contract, domain types this extends]
- [Source: architecture spine #AD-5, #AD-7, #AD-10; Story 2.1 (verify-first), Story 2.2/4.3 (encRefreshToken + orchestrator decrypt→provision)]
- [Source: MCP spec 2025-11-25 — Streamable HTTP, tools/list, bearer auth; @modelcontextprotocol/sdk client (Client + StreamableHTTPClientTransport)]
- [Source: user decisions 2026-08-03 — official SDK + a stub MCP server for deterministic e2e]
- [Source: deploy/test-stack.sh + the 2026-08-03 infra fix — isolate e2e; never `down -v` the dev stack]

## Dev Agent Record

### Agent Model Used
claude-opus-4-8[1m] (Claude Code)

### Debug Log References
- Verified the real MCP handshake end-to-end before wiring e2e: ran `apps/mcp-stub/dist/server.js`, connected an SDK `Client` + `StreamableHTTPClientTransport` → `listTools()` returned `echo`, `get_time` with descriptions. Confirms `httpMcpVerifier` will discover against the stub.
- e2e: two `agents.spec.ts` tests flaked on `signIn` (login POST throttled → stayed on `/login?`), unrelated to tools. Re-ran `providers.spec.ts` on a pristine e2e DB (`test-stack.sh reset`) — all 6 green, including the 6.2 connect+discover test and the (updated) 6.1 test.

### Completion Notes List
- **MCP verifier (Task 1):** `tools/mcp.ts` — injectable `McpVerifier` (the `ModelGateway` analogue). `httpMcpVerifier()` connects a `Client` + `StreamableHTTPClientTransport(new URL(url))`, injects `Authorization: Bearer <credential>` via `requestInit.headers` when present, runs `initialize` + `listTools()` (auto-paginates), maps descriptors → `ToolOperation[]`, fail-closed try/catch → `{ ok:false, error }`, closes the transport in `finally`. `fakeMcpVerifier({ ok?, error?, operations? })` mirrors `fakeModelGateway`. **No `CONTRACT_VERSION` bump** (server-side only).
- **Schema + credential custody (Task 2, AD-10):** `tools` table gained `url text` + `enc_credential text` (migration `0012_chilly_ultron.sql`). The bearer token is stored **encrypted at rest** via the existing `encryptSecret` (`TOKEN_ENC_KEY`, AES-256-GCM) — the OAuth precedent, not the LiteLLM one. `encCredential` is internal-only; the route `view()` never returns it, exposing only `url` + a derived `credentialSet: boolean`.
- **Connect route (Task 3):** `POST /tools` — verify FIRST; a failed handshake returns `400 { error }` and persists **nothing** (fail-closed, no orphan rows). On success, persists a `connected` tool with the discovered operations. `toolRoutes(repo, verifier)`; `app.ts` defaults to `fakeMcpVerifier()`, `server.ts` wires `httpMcpVerifier()`.
- **Web (Task 4):** `connectTool()` client + `url`/`credentialSet` on the `Tool` type. `settings/tools/+page.svelte` — the disabled "Add a tool" button is now an active toggle opening a connect form (Name / MCP server URL / optional Credential password), busy state, inline `role="alert"` error. Each connected card shows its `url` (mono), a "credential set" indicator when a credential is held (never the value), and lists the operation names + count.
- **Stub MCP server (Task 5):** `apps/mcp-stub/` — a stateless Streamable HTTP MCP server (`McpServer` + `StreamableHTTPServerTransport`, `sessionIdGenerator: undefined`, `enableJsonResponse: true`) exposing `echo` + `get_time` on `:9000/mcp`, with optional `MCP_STUB_TOKEN` bearer auth. Added a `mcp-stub` compose service (internal only, `http://mcp-stub:9000/mcp`) — runs in both the dev and isolated `turanga-e2e` stacks. Holds no secrets; outside the trust boundary.
- **Tests (Task 6):** control-api `tools.test.ts` gained a "connect a remote MCP tool" describe (4 tests: verify+discover+persist with an encrypted-not-plaintext credential and AD-10 no-echo; no-auth → `credentialSet:false`; fail-closed 400 persisting nothing; name/url required). Playwright: updated the 6.1 test (button now enabled) + a new 6.2 test connecting to the live stub → `connected` with `echo`/`get_time` listed, plus a bad-URL → error/no-persist path, cleaning up after itself.
- **Verification:** `pnpm -r build` (8 workspaces — the story estimated 7; the repo already had 7 before mcp-stub) · `svelte-check` 0/0 · `eslint .` clean · units 133 passed +1 skipped (control-api) / all suites green · e2e via the isolated `test-stack.sh` (never `down -v` the dev stack) — providers/tools spec 6/6 green on a pristine DB. Dev stack restored afterward; data intact (`Clyde`, `Untitled agent`, `wopr`), mcp-stub healthy in dev too.
- **Scope held:** no runtime tool invocation (6.4), no per-agent grants (6.3), no container tools (Epic 7).

### File List
- `apps/control-api/package.json` (+ `@modelcontextprotocol/sdk` 1.30.0) · `pnpm-lock.yaml`
- `apps/control-api/src/tools/mcp.ts` (NEW — verifier)
- `apps/control-api/src/db/schema.ts` (tools: `url` + `encCredential`)
- `apps/control-api/drizzle/0012_chilly_ultron.sql` (NEW) + `meta/_journal.json` + `meta/0012_snapshot.json`
- `apps/control-api/src/tools/repo.ts` (ToolRow: `url` + `encCredential`)
- `apps/control-api/src/tools/routes.ts` (POST /tools connect; view masks encCredential, adds url + credentialSet)
- `apps/control-api/src/app.ts` (mcpVerifier dep + default) · `apps/control-api/src/server.ts` (wire httpMcpVerifier)
- `apps/control-api/src/tools/tools.test.ts` (Story 6.2 connect describe)
- `apps/web/src/lib/tools.ts` (connectTool + url/credentialSet)
- `apps/web/src/routes/(app)/settings/tools/+page.svelte` (connect form + enriched card)
- `apps/web/tests/providers.spec.ts` (6.1 test updated + 6.2 connect e2e)
- `apps/mcp-stub/**` (NEW workspace app: package.json, tsconfig.json, src/server.ts, Dockerfile)
- `deploy/compose.yaml` (mcp-stub service)

### Change Log
- 2026-08-03 — Story 6.2 implemented: connect a remote MCP tool by URL + credential — a real MCP handshake verifies + discovers operations (control-api `httpMcpVerifier`, official SDK), the credential is held encrypted-at-rest per AD-10 (never echoed, never on the sandbox wire), fail-closed on a bad handshake. Web connect form + operation listing. New `mcp-stub` fixture app + compose service for deterministic dev/e2e. Status → review.
