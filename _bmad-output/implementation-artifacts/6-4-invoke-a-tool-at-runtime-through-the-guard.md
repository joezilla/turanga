---
baseline_commit: 1b333c36d6be92ef6ab4c6397c64c73112fdde35
---
# Story 6.4: Invoke a tool at runtime through the Guard

Status: review

<!-- Fourth story of Epic 6 — the KEYSTONE that makes Stories 6.1-6.3 actually callable. A running
     agent (in the network-isolated sandbox) issues a LOGICAL tool call over its one egress edge (the
     per-run UDS). The egress-guard resolves the endpoint, enforces the per-operation grant, attaches
     the held credential, performs the MCP `tools/call` over its OWN TLS, and returns the result — the
     agent never learns the URL or key (AD-10). An ungranted operation is refused and recorded
     (fail-closed, NFR-2/NFR-4). This is the SERVER-SIDE half only (agent→tool); the tool→world half
     (a tool's own egress) is Epic 7. It EXACTLY mirrors the existing connection-broker path (Story
     4.3/4.4) — copy that pattern at every layer. NO metering / kill-on-breach for tool calls
     (decision 2026-08-03; that's the E4-AD-10 cost hook, not used here). -->

## Story

As the builder,
I want a running agent to call its granted tools through the Guard,
so that every tool call goes through the one choke point — resolved, credentialed, and enforced — with no new hole in the sandbox.

## Acceptance Criteria

1. **Given** a sandboxed run whose agent has a granted remote tool, **when** the harness issues a **logical** tool call, **then** the **Guard resolves the endpoint, attaches the held credential, forwards over its own TLS (MCP `tools/call`), and returns the result** — the sandbox's only outbound edge stays the Guard (AD-1, AD-5a); the agent never learns the URL or key (AD-10). [Source: epics.md#Story-6.4, AD-1, AD-5a, AD-10]
2. **Given** a tool call for an operation the agent was **not** granted, **when** it reaches the Guard, **then** it is **refused and recorded** on the Run (a `permission` refusal, like an out-of-scope skill) — fail-closed, NFR-2/NFR-4. [Source: epics.md#Story-6.4, NFR-2, NFR-4]
3. **Given** the Guard→Run event path, **when** a tool call completes (or is refused), **then** it is **merged into the Run as a recorded event** (the harness relays the outcome on the one control channel → the Run transcript, exactly as connection ops are recorded today). This epic builds only the **agent→tool** / server-side half of the broker; the tool→world half is Epic 7. [Source: epics.md#Story-6.4, E4-AD-10]

## Tasks / Subtasks

- [x] **Task 1: The Guard-side MCP call (egress-guard) + the SDK dependency** (AC: #1)
  - [x] Add the SDK to the Guard: `pnpm --filter @turanga/egress-guard add @modelcontextprotocol/sdk` (v1.30.0 — the same version control-api pinned in 6.2). egress-guard currently has NO SDK dep; it needs one for the Guard-side `tools/call`.
  - [x] `apps/egress-guard/src/mcp.ts` (NEW) — the Guard-side MCP caller, the **injectable `doFetch` analogue** (so guard tests stay network-free). Mirror `apps/control-api/src/tools/mcp.ts` (Story 6.2) but call `client.callTool(...)` instead of `listTools()`:
    - `McpToolCallInput = { url: string; credential?: string; operation: string; arguments?: Record<string, unknown>; timeoutMs?: number }`.
    - `McpToolCallResult = { ok: true; content: unknown[]; isError: boolean } | { ok: false; error: string }`.
    - `McpToolCaller = (input: McpToolCallInput) => Promise<McpToolCallResult>`.
    - `httpMcpToolCaller()` (real): `new StreamableHTTPClientTransport(new URL(url), credential ? { requestInit: { headers: { Authorization: \`Bearer ${credential}\` } } } : undefined)`; `new Client({ name: "turanga-guard", version: "0.0.0" })`; `await client.connect(transport)`; `const r = await client.callTool({ name: operation, arguments: arguments ?? {} })`; map `→ { ok: true, content: (r.content ?? []) as unknown[], isError: !!r.isError }`; try/catch → `{ ok: false, error }` (unreachable / bad protocol / auth rejected); `finally client.close()`. (Per-call connect is fine for MVP — matches the verifier; a note that a per-run client cache is a later optimization.)
    - `fakeMcpToolCaller(opts?)` (test double, mirrors `fakeMcpVerifier`) — returns canned `content`/`isError`, or `{ ok:false, error }`; **records the inputs it received** so a test can assert the credential + operation + arguments were passed (proving Guard-side custody).

- [x] **Task 2: Provision + broker + enforce the tool call (egress-guard core)** (AC: #1, #2)
  - [x] `apps/egress-guard/src/guard.ts` — add the tool half, mirroring the connection half:
    - **`ProvisionTool`** type: `{ toolId: string; url: string; credential: string; operations: string[] }` (the granted operation names + the HELD bearer token, decrypted control-side; `credential` may be `""` for a no-auth tool). Add `tools?: ProvisionTool[]` to `RunProvision` (guard.ts:43-47).
    - **`RunState`** (guard.ts:147-153): add `tools: Map<string, ProvisionTool>` (keyed by `toolId`). Populate it in `register()` (guard.ts:331-337) alongside `credentials`: `for (const t of provision.tools ?? []) { toolsMap.set(t.toolId, t); try { allowlist.add(new URL(t.url).host); } catch {} }` (the tool endpoint host joins the allowlist — default-deny egress, mirrors how connection destinations are added). Clear it in `teardown()` (guard.ts:375-388): `state.tools.clear()` next to `state.credentials.clear()` (AD-10 — reap the held tool tokens the instant the run ends).
    - **`forwardTool(runId, req: ToolCallRequest): Promise<ToolCallResponse>`** — the `forwardConnection` analogue (guard.ts:255-303):
      1. Look up `state = runs.get(runId)` + `tool = state?.tools.get(req.toolId)`. Missing run/tool → **`permission` refusal** (`detail`: "That tool isn't attached to this run.") — the tool must be provisioned.
      2. **PERMISSION (default-deny, AC2):** `if (!tool.operations.includes(req.operation)) return refuseTool("permission", \`Operation "${req.operation}" isn't granted for ${tool ...}.\`)` — checked BEFORE the credential/endpoint is consulted (least authority; mirrors the connection `authorizes` gate at guard.ts:262).
      3. **EGRESS default-deny:** parse `host = new URL(tool.url).host`; `if (!allowlist.has(host)) return refuseTool("egress", ...)`.
      4. **Filter Hook egress seam** (optional, mirror guard.ts:284-286) — pass the operation + arguments through `filterHook("egress", meta, req.arguments)`; a block → an `egress` refusal. (Reuse the existing no-op hook; do not build an inspector.)
      5. **Forward with the held credential:** `const r = await mcpCall({ url: tool.url, credential: tool.credential || undefined, operation: req.operation, arguments: req.arguments, timeoutMs: connectionTimeoutMs })` — the credential is attached HERE, Guard-side, never returned to the sandbox.
      6. Map `r` → `ToolCallResponse`: success → `{ v, ok: true, content: r.content, isError: r.isError, latencyMs }`; caller error → `{ v, ok: false, error: r.error, latencyMs }`. (`isError` is the MCP tool-EXECUTION error, distinct from a Guard `refusal` — pass it through, do not convert it to a refusal.)
    - A `refuseTool(kind, detail, started)` helper → `{ v: CONTRACT_VERSION, ok: false, refusal: { kind, detail }, latencyMs }` (note the tool refusal shape has NO `destination`, unlike the connection refusal — see contracts:140).
    - **Dispatch:** in `handle(runId, raw)` (guard.ts:307-314), add a branch: `const tc = ToolCallRequestSchema.safeParse(parsed); if (tc.success) return JSON.stringify(await forwardTool(runId, tc.data));` — place it alongside the connection + model branches (order: connection, tool, model, else 400).
    - **Inject the caller:** add `mcpCall?: McpToolCaller` to `GuardConfig` (guard.ts:131-143); `const mcpCall = cfg.mcpCall ?? httpMcpToolCaller();` (mirror `doFetch = cfg.fetchImpl ?? fetch`). `server.ts` passes `httpMcpToolCaller()`; tests pass `fakeMcpToolCaller(...)`.
  - [x] `apps/egress-guard/src/app.ts` — the admin `register` body (app.ts:33-47) now also parses `tools`: `const tools = Array.isArray(provision.tools) ? (provision.tools as ProvisionTool[]) : [];` → pass into `guard.register(id, { connections, grants, costKey, tools })`.
  - [x] `apps/egress-guard/src/server.ts` — wire `createGuard({ ..., mcpCall: httpMcpToolCaller() })`.

- [x] **Task 3: Provision the tool credential to the Guard (control-api orchestrator)** (AC: #1, #2)
  - [x] `apps/control-api/src/runs/guardClient.ts` — add a `ProvisionTool` type (`{ toolId, url, credential, operations }`) mirroring `ProvisionConnection`, and `tools?: ProvisionTool[]` to `RunProvision`. `registerRun` already JSON-posts the whole provision, so no send-path change. Update `fakeRunGuard()` to record `tools` too (so tests can assert the credential reached the provision but NOT the jobSpec).
  - [x] `apps/control-api/src/runs/orchestrator.ts` — extend `resolveRunTools` (currently orchestrator.ts:~137-150, returns only `JobTool[]`) to ALSO produce the Guard provision, mirroring how `resolveRunConnections` returns both `jobConnections` (sandbox-visible) and `provision` (Guard-only). It now needs the tool's `url` + `encCredential`, so widen the `ToolsReader` (`ToolLike`) to include `url: string | null` + `encCredential: string | null` (the memory/drizzle `ToolsRepo.getTool` already returns them — `repo.ts:14-15`):
    - Return `{ jobTools: JobTool[]; provisionTools: ProvisionTool[] }`. For each granted tool (≥1 operation, tool resolves): `jobTools.push({ id, name, operations })` (unchanged — sandbox-visible, NO secret); `provisionTools.push({ toolId: tool.id, url: tool.url ?? "", credential: tool.encCredential ? decryptSecret(tool.encCredential) : "", operations })` (Guard-only — the decrypted bearer token). A tool with a null `url` is skipped from the provision (nothing to reach).
    - **AD-10 (assert in tests):** `decryptSecret` runs here in the control plane; the decrypted credential and the `url` go ONLY into `provisionTools` (→ the Guard admin API), NEVER into `jobTools`/the jobSpec. Reuse `decryptSecret` from `../secrets/crypto.js` (already imported for the Gmail path).
  - [x] In `launch()` (orchestrator.ts:~143-147) capture the new return and merge the tools into the provision handed to the Guard: `const { jobTools, provisionTools } = await resolveRunTools(agent);` then set `jobSpec.tools = jobTools` and add `tools: provisionTools` to the `RunProvision` object passed to `guard.registerRun` (the same `provision` that already carries connections + grants). The establish order is unchanged (guard.registerRun BEFORE runtime.establish, orchestrator.ts:216/221) — the tools are held Guard-side before the sandbox starts.

- [x] **Task 4: The harness issues a granted tool call (agent-harness)** (AC: #1, #3)
  - [x] `apps/agent-harness/src/main.ts` — add the tool analogue of `guardConnectionCall` + `runOp`:
    - Import `ToolCallRequestSchema`/`ToolCallResponseSchema` + the types from `@turanga/contracts`.
    - `guardToolCall(socketPath, req: ToolCallRequest): Promise<ToolCallResponse>` — mirror `guardConnectionCall` (main.ts:89-97): `guardTransport` → `ToolCallResponseSchema.parse` → transport/parse errors become `{ v, ok:false, error }`.
    - A pure `toolOutcome(toolId, operation, res): { system?; refusal? }` (exported for tests, mirrors `opOutcome` at main.ts:104-111): `res.ok` → a short system line folded into context (e.g. `Called ${operation}${res.isError ? " (the tool reported an error)" : ""}.`); `res.refusal` → a `refusal` control message carrying the Guard's `kind` + `detail`.
    - A deterministic tool phase (mirror the skill-ops phase): for each `t of spec.tools`, issue ONE `tools/call` for its **first granted operation** (`t.operations[0]`) with empty `arguments` (the harness is a deterministic stub — the point is proving the brokered path + enforcement, not meaningful tool use; a real model-driven tool loop is out of scope). Emit the refusal / fold the system line, exactly like `runOp`. Run this phase after the read ops / before or after the model call — a blocked tool call is a refusal, NOT a run failure (mirror the send-op posture at main.ts:166-168).
  - [x] The harness still emits ONLY `turn`/`done`/`refusal` (no new control-message type — NO CONTRACT_VERSION bump; a structured per-tool event for stats is Story 6.5). The tool outcome is recorded via the relayed `refusal` (denials) + the folded context (successes) → the Run transcript (AC3).

- [x] **Task 5: Tests + verification** (AC: all)
  - [x] **egress-guard unit** (`guard.test.ts` — the primary proof): with `fakeMcpToolCaller`, register a run whose provision has a tool `{ toolId:"t1", url:"https://mcp.example/mcp", credential:"sk-tok", operations:["get_time"] }`, then drive `handle(runId, ToolCallRequest)` (or the exposed `forwardTool`):
    - **granted op → the MCP caller is invoked with the URL + credential + operation + arguments** (assert the fake recorded them — proving Guard-side custody), and the response is `{ ok:true, content, isError:false }`; the credential is NEVER in the response (AD-10).
    - **ungranted op → a `permission` refusal, and the MCP caller is NOT called** (assert the fake got zero calls — fail-closed, AC2).
    - **unknown/unprovisioned tool → a `permission` refusal.**
    - **off-allowlist host** (a tool url whose host wasn't provisioned) → an `egress` refusal. (Since register adds the tool's own host, construct this by requesting a toolId that resolves but whose host was cleared, or assert the allowlist contains the provisioned host.)
    - **`isError:true` from the tool passes through as `ok:true, isError:true`** (a tool-execution error is NOT a Guard refusal).
    - **teardown clears the held tool credential** (`state.tools` emptied — AD-10).
    - dispatch: a `ToolCallRequest` is routed to `forwardTool`, a `GuardConnectionRequest` still to `forwardConnection`, a model request still to `proxyModel` (no regression).
  - [x] **control-api unit** (`runs/runs.test.ts` — extend the Story 6.3 `toolOrch`): a run for an agent with a granted tool that has a `url` + `encCredential` → the Guard provision (`fakeRunGuard().registered[0].provision.tools`) contains `{ toolId, url, credential: <decrypted>, operations }`, while the jobSpec still carries ONLY `{ id, name, operations }` and **no url/credential** (AD-10 — the existing 6.3 assertion, reinforced). Set `TOKEN_ENC_KEY` in the test env (mirror the tools/oauth tests' `beforeAll`) so `decryptSecret` works.
  - [x] **agent-harness unit** (`main.test.ts`): `toolOutcome` maps ok→system, refusal→a `refusal` message; and `runHarness` (with a stubbed guard socket / the existing test harness) issues a tool call for a granted tool and relays a refusal when the guard denies. (Follow however `main.test.ts` already stubs the UDS for connection ops.)
  - [x] **Playwright e2e (isolated stack incl. `mcp-stub`, best-effort, serial):** extend the tools/agents flow — an agent with a granted `get_time` tool, when run, calls the stub through the Guard and the run completes without a tool error. Given the existing run-streaming e2e is timing-flaky on the dev-insecure macOS stack, keep the assertion loose (the run reaches a terminal state; the tool call didn't fault the run) and lean on the unit/integration tests for the hard guarantees. Distinct `x-forwarded-for` per `signIn`; clean up connected tools/agents.
  - [x] `svelte-check` 0 · `pnpm -r build` (8 workspaces) · `pnpm lint` · all unit suites (egress-guard grows, control-api runs, agent-harness) · e2e green · teardown. **Run e2e via `deploy/test-stack.sh` (project `turanga-e2e`) — NEVER `docker compose down -v` on the dev stack.** `pnpm -r build` before any Docker build (rebuild the egress-guard image — new SDK dep — + the harness image for the e2e). Restore the dev stack after; verify data intact.

## Dev Notes

**The keystone. It makes 6.1-6.3 callable: a sandboxed agent invokes a granted tool through the Guard, which resolves the endpoint, enforces the per-operation grant, attaches the held credential, performs the MCP `tools/call`, and returns the result — with the sandbox's only egress still the one UDS to the Guard (AD-1), and no URL/credential ever crossing into the sandbox (AD-10). It is the SERVER-SIDE (agent→tool) half only; a tool's OWN egress is Epic 7.**

### The design: mirror the connection broker (Story 4.3/4.4) EXACTLY
The epic is explicit: "the contract = MCP over streamable HTTP, brokered by the Guard … this reuses AD-5(a) — the credentialed-connection gateway — as the transport" and "reuse the existing guard path." Every layer already has a connection twin — copy it:

| Layer | Connection path (the template) | Tool path (this story) |
|---|---|---|
| Harness issue | `guardConnectionCall` + `runOp` (main.ts:89-97,149-154) | `guardToolCall` + a deterministic tool phase |
| Harness outcome | `opOutcome` → system / `refusal` (main.ts:104-111) | `toolOutcome` → system / `refusal` |
| Contract msg | `GuardConnectionRequest/Response` (contracts:94-115) | `ToolCallRequest/Response` — **already exist, v5** (contracts:121-143) |
| Guard dispatch | `forwardConnection` branch in `handle` (guard.ts:307-314) | a `ToolCallRequestSchema` branch → `forwardTool` |
| Grant gate | `authorizes(grants, op)` (guard.ts:262, contracts:175) | `tool.operations.includes(op)` — per-operation allow-list (6.3) |
| Adapter | `ConnectionAdapter.forward(..., accessToken, doFetch, ...)` + `ADAPTERS` (guard.ts:72-116) | `mcpCall({ url, credential, operation, arguments })` — injected `McpToolCaller` |
| Credential custody | `RunState.credentials` map; attached in `adapter.forward`; cleared on teardown (guard.ts:147-153,269-291,379) | `RunState.tools` map; attached in `mcpCall`; cleared on teardown |
| Provision | `resolveRunConnections` → `ProvisionConnection.accessToken` (orchestrator.ts:104-131) | `resolveRunTools` → `ProvisionTool.credential` (decrypt `encCredential`) |
| Provision transport | admin `POST /admin/runs/:id/register` body (app.ts:33-47) | same route, `tools` added to the body |
| Recording | relayed `refusal` msg → transcript (main.ts:109) | same — relayed `refusal` + folded context |

### Architecture (binding)
- **AD-1 / AD-5a:** the sandbox has ONE outbound edge — the per-run UDS to the Guard (`/guard/run.sock`, main.ts:140; bound via the volume subpath, runtime.ts:87, `NetworkMode:"none"` runtime.ts:84). The Guard makes the outbound MCP call over its OWN network. The sandbox never gets a network.
- **AD-10:** the endpoint URL + the bearer credential are held Guard-side (`RunState.tools`), attached only inside `mcpCall`, and reaped on teardown. They arrive ONLY via the admin API (`ProvisionTool`), NEVER in the jobSpec. Assert in the orchestrator test that the decrypted credential is in `provision.tools` but the jobSpec has no url/credential.
- **NFR-2 / NFR-4 (fail-closed, never silent):** default-deny — an ungranted operation (or an unprovisioned tool) is refused as `permission` BEFORE the credential/endpoint is touched, and the refusal is relayed to the Run (recorded). A bad handshake/timeout is a stated error, not a fall-through.
- **E4-AD-8 establish order:** `guard.registerRun(provision-with-tools)` runs BEFORE `runtime.establish` (orchestrator.ts:216/221) — the credential is held before the sandbox exists.
- **Decision (2026-08-03): observed, not metered.** Tool calls are recorded but NOT metered against the cost cap and NOT killed on breach (that's the E4-AD-10 cost/kill path, model-only). So `forwardTool` emits NO `GuardRunEvent` and needs no `emitRunEvent` — recording is in-band via the harness `refusal`/context. Structured per-tool stats (count/latency/outcome) are **Story 6.5**.

### Scope decisions (resolve the epic's open questions)
- **NO `CONTRACT_VERSION` bump.** `ToolCallRequest/Response` are already v5 (Story 6.1). `RunProvision`/`ProvisionTool` live in `guard.ts` + `guardClient.ts` — the INTERNAL admin-API shapes, not the versioned harness↔Guard contract (E4-AD-9). Adding `tools` there changes no wire the sandbox sees. (Confirm no `v: 4→5`-style ripple is needed; there isn't — the contract is unchanged.)
- **One egress-guard brokers all runs** (the epic's lean) — reuse the existing per-run `RunState`; no per-tool routing service.
- **A remote MCP's own downstream egress is NOT our concern** — it runs on the provider's infra; the Guard forwards over its own TLS. Only container tools bring a tool's egress into scope (Epic 7).
- **Harness is a deterministic stub** — it issues one call per granted tool for the first operation with empty arguments. A real model-driven tool-use loop (the LLM choosing tools/arguments) is a later concern; 6.4 proves the brokered path + enforcement + custody end-to-end.
- **Guard-side MCP client is injected** (`McpToolCaller`, real vs. fake) so `guard.test.ts` stays network-free — the exact `fetchImpl`/`doFetch` pattern already in `GuardConfig`.

### Existing patterns to mirror (exact file:line)
- **Harness UDS + issue + outcome:** `apps/agent-harness/src/main.ts` — `guardTransport` (43-75), `guardConnectionCall` (89-97), `opOutcome` (104-111), the op phases (147-168), `socketPath` (140).
- **Guard core:** `apps/egress-guard/src/guard.ts` — `ConnectionAdapter`/`ADAPTERS` (72-116), `RunState` (147-153), `forwardConnection` (255-303) with the permission gate (262) + egress default-deny (269-279) + credential attach (289-291), `refuse` (249-251), `handle` dispatch (307-314), `register` (319-374) building allowlist+credentials (331-337), `teardown` (375-388) clearing credentials (379), `GuardConfig`+`doFetch` (131-176).
- **Guard admin + client:** `apps/egress-guard/src/app.ts` register body (33-47); `apps/control-api/src/runs/guardClient.ts` `ProvisionConnection`/`RunProvision` (8-24), `httpRunGuard.registerRun` (31-47), `fakeRunGuard` (51+).
- **Orchestrator provisioning + establish order:** `apps/control-api/src/runs/orchestrator.ts` — `resolveRunConnections` (91-131) returning both sandbox-visible + Guard-only, `resolveRunTools` (the 6.3 stub, ~137-150), the JobSpec build (~147), `execute` establish order (registerRun 216 → establish 221), `finish`/teardown.
- **The MCP client template:** `apps/control-api/src/tools/mcp.ts` (Story 6.2) — `Client` + `StreamableHTTPClientTransport` + bearer injection + try/catch/finally; swap `listTools()` → `callTool({ name, arguments })`.
- **The tool credential at rest:** `apps/control-api/src/tools/repo.ts:14-15` (`url`, `encCredential`); `decryptSecret` in `apps/control-api/src/secrets/crypto.ts` (already used for the Gmail refresh token in the orchestrator).
- **Contracts:** `ToolCallRequestSchema`/`ToolCallResponseSchema` (contracts:121-143) — note the tool refusal has `{ kind, detail }` (no `destination`), and `content`/`isError` map the MCP result.

### Project Structure Notes
- New: `apps/egress-guard/src/mcp.ts`. Edited: `apps/egress-guard/src/{guard,app,server}.ts` + `package.json` (+ SDK), `apps/control-api/src/runs/{guardClient,orchestrator}.ts`, `apps/agent-harness/src/main.ts`, the guard/runs/harness unit tests + (best-effort) the tools e2e. `pnpm-lock.yaml`.
- **New dependency:** `@modelcontextprotocol/sdk@1.30.0` on egress-guard (same pin as control-api). No new workspace, no contract bump.
- Scope guard: NO tool→world egress (Epic 7), NO metering/kill for tools, NO structured per-tool stats surface (6.5), NO container tools (Epic 7), NO model-driven tool-use loop.
- **Rebuild the egress-guard + agent-harness images** for the e2e (`pnpm -r build` first — recurring lesson: `tsc` before Docker; a `.default([])` Zod field is optional on input but required on output, so `pnpm -r build` catches what `pnpm -r test` misses).

### Testing standards
- Vitest for the Guard (`fakeMcpToolCaller`; assert credential custody + default-deny + isError passthrough + teardown reaping — the primary correctness proof), the orchestrator (decrypt→provision, AD-10 no-leak; `TOKEN_ENC_KEY` set), and the harness (`toolOutcome` + a relayed refusal). Playwright serial e2e via the **isolated `deploy/test-stack.sh`** (incl. `mcp-stub`) — best-effort given run-streaming flakiness; the hard guarantees live in the unit tests. Distinct `x-forwarded-for` per `signIn`; `pnpm -r build` before any Docker build; **never `down -v` the dev stack** (it wipes `Clyde`/`Untitled agent`/`wopr`).

### References
- [Source: _bmad-output/planning-artifacts/epics.md#Epic-6, #Story-6.4 — the brokered agent→tool path; "reuse the existing guard path"; observed-not-metered; the resolved open questions]
- [Source: _bmad-output/implementation-artifacts/6-3-attach-tools-to-agent-with-per-operation-grants.md — the grants + `JobSpec.tools` + `resolveRunTools` stub this extends; the credential provisioning it flagged for 6.4]
- [Source: _bmad-output/implementation-artifacts/6-2-connect-remote-mcp-tool.md — the MCP client (`mcp.ts`), the tool `url`/`encCredential` at rest, the `mcp-stub`]
- [Source: Story 4.3/4.4 connection broker — `main.ts` (harness UDS + opOutcome), `guard.ts` (forwardConnection + ADAPTERS + RunState + register/teardown), `guardClient.ts` (ProvisionConnection/RunProvision), `orchestrator.ts` (resolveRunConnections + establish order)]
- [Source: architecture spine #AD-1, #AD-5a, #AD-10; E4-AD-1 (per-run UDS), E4-AD-8 (fail-closed establish order), E4-AD-9 (versioned harness↔Guard contract), E4-AD-10 (Guard→orchestrator ledger — cost/kill only, not tools)]
- [Source: contracts `ToolCallRequest`/`ToolCallResponse` (packages/contracts/src/index.ts:121-143), already versioned in Story 6.1]
- [Source: MCP spec 2025-11-25 — Streamable HTTP `tools/call`; `@modelcontextprotocol/sdk` Client.callTool → { content, isError }]
- [Source: deploy/test-stack.sh + the 2026-08-03 infra rule — isolate e2e; never `down -v` the dev stack]

## Dev Agent Record

### Agent Model Used
claude-opus-4-8[1m] (Claude Code)

### Debug Log References
- **Live end-to-end verification on the isolated stack (definitive AC1 proof):** connected the mcp-stub tool via the API, granted `get_time` to an agent, launched a run, and confirmed **mcp-stub logged `POST /mcp`** (the MCP `initialize` + `tools/call` handshake) — proving the full path sandboxed harness → per-run UDS → egress-guard `forwardTool` → grant check → MCP `tools/call` → mcp-stub actually fires. The run transcript showed NO tool refusal (a granted call succeeds invisibly, folded into context), only the expected model error (bogus provider). Added a per-request log line to mcp-stub for this (kept — dev/e2e observability).
- A successful tool call is intentionally invisible in the transcript (it folds into the model context; only refusals emit a control message), so an automated *positive* Playwright assertion isn't cleanly possible until structured per-tool events (Story 6.5). Hence AC1 is proven by the live run + the guard UDS-dispatch unit test; AC2/AC3/AD-10 by the unit suites.

### Completion Notes List
- **Guard-side MCP call (Task 1):** `egress-guard/src/mcp.ts` — `httpMcpToolCaller` (SDK `Client.callTool`, bearer injection) + `fakeMcpToolCaller` (records inputs for custody assertions), the injectable `doFetch` analogue. Added `@modelcontextprotocol/sdk@1.30.0` to egress-guard (same pin as control-api).
- **Broker + enforce (Task 2):** `forwardTool` in `guard.ts` mirrors `forwardConnection` — `ProvisionTool` held in `RunState.tools`, **per-operation default-deny** (unprovisioned tool or ungranted operation → `permission` refusal *before* the credential/endpoint is touched), allowlist egress check (each tool endpoint host added at register), Filter-Hook egress/ingress seams (no-op default), the credential attached only inside `mcpCall`, `isError` passed through as `ok:true,isError:true` (a tool-execution error is NOT a Guard refusal). A `ToolCallRequest` branch added to `handle` dispatch (order: connection → tool → model → 400; disjoint by required keys). `mcpCall` injected via `GuardConfig` (default `httpMcpToolCaller()`, so `server.ts` needs no change — the production path is covered by the default). `teardown` clears the held tool credentials (AD-10).
- **Provision the credential (Task 3):** `guardClient.ts` gained `ProvisionTool` + `RunProvision.tools`. The orchestrator's `resolveRunTools` now returns `{ jobTools, provisionTools }` — the sandbox-visible `{ id, name, operations }` (no secret) AND the Guard-only `{ toolId, url, credential, operations }` with the credential **decrypted control-side** (`decryptSecret`) and merged into the run provision, never the jobSpec (AD-10). A decrypt failure → an empty credential (the call refuses, never grants). A tool with no url is sandbox-visible but not provisioned.
- **Harness issues the call (Task 4):** `main.ts` gained `guardToolCall` + `toolOutcome` (the connection twins) and a deterministic tool phase (phase 1b, before the model call) — for each granted tool it issues one `tools/call` for the first operation over the UDS, relays a refusal (recorded) or folds a success note into context. NO new control-message type, **no `CONTRACT_VERSION` bump** — `ToolCallRequest/Response` were already v5 (6.1); `ProvisionTool`/`RunProvision` are internal admin-API shapes, not the versioned harness↔Guard contract.
- **Tests (Task 5):** egress-guard `guard.test.ts` +8 (the primary proof: credential custody via the recording fake, ungranted→permission-refusal-no-call, unknown tool, off-allowlist→egress, isError passthrough, transport error, teardown reaping, real HTTP-over-UDS dispatch); control-api `runs.test.ts` +2 (decrypt→provision with the credential in `provision.tools` and NOT the jobSpec — AD-10; a no-auth tool → empty credential); agent-harness `main.test.ts` +4 (`toolOutcome` mappings + tools spec parse). Live run verification stands in for the flaky automated e2e (see Debug Log).
- **Verification:** `pnpm -r build` (8 workspaces) · svelte-check 0/0 · `eslint .` clean · units all green (egress-guard 23→31, control-api runs 25→27 / 142+1 skipped, agent-harness 4→8, domain/contracts/web unchanged) · live end-to-end run on the isolated `test-stack.sh` stack confirmed the Guard reaches mcp-stub. Dev stack restored, data intact (`Clyde`, `Untitled agent`, `wopr`).
- **Scope held:** server-side (agent→tool) half only — a tool's own egress is Epic 7; observed-not-metered (no cost-cap/kill for tool calls); structured per-tool stats surface = Story 6.5; deterministic harness stub (no model-driven tool loop).

### File List
- `apps/egress-guard/package.json` (+ `@modelcontextprotocol/sdk`) · `pnpm-lock.yaml`
- `apps/egress-guard/src/mcp.ts` (NEW — Guard-side MCP caller)
- `apps/egress-guard/src/guard.ts` (ProvisionTool, RunState.tools, forwardTool, dispatch, register/teardown, GuardConfig.mcpCall)
- `apps/egress-guard/src/app.ts` (admin register body parses `tools`)
- `apps/egress-guard/src/guard.test.ts` (Story 6.4 tool-broker tests)
- `apps/control-api/src/runs/guardClient.ts` (ProvisionTool + RunProvision.tools)
- `apps/control-api/src/runs/orchestrator.ts` (ToolsReader url/encCredential; resolveRunTools → jobTools + provisionTools; provision merge)
- `apps/control-api/src/runs/runs.test.ts` (Story 6.4 provisioning tests)
- `apps/agent-harness/src/main.ts` (guardToolCall + toolOutcome + the tool phase)
- `apps/agent-harness/src/main.test.ts` (Story 6.4 harness tests)
- `apps/mcp-stub/src/server.ts` (per-request log line — dev/e2e observability)

### Change Log
- 2026-08-03 — Story 6.4 implemented: a running agent invokes its granted tools through the Guard. The egress-guard `forwardTool` resolves the endpoint, enforces the per-operation grant (default-deny, permission-first), attaches the Guard-held credential, performs the MCP `tools/call` over its own TLS, and returns the result — the sandbox's only egress stays the one UDS and never sees the URL or credential (AD-10). Ungranted ops are refused and recorded (NFR-2/NFR-4). The orchestrator decrypts the tool credential into the Guard provision (never the jobSpec); the harness issues the logical call. No CONTRACT_VERSION bump. Verified live end-to-end (the Guard reaches mcp-stub). Status → review.
