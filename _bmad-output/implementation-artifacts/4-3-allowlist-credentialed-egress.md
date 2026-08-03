---
baseline_commit: 7b9b9ec9b8ac5a80d2638e41aab098333bc807bf
---
# Story 4.3: Default-deny egress with the credentialed-connection gateway

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As the builder,
I want the agent to reach only what I allow, without holding my credentials,
so that a hijacked agent can't exfiltrate or overreach.

## Acceptance Criteria

1. **Given** an agent with an attached Gmail connection, **when** it reads mail during a run, **then** the Guard (mode a) terminates TLS, attaches the **held credential**, and forwards to Gmail — **the agent never holds the token**; the read result is available to the run. [Source: epics.md#Story-4.3 AC1, FR-9, AD-5, AD-10; E4-AD-9]
2. **Given** a destination **not on the allowlist**, **when** the agent attempts to reach it, **then** the egress is **refused and recorded on the Run with the attempted destination + reason** (allowlist = Connection-derived destinations + explicit additions, **default-deny**), and the refusal renders inline as a **refusal row** in the test pane. [Source: epics.md#Story-4.3 AC2, FR-8, UX-DR23, NFR-2, NFR-4; E4-AD-10]
3. **Given** an **empty allowlist**, **when** the agent runs, **then** it **can reach no external destination** (every logical egress is refused). [Source: epics.md#Story-4.3 AC3, FR-8, NFR-2]

## Tasks / Subtasks

- [x] **Task 1: Contract — connection-read request/response + logical connection handles** (AC: #1, #2, #3)
  - [x] `packages/contracts/src/index.ts` — **bump `CONTRACT_VERSION` to `2`** (E4-AD-9: the harness↔Guard protocol gains entries) and replace hardcoded `v: 1` emit-site literals across the codebase with `CONTRACT_VERSION` (harness, orchestrator jobSpec, guard responses, the web `RunMessage` mirror `v: 2`) so a single rebuild stays consistent.
  - [x] Add `JobSpecSchema.connections: z.array(z.object({ id: z.string(), provider: z.literal("gmail") }))` — **logical** connection handles the agent is configured to use. **No token, no URL, no destinations** enter the sandbox (AD-10). Existing construction that omits it must still validate → give it `.default([])`.
  - [x] Add `GuardConnectionRequestSchema` = `{ v, runId, connectionId, op: z.enum(["gmail.list"]), params: z.object({ maxResults: z.number().int().min(1).max(25) }).partial().optional() }` — a **logical, read-only** operation (the harness names an op, never a URL).
  - [x] Add `GuardConnectionResponseSchema` = `{ v, ok, data?: z.unknown(), error?, refusal?: z.object({ destination: z.string(), detail: z.string() }) }` — on an allowlist denial `ok:false` + `refusal` (the Guard composes the human `detail`; the harness relays it).
  - [x] Keep the existing `refusal` control message (`kind: "egress" | "permission"`) — 4.3 finally **emits** the `egress` variant. **Do NOT** add a plain-egress (mode-b) contract entry — deferred with mode-b (see Dev Notes scope).

- [x] **Task 2: Guard — per-run allowlist + credentialed forward, fail-closed** (AC: #1, #2, #3)
  - [x] `apps/egress-guard/src/guard.ts` — extend per-run state from a bare `http.Server` to `{ server, allowlist: Set<string>, credentials: Map<connectionId, { provider, accessToken, destinations: string[] }> }`. `register(runId, provision)` now takes a **provision payload** `{ connections: [{ connectionId, provider, destinations, accessToken }] }`; the allowlist = **union of all `destinations`** (default-deny — an empty `connections` ⇒ empty allowlist ⇒ nothing reachable).
  - [x] Make the UDS request handler a **discriminated dispatch** (currently a single `GuardModelRequestSchema.safeParse → proxyModel`, guard.ts:93-94): route by request shape/path to `proxyModel` (model call, unchanged) **or** `forwardConnection` (new). The `runId` comes from the **socket** (per-run server), never the body.
  - [x] `forwardConnection(runId, req: GuardConnectionRequest) → GuardConnectionResponse` (**mode a**, AD-5): (1) look up the run's credential for `connectionId`; (2) resolve the op's **destination** (`gmail.list` → `gmail.googleapis.com`); (3) **allowlist check** — destination ∈ the run's allowlist AND a credential exists → else **refuse** (`{ ok:false, refusal: { destination, detail: "Blocked egress to <destination> — not on this agent's allowlist." } }`); (4) on allow, call the Filter Hook (no-op default, E4-AD-6) then **attach the held access token** (`Authorization: Bearer …`) and `fetch` Gmail (`GET https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=N`, read-only), returning a small summary in `data`. The token never crosses the UDS back to the sandbox.
  - [x] **Fail-closed (NFR-2):** any Guard error, unknown `connectionId`, missing credential, off-allowlist destination, or malformed request ⇒ **refused**, never permitted. Reuse the ULID/`MAX_REQ_BODY`/timeout guards; add a Gmail-forward timeout (`AbortSignal.timeout`). Inject the Gmail `fetch` (`GuardConfig.fetchImpl`) so it's unit-testable without Google.
  - [x] `apps/egress-guard/src/app.ts` — the `POST /admin/runs/:id/register` route reads a **JSON body** (the provision payload) and forwards it to `guard.register(id, body)`. Keep the constant-time `x-guard-admin` check. `teardown` still clears per-run state (now also the credentials map — zero it).
  - [x] `apps/egress-guard/src/server.ts` — add any config (Gmail base URL default, forward timeout). The master LiteLLM key stays; connection access tokens arrive per-run via register (never from env).

- [x] **Task 3: control-api — mint the credential + derive the allowlist, register the run** (AC: #1, #2, #3)
  - [x] `apps/control-api/src/oauth/google.ts` — add `accessTokenFromRefresh(refreshToken): Promise<{ accessToken: string; expiresAt: number | null }>` (OAuth2Client `setCredentials({ refresh_token }); getAccessToken()`), on the `GoogleOAuth` interface + `fakeGoogleOAuth` (return a deterministic fake token). This is the **short-lived** credential handed to the Guard.
  - [x] `apps/control-api/src/runs/guardClient.ts` — `RunGuard.registerRun(runId, provision)` gains the payload; `httpRunGuard` POSTs it as JSON; `fakeRunGuard` records the provision (`registered: { runId, provision }[]`) so tests can assert the allowlist + that a credential was passed.
  - [x] `apps/control-api/src/runs/orchestrator.ts` — add `dataConnectionsRepo` + `googleOAuth` deps. In `validateAndCreate`/`execute`, compute the run's connections:
    - **jobSpec.connections** (sandbox-visible logical handles) = derived from the **agent's config**: if the agent has ≥1 attached skill with `scope !== "none"`, include the logical Gmail handle `{ id, provider: "gmail" }`. This is what the harness will *attempt* (independent of credential availability — default-deny is enforced at the Guard, not by hiding the handle).
    - **provision** (Guard-side allowlist + credentials, never in the jobSpec) = for each connected (`status === "connected"`) Gmail data connection matching that config, decrypt its refresh token (`secrets/crypto.ts decryptSecret`) and **mint an access token** (`googleOAuth.accessTokenFromRefresh`); pass `{ connectionId, provider, destinations: <connection.destinations>, accessToken }`. If OAuth isn't configured, no connection is `connected`, or minting fails ⇒ **that connection is omitted** (empty/partial allowlist — fail-closed, never grant without a credential).
    - Pass `provision` to `guard.registerRun(runId, provision)` (the existing fail-closed establish step, orchestrator.ts:87). **Assert in code/tests** the access token is only in the provision, **never** in the jobSpec (AD-10).
  - [x] `apps/control-api/src/server.ts` + `app.ts` — thread `dataConnectionsRepo` + `googleOAuth` into `runOrchestrator` (real + fake wiring). The default no-DB orchestrator uses `fakeRunGuard` + an empty connections repo.

- [x] **Task 4: Harness — issue the logical read, relay a refusal** (AC: #1, #2)
  - [x] `apps/agent-harness/src/main.ts` — for each `spec.connections`, issue **one** logical read over the same `/guard/run.sock` (`gmail.list`): a `guardConnectionCall(socketPath, req)` sibling of `guardModelCall` (raw `http.request`, response cap + timeout, parse `GuardConnectionResponseSchema`).
    - On `ok` → fold a short read summary into the model `messages` (the mode-(a) demonstration — the agent "reads mail during a run").
    - On a `refusal` → **emit a `refusal` control message** `{ type: "refusal", kind: "egress", detail }` (relayed from the Guard, E4-AD-10 provenance note — the Guard decided it; the harness only transports it in 4.3; the out-of-band Guard→orchestrator channel is 4.5). The run continues to its model call (a blocked egress refuses that egress, it doesn't kill the run — killed is cap-breach, 4.5).
  - [x] Keep the bare-loop contract intact: `JOB_SPEC` ingress, `--network=none`, the single NDJSON stdout channel, no secret in the sandbox. The harness still sees only logical ops — no URL, key, or token.

- [x] **Task 5: Test pane — the refusal row fires (web)** (AC: #2)
  - [x] The refusal row was **built in 4.2** (`+page.svelte`, rendered for any `refusal` message). Verify it now renders an emitted egress refusal: **destination + reason** inline (dot + text, no red banner), copy per DESIGN/EXPERIENCE ("Blocked egress to gmail.googleapis.com — not on this agent's allowlist."). Confirm it sits inline in the transcript, not colour-only. **No** standalone allowlist-editor view or "Add to allowlist" action in 4.3 (deferred — see scope).

- [x] **Task 6: Tests + verification** (AC: all)
  - [x] **Guard unit (Vitest, injected `fetch`):** (a) allowlisted destination + credential → forwards with `Authorization: Bearer <token>`, returns `data`, **token never in the response to the sandbox**; (b) **empty allowlist** → connection read refused with destination + detail (AC3); (c) destination/connection **not allowlisted** → refused (AC2); (d) **fail-closed** — a forward `fetch` throw / unknown connectionId / malformed body → refused, never permitted (NFR-2); (e) `teardown` zeroes the credentials map.
  - [x] **control-api unit:** orchestrator registers the run with an allowlist + minted credential when a connected Gmail connection matches the agent's scoped skills; registers an **empty** provision when none/undconfigured; **the jobSpec never carries the access token** (assert). `google.accessTokenFromRefresh` via `fakeGoogleOAuth`. `guardClient` sends the provision body.
  - [x] **Harness unit:** a refused `GuardConnectionResponse` maps to a `refusal` control message (`kind:"egress"`, the Guard's detail); an `ok` read folds a summary into the model messages. (Reuse the entrypoint-guard so importing doesn't run the loop.)
  - [x] **Playwright e2e (live stack, serial — append to `tests/agents.spec.ts`):** an agent with a Gmail-scoped skill, **OAuth unconfigured** (dev default) → run → the harness attempts the read → the Guard has no credential/allowlist for it → a **refusal row** renders inline in the test pane (destination + reason), the run still resolves to a terminal dot. (The mode-(a) happy-path Gmail read needs configured OAuth + a connected account — a **gated/manual** check, mirroring 4.1/4.2's no-provider-key pattern.)
  - [x] **Gated integration** (`RUN_SANDBOX_IT`): the live run still streams + reaps; assert no credential leaked into the transcript/jobSpec.
  - [x] `svelte-check` 0 · `pnpm -r build` 6/6 · `pnpm lint` · all unit suites · e2e incl. Epic 1–3 + 4.1/4.2 regressions green · `docker compose down -v` teardown · **no leaked run containers**.

## Dev Notes

**Third Epic 4 story — build the moat: default-deny egress + the credentialed-connection gateway. The Guard becomes the sandbox's enforced, credential-holding way out. Scope was confirmed with the user (2026-08-02):**
- **Focused, not the full AD-5 surface.** Build **mode (a)** (credentialed Gmail gateway) + **default-deny allowlist** enforcement + **refusal records** surfaced as the test-pane refusal row. **Defer:** **mode (b)** plain CONNECT/SNI egress (no AC exercises it; its contract entry is deferred with it), and the **standalone editable allowlist-view UI** ("Add to allowlist", Connection-derived + explicit additions — parent spine already defers "allowlist authoring UX"). The allowlist in 4.3 is **Connection-derived only** (automatic, default-deny); per-agent explicit additions come with that UI later.
- **Refusal provenance:** the **Guard is the authoritative allow/deny decider** (the security boundary is fully in the Guard). In 4.3 the Guard returns the refusal over the UDS and the **harness relays it** as a `refusal` control message (consistent with 4.2's harness-relayed metrics). The **out-of-band Guard→orchestrator control-plane channel** (E4-AD-10's target — so a *compromised* harness can't suppress records) lands in **4.5**, bundled with the 429-kill signal it must build anyway. Note this deviation explicitly in code comments.
- **Credential custody:** **control-api mints** a short-lived Gmail access token at run start (it owns `TOKEN_ENC_KEY` + the DB) and hands it to the **Guard at register**; the Guard holds it in **per-run memory**, attaches it when forwarding, and **zeroes it at teardown**. The agent never holds it (AD-10). **Deferred:** the egress-guard reading/decrypting `enc_refresh_token` from the DB itself + managing refresh (the literal `schema.ts:38-40` note) — a larger change to the guard's trust surface.

**Do NOT build:** mode-(b) plain egress, the allowlist-editor UI, the out-of-band Guard→orchestrator channel, skill→op enforcement (4.4 — 4.3 gates connection availability at the *skill-scoped* level only), the per-run cost key + kill-on-429 + real cost metering (4.5), the real Filter Hook logic (4.6 — 4.3 wires the **no-op** hook at the mode-(a) point, E4-AD-6).

### Architecture (the spines govern — inherited, binding)
[Source: architecture/epic-4-execution-plane/ARCHITECTURE-SPINE.md; architecture/architecture-turanga-2026-07-31/ARCHITECTURE-SPINE.md]
- **AD-5 (ADOPTED):** the Guard is the sandbox's only route out, two modes. **(a) Credentialed-connection gateway** — for an attached Connection the harness issues a *logical* request; the Guard terminates TLS, **attaches the held credential**, forwards over its own TLS; **filter hook runs here**. (b) Plain allowlisted egress — CONNECT tunnel, SNI/host allowlist, no creds (**deferred**). **Allowlist = union of the Agent's attached Connections' declared destinations (default-deny) + optional explicit additions.** The agent never holds a raw credential.
- **AD-10:** no secret ever enters a sandbox — provider keys in `litellm`, OAuth tokens in `egress-guard`, both encrypted at rest; the sandbox holds only its job spec. (4.3 realization: the token lives Guard-side per-run, never in the jobSpec/UDS-response.)
- **AD-2 / AD-1:** all outbound flow traverses the one broker, which classifies it — Model-Provider → cost meter (4.5); anything else → **default-deny allowlist + filter hook**. Enforced topologically (`--network=none` + per-run UDS, from 4.1).
- **E4-AD-1:** per-run bind-mounted UDS is the only egress; **at run start the orchestrator registers the run** with the Guard, provisioning the per-run socket **+ the run's allowlist + per-run key**; torn down at run end. (4.3 fills in the allowlist + credential half of that register payload.)
- **E4-AD-9:** the harness↔Guard protocol is a **versioned contract** — connection reads are **added in 4.3** (bump `CONTRACT_VERSION`). The harness never sees a URL, key, or token — only logical operations.
- **E4-AD-10:** turns/done from the harness; **cost/refusal truth is the Guard**. (4.3: the Guard *decides* the refusal; transport is via the harness for now — see scope. The persisted refusal record satisfies NFR-4.)
- **E4-AD-6:** the Filter Hook is a synchronous `inspect(direction, meta, body?) → allow | block(reason)` invoked at the credentialed-gateway body point; **no-op by default** (4.3 wires the no-op; real hook is 4.6).
- **E4-AD-8 fail-closed order:** register (allowlist + credential + UDS) is a step that, on failure, **fails the Run**; reap + Guard teardown (socket, **key/credential**) always run. **NFR-2:** any Guard error/misconfig ⇒ refused egress, never permitted.

### PRD / FR (verbatim intent)
[Source: prds/prd-turanga-2026-07-31/prd.md; epics.md]
- **FR-8 (default-deny allowlist):** the Guard permits a Run to reach only allowlisted destinations; an attempt to a non-allowlisted destination is **blocked and recorded with the attempted destination**; the allowlist is per-Agent/per-Connection, **default-deny**.
- **FR-9 (ingress control):** an Agent receives only data from its configured, permitted Connections (a Test Run is always sandboxed with the Guard active).
- **NFR-2 (fail-closed):** the Guard defaults to deny; any error/misconfig ⇒ refused, never permitted. **NFR-4 (observability):** every Run records its transcript, metrics, and any refusals — "what did it do and what was blocked."
- **UX-DR23 (epics.md:94):** per-agent allowlist (Connection-derived + explicit additions, default-deny); **blocked-egress refusals surfaced in the test/run view with destination + reason.** (4.3 delivers the *surfacing* — the refusal row; the editable *view* is deferred.)

### UX specifics (DESIGN.md / EXPERIENCE.md — Warm Ink)
- **Refusal copy (exact):** "**Blocked egress to gmail.googleapis.com — not on this agent's allowlist.**" (+ an *Add to allowlist* action **deferred** with the allowlist view). [EXPERIENCE.md:51] The refusal row = **destination attempted + reason**, inline in the test pane. [DESIGN.md:80, EXPERIENCE.md:65]
- **Refusal ≠ killed.** A **blocked egress → refusal row** (the run continues). A **cost-cap breach → killed dot** (the run ends) — that's 4.5. `killed` reads **caution** (fixed in the 4.2 review). Refusals surface inline; never colour-only; no red banner. [EXPERIENCE.md:73/75/89, DESIGN.md:98]
- Test runs against **live Data Connection data in read-only mode** [EXPERIENCE.md:60]; the metric line is **unchanged** by egress (latency · tokens · cost) — refusals are their own rows, not metrics. [DESIGN.md:54/127]
- **There is no `UX-DR23` in the PRD** — it's defined in `epics.md:94` (arch-driven). No other `UX-DR*` IDs exist in the UX specs; the governing requirements are the prose above.

### Files being modified (READ current state — preserve behavior)
- **`packages/contracts/src/index.ts` (UPDATE):** bump `CONTRACT_VERSION`→2; add `JobSpec.connections` (logical, no secret), `GuardConnectionRequest/Response`. Keep the `refusal` control message.
- **`apps/egress-guard/src/guard.ts` (UPDATE):** per-run allowlist + credentials; dispatch model vs connection; `forwardConnection` (mode a) with fail-closed refusal; teardown zeroes creds. Preserve `proxyModel`, the ULID/body/timeout guards, the per-run socket (guard.ts:66-124).
- **`apps/egress-guard/src/app.ts` (UPDATE):** register reads a JSON provision body. Keep the constant-time admin-token check.
- **`apps/control-api/src/oauth/google.ts` (UPDATE):** `accessTokenFromRefresh` on the interface + fake.
- **`apps/control-api/src/runs/guardClient.ts` (UPDATE):** `registerRun(runId, provision)`.
- **`apps/control-api/src/runs/orchestrator.ts` (UPDATE):** `dataConnectionsRepo` + `googleOAuth` deps; derive jobSpec.connections + the provision; mint tokens; **token never in jobSpec**. Preserve the 4.1/4.2 fail-closed order, timeout, concurrency slot (fixed in the 4.2 review), reap+teardown, hub publish/complete.
- **`apps/control-api/src/server.ts` + `app.ts` (UPDATE):** thread the two new deps into `runOrchestrator`.
- **`apps/agent-harness/src/main.ts` (UPDATE):** logical connection read + refusal relay. Keep `JOB_SPEC`/UDS/no-network/single-channel.
- **`apps/web/src/routes/(app)/agents/[id]/+page.svelte` (VERIFY):** the 4.2 refusal row now fires — likely no code change, just the e2e assertion.
- **`apps/web/tests/agents.spec.ts`, `apps/control-api/src/runs/sandbox.integration.test.ts` (UPDATE):** add the refusal-row e2e + the no-leak assertion.

### Previous-story intelligence (4.1 / 4.2 + Epic 3)
- **Guard (4.1):** per-run UDS in `<socketDir>/<runId>/run.sock`, ULID-validated subdir, `MAX_REQ_BODY` 256KB, `proxyModel` with `AbortSignal.timeout`, teardown-before-register, a server error handler so one run's socket error can't crash the shared process. The single-shape request handler (guard.ts:93-94) is the dispatch seam.
- **Orchestrator (4.1/4.2):** fail-closed establish order (register → establish → running → consume → finish), wall-clock timeout, **concurrency slot reserved in `validateAndCreate` / released in `execute` finally** (4.2 review — reserve is inside a try/catch that releases on failure; keep that shape when adding the connection resolution), always reap + guard teardown, hub publish each message + complete once. `registerRun` is the first establish step — mint/resolve connections **before** it and fail the run closed if provisioning throws.
- **Harness (4.1/4.2):** `guardModelCall` over `/guard/run.sock`, `JOB_SPEC` ingress (stdin fallback), emits `turn`/`metrics`/`done`; entrypoint guard so the unit test can import without running. Emits `metrics` regardless of success (Guard measures latency). Add `guardConnectionCall` as a sibling.
- **Data Connections (Epic 2):** `dataRepo.ts` `DataConnRow { id, provider:'gmail', name, accountEmail, scopes[], destinations[], status, lastError, encRefreshToken }` — single global Gmail (upsert deletes existing); `oauth/routes.ts` stores `encryptSecret(refreshToken)` + `destinations: GMAIL_DESTINATIONS`; API responses strip `encRefreshToken` (`view()`). `secrets/crypto.ts` `decryptSecret` (AES-256-GCM, key from `TOKEN_ENC_KEY`). `google.ts` `GMAIL_DESTINATIONS = ["gmail.googleapis.com","oauth2.googleapis.com"]`, `GMAIL_SCOPES` (gmail.modify). **No access-token mint exists yet** — add it.
- **Agent skills (Epic 3):** `AttachedSkill { skill, scope: "none"|"read"|"read-write", send }`. 4.3 gates connection availability on `scope !== "none"` (an agent with no scoped skill gets an empty allowlist — default-deny). Per-op skill→scope enforcement is **4.4**.
- **Known deferrals (do not reopen):** the 4.1/4.2 review deferrals (guard socket reaper, tenancy, secrets-in-prod, transcript caps, error-copy polish); Epic 3 deferrals; mode-b, allowlist-editor UI, out-of-band refusal channel (this story's deferrals).

### Security invariants (must hold — do not regress)
- **No secret in the sandbox (AD-10):** the access token is passed **control-api → Guard** (register body) and held Guard-side per-run; it is **never** in the jobSpec, never returned over the UDS to the harness. Add a test asserting the jobSpec + any UDS response carry no token.
- **Default-deny (FR-8/NFR-2):** the Guard permits only registered allowlist destinations with a present credential; **every** other logical egress is refused. An empty provision ⇒ nothing reachable. Any error ⇒ refuse.
- **Fail-closed establish (E4-AD-8):** a provisioning/mint/register failure fails the Run (never an unsandboxed or un-provisioned run); teardown zeroes the per-run credentials + removes the socket, always.
- **Isolation unchanged:** `--network=none`, per-run UDS (its own subpath), Docker socket only in control-api, `SANDBOX_RUNTIME` explicit/fail-closed — all from 4.1, untouched.
- **Credential in transit:** control-api → guard admin API carries the access token over the compose network under the `x-guard-admin` token — acceptable for MVP; note mTLS/TLS between control-api and guard as **deferred** hardening.

### Testing standards
- **Unit (Vitest):** Guard forward/refuse/fail-closed with an injected `fetch` (no Google); orchestrator provision derivation + token-not-in-jobSpec (fakeGoogleOAuth, memory repos); harness refusal-mapping; contract parses. In-memory; no Docker.
- **Integration (gated `RUN_SANDBOX_IT`):** the live run still streams + reaps; no credential in the transcript.
- **E2E (Playwright, live, serial):** scoped-skill agent + OAuth unconfigured → a refusal row renders (destination + reason) → the run resolves terminally → Clear. (Happy-path Gmail read = gated/manual with configured OAuth.)
- `svelte-check` 0, build 6/6, lint clean, Epic 1–3 + 4.1/4.2 regressions green.
- **DoD:** an off-allowlist / unprovisioned logical egress is **refused and recorded** (destination + reason) and shows as a refusal row; an **empty allowlist reaches nothing**; a provisioned Gmail read forwards with the **held credential** (agent never holds the token — unit-proven); fail-closed on any Guard error; only 4.3 scope (mode-b, allowlist-editor UI, out-of-band channel, cost/kill, real filter hook are marked seams).

### Project Structure Notes
- Modified: `packages/contracts`, `apps/egress-guard/{guard,app,server}.ts`, `apps/control-api/src/{oauth/google,runs/guardClient,runs/orchestrator,server,app}.ts`, `apps/agent-harness/src/main.ts`, the web e2e + integration test. New: guard connection tests, orchestrator connection tests, harness read test (co-located `*.test.ts`). **No DB migration** (the credential path uses the existing `data_connections` table + `TOKEN_ENC_KEY`). Contract version bump to 2. [E4 spine Structural Seed; AD-5/AD-9/AD-10]

### References
- [Source: epics.md#Epic-4 / Story-4.3 (AC1-3), UX-DR23 (epics.md:94); FR-8, FR-9, NFR-2, NFR-4]
- [Source: architecture/epic-4-execution-plane/ARCHITECTURE-SPINE.md — E4-AD-1/6/8/9/10; inherited AD-1/2/5/6/10]
- [Source: prds/prd-turanga-2026-07-31/prd.md — FR-8/9/10/14, NFR-2/4, SM-2; addendum (Guard modes, injection-resistant inspector deferred)]
- [Source: ux-designs/ux-turanga-2026-07-30/DESIGN.md#components.test-pane/#allowlist-view (:54/:79/:98/:127); EXPERIENCE.md (:51/:60/:65/:73/:75/:89, Key-Flow-2 :107-110)]
- [Source: packages/contracts/src/index.ts; apps/egress-guard/src/{guard,app,server}.ts; apps/control-api/src/{oauth/google,connections/dataRepo,secrets/crypto,runs/orchestrator,runs/guardClient}.ts; apps/agent-harness/src/main.ts]
- [Source: _bmad-output/implementation-artifacts/4-1-sandbox-bare-loop.md, 4-2-test-pane-streaming.md, deferred-work.md; project-context.md]

## Dev Agent Record

### Agent Model Used
claude-opus-4-8[1m]

### Debug Log References
- `CONTRACT_VERSION`→2: replaced every hardcoded `v: 1` emit-site literal with `CONTRACT_VERSION` (source) / `2` (web mirror + test fixtures) so a single rebuild stays consistent; the `JobSpecSchema.connections` `.default([])` keeps older construction (and the round-trip test) valid.
- Guard dispatch: `handle()` safe-parses the connection shape first (has `op`), then the model shape (has `messages`); the `runId` comes from the per-run socket closure, never the body.
- The refusal row (built in 4.2 as `Refused (kind) — detail`) double-stated the Guard's now-full sentence; changed it to render `{msg.detail}` verbatim with the caution (`--state-killed`) dot — a guardrail stop reads caution, not failed-red.

### Completion Notes List
- Built the moat: the Guard is now the sandbox's enforced, credential-holding egress. **Mode (a)** credentialed Gmail gateway (`forwardConnection`) + **default-deny allowlist** (union of the run's Connection destinations; empty ⇒ nothing reachable) + **fail-closed** refusals (any error/unknown connection/off-allowlist/malformed ⇒ refused, never permitted).
- **Credential custody per the confirmed scope:** control-api decrypts the stored refresh token and mints a short-lived access token (`google.accessTokenFromRefresh`), handing it to the Guard at register; the Guard holds it in per-run memory, attaches it to the Gmail forward, and zeroes it at teardown. The access token is **never** in the jobSpec or in any UDS response to the sandbox (unit-asserted + the gated integration asserts no `Bearer` in the transcript).
- **Default-deny per-agent:** an agent only "uses Gmail" if it has ≥1 attached skill with `scope !== "none"`; a configured-but-unprovisionable connection still yields a logical handle → the harness attempts → the Guard refuses (the observable dev/e2e path, since OAuth is unconfigured there — mirrors 4.1/4.2's no-provider-key pattern).
- **Refusal provenance (confirmed scope):** the Guard decides the refusal; the harness relays it as an `egress` control message → orchestrator persists + streams it → the test-pane refusal row. The out-of-band Guard→orchestrator channel (E4-AD-10 target) is deferred to 4.5.
- **Deferred (in scope-confirmation):** mode-(b) plain CONNECT egress (+ its contract entry), the editable allowlist-view UI + "Add to allowlist", the out-of-band refusal channel, per-op skill enforcement (4.4), the real Filter Hook (4.6 — the no-op interface is wired at the mode-a point). Isolation invariants from 4.1 unchanged.
- Happy-path Gmail read (mode a with a real token) is unit-proven (injected fetch: forwards with the held Bearer, returns data, token absent from the response); the live happy path needs configured OAuth (gated/manual).

### File List
**Modified**
- packages/contracts/src/index.ts
- packages/contracts/src/index.test.ts
- apps/egress-guard/src/guard.ts
- apps/egress-guard/src/app.ts
- apps/egress-guard/src/guard.test.ts
- apps/control-api/src/oauth/google.ts
- apps/control-api/src/runs/guardClient.ts
- apps/control-api/src/runs/orchestrator.ts
- apps/control-api/src/runs/runs.test.ts
- apps/control-api/src/runs/sandbox.integration.test.ts
- apps/control-api/src/server.ts
- apps/control-api/src/app.ts
- apps/agent-harness/src/main.ts
- apps/agent-harness/src/main.test.ts
- apps/web/src/lib/runs.ts
- apps/web/src/routes/(app)/agents/[id]/+page.svelte
- apps/web/tests/agents.spec.ts

### Change Log
| Date | Change |
| --- | --- |
| 2026-08-02 | Story 4.3 implemented: contract v2 (logical connections + GuardConnection request/response), the Guard credentialed-connection gateway (mode a) + default-deny allowlist + fail-closed refusals, control-api credential minting + provision, harness connection read + refusal relay, the test-pane refusal row. Verified: build 6/6, svelte-check 0/0, lint clean, all unit suites (contracts 6, guard 10, harness 4, control-api 82), 17/17 e2e on a fresh live stack (incl. the new default-deny refusal test), gated sandbox integration green, no leaked containers. Status → review. |
