---
baseline_commit: 527e64f642aee03193ba54c8829391b47f077e00
---
# Story 4.1: Run an agent in an isolated sandbox (bare loop)

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As the builder,
I want to run an agent inside a real sandbox,
so that execution is isolated from the first line of code.

## Acceptance Criteria

1. **Given** an agent with a model, **when** a Test run is launched, **then** the run-orchestrator creates **one ephemeral container per run** via the Docker API (production `--runtime=runsc`; this dev machine `dev-insecure`), always **`--network=none`**, injects the **immutable job spec** on `stdin`, streams the **single control channel** from `stdout`, and **reaps** the container on completion. [Source: epics.md#Story-4.1 FR-7, AD-4, AD-9; E4-AD-1,2,3,4,8]
2. **Given** the sandbox cannot be established, **when** a run is launched, **then** the run **fails with a stated reason** and **never falls back to unsandboxed execution** — no silent runtime downgrade. [Source: epics.md#Story-4.1 NFR-1; E4-AD-3,8]
3. **Given** a running agent, **when** it makes a model call, **then** the call **exits only via the Guard → LiteLLM over the per-run Unix-domain socket** (the sandbox has no network), and a **transcript returns on the single control channel**. [Source: epics.md#Story-4.1 AD-1, AD-9; E4-AD-1,2,9]

## Tasks / Subtasks

- [x] **Task 1: harness↔Guard model-call contract** (AC: #3)
  - [x] `packages/contracts/src/index.ts` — add `GuardModelRequestSchema` (`{ v, runId, model, messages: [{role, content}] }`, chat-completions shape) and `GuardModelResponseSchema` (`{ v, ok, text?, error?, tokens?, latencyMs? }`). Keep `CONTRACT_VERSION = 1` (existing `JobSpec`/`ControlChannel` wire is unchanged; these are new additive schemas). This is the versioned harness↔Guard protocol (E4-AD-9); connection reads + plain egress are added in 4.3. [Source: E4-AD-9]

- [x] **Task 2: `runs` table + RunsRepo (orchestrator sole-writer)** (AC: #1)
  - [x] `apps/control-api/src/db/schema.ts` — add a **`runs`** table: `id` (ULID PK), `agentId` text, `status` text (`created|running|succeeded|failed|killed`), `taskInput` text, `transcript` jsonb (`ControlChannelMessage[]`, default `[]`), `reason` text nullable (the fail reason), `createdAt` + `endedAt` timestamptz. `drizzle-kit generate` → migration **`0008`**. Preserve `0000`–`0007`.
  - [x] `apps/control-api/src/runs/repo.ts` — `RunsRepo` (Drizzle + in-memory): `create(row)`, `get(id)`, `setStatus(id, status, patch?)`, `appendMessage(id, msg)`, `list(agentId?)`. **Single-writer (AD-7): only the orchestrator writes Run state.**

- [x] **Task 3: `SandboxRuntime` interface + Docker runtime (fail-closed)** (AC: #1, #2)
  - [x] Add **`dockerode`** to `apps/control-api` deps (talks to the Docker API over the mounted socket — no docker CLI needed in the image).
  - [x] `apps/control-api/src/runs/runtime.ts` — `interface SandboxRuntime { establish(input): Promise<SandboxHandle> }` where `SandboxHandle = { stdout: AsyncIterable<string> /* NDJSON lines */, done: Promise<{ exitCode: number }>, kill(): Promise<void> }`; `input = { runId, image, jobSpecJson, guardSocketHostPath }`.
    - `dockerRuntime(opts)` creates a container: `NetworkMode: "none"`, the configured **runtime** (`gvisor` → `runsc`; `dev-insecure` → default `runc`), **binds the per-run guard socket** (the run's socket dir on the shared volume → `/guard` in the sandbox, read-write), attaches `stdin` (writes `jobSpecJson` then closes) and `stdout` (demuxed → NDJSON line iterator), auto-remove on exit (`AutoRemove: true`), and `kill()` force-removes.
    - **Runtime selection is explicit** via `SANDBOX_RUNTIME` (`gvisor` | `dev-insecure`); `dev-insecure` **throws at startup if `NODE_ENV === "production"`**. **Fail-closed:** if the Docker create/start throws (e.g. `runsc` missing under `gvisor`), surface the error — the caller fails the run; **never** retry with a different runtime.
  - [x] Provide a `fakeSandboxRuntime` (emits scripted NDJSON control messages + a done code) for unit tests of the orchestrator.

- [x] **Task 4: run-orchestrator module + routes** (AC: #1, #2, #3)
  - [x] `apps/control-api/src/runs/orchestrator.ts` — `runOrchestrator({ runsRepo, agentsRepo, runtime, guard, image })` exposing `launch(agentId, taskInput): Promise<Run>`. Follow the **fail-closed establish order (E4-AD-8)**, minus the cost-key step (per-run key + kill is Story 4.5):
    1. load the agent (404 if missing; 400 if it has no `model` — "an agent needs a model to run");
    2. `runsRepo.create` **Run=created** + snapshot the immutable `JobSpec` (`v`, `runId`, `agentId`, `model`, `instructions`, `skills: []` for now, `taskInput`);
    3. `guard.registerRun(runId)` → provisions the per-run UDS on the shared volume, returns its host path;
    4. `runtime.establish(...)` with the job spec on stdin + the socket bound; on any failure → **Run=failed, reason set**, `guard.teardownRun(runId)`, rethrow a stated error (**never unsandboxed**);
    5. **Run=running**; consume the stdout NDJSON, validating each line against `ControlChannelMessageSchema`, `appendMessage` each; on `done` set the terminal status; always **reap** (container auto-removes; call `guard.teardownRun`).
  - [x] `apps/control-api/src/runs/routes.ts` — behind `requireSession`: `POST /runs` `{ agentId, taskInput }` → launch, return `{ run }` (201) with the terminal transcript (4.1 is synchronous store-and-return; **live SSE streaming is Story 4.2**); `GET /runs/:id` → `{ run }` or 404; `GET /runs?agentId=` → list. Mount in `app.ts` under `requireSession` (`/runs`, `/runs/*`), inject `runsRepo` + the orchestrator; build them in `server.ts`. **Preserve** the whole Epic 1–3 surface.

- [x] **Task 5: egress-guard — per-run UDS + model proxy + run-admin** (AC: #3)
  - [x] `apps/egress-guard/src/guard.ts` — a run registry + per-run **Unix-domain socket** listener on the shared volume (`/run/guard/<runId>.sock`). A `register(runId)` provisions the socket; `teardown(runId)` closes + unlinks it. Each per-run socket serves **only** the harness↔Guard model-call contract (E4-AD-9): on a `GuardModelRequest`, forward to **LiteLLM** (`${LITELLM_BASE_URL}/v1/chat/completions`, master key) with the request `model` + `messages`, and return a `GuardModelResponse` (`ok`+text or `ok:false`+error). (Allowlist, credentialed-connection reads, per-run cost keys, and the filter hook are Stories 4.3–4.6 — a comment marks each seam.)
  - [x] `apps/egress-guard/src/app.ts` — add a **run-admin API** on the HTTP port (compose network, control-plane only): `POST /admin/runs/:id/register` → `{ socketPath }`; `POST /admin/runs/:id/teardown`. Keep `/health`. (MVP admin auth: a shared `GUARD_ADMIN_TOKEN` header — control-plane only, per the spine.)
  - [x] control-api gets a small **guard client** (`apps/control-api/src/runs/guardClient.ts`): `registerRun(id)` / `teardownRun(id)` calling the guard admin API; returns the socket host path the orchestrator binds into the sandbox.

- [x] **Task 6: agent-harness — the bare loop** (AC: #1, #3)
  - [x] `apps/agent-harness/src/main.ts` — replace the stub with the loop: read the full **`stdin`** → parse `JobSpecSchema`; emit a `turn` (`role:"user"`, `text: taskInput`) on **`stdout`** (NDJSON); make **one** model call to the Guard over the UDS at `/guard/<runId>.sock` (HTTP-over-UDS `GuardModelRequest`); on success emit a `turn` (`role:"agent"`, the completion text) then `done: succeeded`; on a guard/model error emit a `refusal` **or** a failed `turn` + `done: failed`. **No network, no DB** — the only egress is the guard UDS; the only outputs are stdout NDJSON. Any unexpected error → `done: failed` (never hang). Update `apps/agent-harness/Dockerfile` if needed so the built image runs `node dist/main.js` reading stdin.

- [x] **Task 7: compose + Docker wiring** (AC: #1, #2)
  - [x] `deploy/compose.yaml`: mount the **Docker socket** into `control-api` only (`/var/run/docker.sock:/var/run/docker.sock`); add `SANDBOX_RUNTIME=${SANDBOX_RUNTIME:-dev-insecure}`, `GUARD_ADMIN_URL=http://egress-guard:8081`, `GUARD_ADMIN_TOKEN`, `AGENT_HARNESS_IMAGE=turanga/agent-harness:dev` to control-api; add `GUARD_ADMIN_TOKEN` + a **shared named volume** (`guard-run` → `/run/guard`) to `egress-guard`. The orchestrator bind-mounts that same volume into each sandbox. Never mount the Docker socket into a sandbox (E4-AD-4).
  - [x] Build + tag the **agent-harness image** as `turanga/agent-harness:dev` (a compose `build`-only entry, or a step in `run.sh`) so the daemon has it for the orchestrator to run. Document the build step.
  - [x] `run.sh` / README: note `SANDBOX_RUNTIME=dev-insecure` on macOS (no gVisor) and that the guarantee is topological here (kernel isolation needs a Linux+gVisor host).

- [x] **Task 8: Tests + verification** (AC: all)
  - [x] **Unit (control-api, Vitest):** `RunsRepo` (create/get/setStatus/appendMessage); the orchestrator with `fakeSandboxRuntime` — happy path (created→running→succeeded, transcript persisted, guard register+teardown called), **fail-closed** (runtime.establish throws → Run=failed + reason + teardown + no second attempt), agent-without-model → 400; guard registered/torn-down exactly once. `SANDBOX_RUNTIME=dev-insecure` refused when `NODE_ENV=production`.
  - [x] **Unit (egress-guard, Vitest):** the model proxy maps a `GuardModelRequest` → a LiteLLM call (fake fetch) → `GuardModelResponse`; register/teardown lifecycle of a per-run socket (temp dir).
  - [x] **Integration (live docker, gated):** with the stack up + the harness image built, `POST /runs` for an agent with a model → the response transcript contains the **user turn** and a terminal `done` (a real completion needs a configured provider — with none, LiteLLM errors and the run ends `failed` with the error visible; **that still proves the call left only via the Guard**). Assert the sandbox ran with **`NetworkMode:none`** and was **reaped** (no leftover container). Provide a way to **skip** this test when Docker-in-`control-api` isn't available (env guard), so `pnpm -r test` stays green everywhere.
  - [x] `svelte-check` 0 (web untouched) · `pnpm -r build` · `pnpm lint` · control-api + egress-guard unit green · Epic 1–3 regressions untouched (no web/API-shape changes to existing routes).

### Review Findings (Story 4.1 code review, 2026-08-02)

_Blind Hunter + Edge Case Hunter + Acceptance Auditor over `527e64f..HEAD`. Security-critical infra. 10 patch, 4 deferred, 1 dismissed. All three converged on the socket-isolation + timeout/leak gaps._

- [x] [Review][Patch][High] **Cross-run socket access — the whole shared UDS volume is bind-mounted `:rw` into every sandbox.** `runtime.ts` binds `${sandboxVolume}:/guard:rw` (the entire `turanga_guard-run` volume), and the guard writes every run's socket flat as `/run/guard/<id>.sock`, so run A sees + can connect to / unlink `/guard/<runB>.sock` for ALL live runs — defeating E4-AD-1 ("one socket per run — isolation is by socket"). Low blast radius in 4.1 (no per-run creds yet) but a cross-tenant breach the moment 4.3/4.5 attach per-run credentials/keys. Mount only the run's own subdir (per-run subpath, read-only) as `/guard`; the guard is authoritative for the socket path (use the `socketPath` it returns). [runtime.ts / guard.ts / orchestrator.ts / guardClient.ts]
- [x] [Review][Patch][High] **No timeout anywhere — a hung model call hangs the container, the orchestrator, and `POST /runs` forever.** No deadline in the orchestrator run loop, no `AbortSignal.timeout` on the guard→LiteLLM fetch, no request timeout on the harness UDS call. A stalled LiteLLM → the harness never emits `done` → the container never exits → the sync request blocks indefinitely. Add an overall run wall-clock deadline that force-kills the container (Run=killed, stated reason) + per-hop timeouts on the guard fetch and the harness request. [orchestrator.ts / guard.ts / harness main.ts]
- [x] [Review][Patch][High] **Container leak when create→attach→start fails.** `AutoRemove:true` only reaps a container that started and exited; if `attach()`/`start()` throws, the created `turanga-run-<id>` container dangles forever. Wrap create/attach/start so any throw force-removes the created container. [runtime.ts]
- [x] [Review][Patch][High] **`setStatus("running")` sits outside the try/finally → container + socket leak on a transient DB error.** The sandbox is already established, but a throw on this line skips the `finally` that reaps + tears down. Move all post-establish work inside the try so cleanup always runs (E4-AD-8 "reap + teardown always"). [orchestrator.ts]
- [x] [Review][Patch][Med] **`dev-insecure` is a silent default; guard-admin token defaults + compares non-constant-time.** `SANDBOX_RUNTIME` defaults to `dev-insecure` (violates E4-AD-3 "explicit config") and the production refusal hinges on `NODE_ENV=production` which compose never sets. Also `x-guard-admin` defaults to `dev-guard-admin` with no prod refusal and a byte-short-circuit `!==` compare. Require `SANDBOX_RUNTIME` to be set explicitly (fail-closed if unset); refuse the default admin token in production; use a constant-time compare. [runtime.ts / egress-guard app.ts / server.ts]
- [x] [Review][Patch][Med] **`runId` path traversal in the guard.** The admin API feeds `c.req.param("id")` straight into `path.join(socketDir, `${id}.sock`)` — `id=../../x` lets a token-holder `listen()`/`unlinkSync` outside the volume. Validate `runId` against a strict ULID pattern before any FS op. [egress-guard guard.ts / app.ts]
- [x] [Review][Patch][Med] **Unbounded in-memory buffering on three untrusted streams (memory-exhaustion DoS).** `lineIterator` grows `buf` until a newline; the guard grows `raw` per request; the harness grows its response `raw` — all uncapped. A sandbox emitting a huge no-newline stdout line OOMs the control plane. Cap max-line / max-body and abort past the limit. [runtime.ts / guard.ts / harness main.ts]
- [x] [Review][Patch][Med] **No concurrency cap — `POST /runs` is an unbounded container fork-bomb.** Add a max-concurrent-sandbox admission cap (the spine's assumption); reject over the cap with a stated reason. [orchestrator.ts / routes.ts]
- [x] [Review][Patch][Med] **Guard per-run HTTP server has no post-listen `error` handler (a socket error crashes the shared guard, killing every run) + `register` leaks the old server on a duplicate id.** Add `server.on("error", …)`; teardown any existing server before re-registering an id. [egress-guard guard.ts]
- [x] [Review][Patch][Low] **Robustness cluster:** `appendMessage` does an O(n²) read-modify-write of the whole transcript (use a DB-level jsonb append); a stream error is masked as a clean EOF (destroy the iterator so the run fails with a reason); the loop keeps appending after `done` (break on the first terminal); the `POST /runs` route doesn't catch a thrown `launch` (bare 500 instead of a stated reason) + `taskInput` is uncapped + `GET /runs` is unpaginated; stale "job spec on stdin" comments contradict the `JOB_SPEC` env (E4-AD-2). [repo.ts / runtime.ts / orchestrator.ts / routes.ts]
- [x] [Review][Defer][Med] Guard has no reaper/TTL for orphaned run sockets — if a teardown never reaches the guard (guard restart / control-api crash mid-run) the socket + `http.Server` leak with no reconciliation. Deferred — needs a TTL/reaper; low frequency (teardown runs in `finally`). Revisit with the concurrency work.
- [x] [Review][Defer][Low] No ownership/tenancy on `POST /runs {agentId}` — any session runs any agent. Deferred: single-user MVP; revisit if multi-tenant.
- [x] [Review][Defer][Low] `litellm` master key + other secrets default to well-known values with no production refusal (pre-existing, broader than 4.1). Deferred to the auth/secrets-hardening pass (deferred-work).
- [x] [Review][Defer][Low] No cap on transcript growth (the jsonb column) — irrelevant in 4.1 (one model call → tiny transcript); revisit when multi-turn loops land (4.4).
- [x] [Review][Dismiss] "Run should check `agent.state`" — Test runs a **Draft** agent by design (AD-8: Test is an execution mode, not gated on Active); not a defect.

## Dev Notes

**First Epic 4 story — the walking skeleton of the execution plane. This is bigger and infra-heavier than any Epic 3 story: it stands up real per-run Docker sandboxing, the control channel, the guard UDS, and the run-orchestrator. Build ONLY the bare loop: launch a sandbox, inject the job spec, make one model call out through the Guard, stream the transcript back, reap, fail-closed. Do NOT build: the SSE test-pane UI (4.2), the allowlist / credentialed-connection reads / default-deny egress (4.3), skill/permission enforcement (4.4), per-run cost keys + kill-on-429 + the live meter (4.5), or the filter hook (4.6). Each of those is a marked seam here.**

### Architecture (the E4 spine governs — read it)
[Source: _bmad-output/planning-artifacts/architecture/epic-4-execution-plane/ARCHITECTURE-SPINE.md]
- **E4-AD-1** egress = a **per-run bind-mounted UDS** to the guard; sandbox is **`--network=none`**; the socket is on a **shared Docker volume** (guard ↔ sandbox), never a host path.
- **E4-AD-2** job spec on **stdin**; the one control channel is **NDJSON on stdout**; guard UDS is egress-only; stderr is diagnostic, never control.
- **E4-AD-3** one `SandboxRuntime` interface; runtime chosen by **explicit `SANDBOX_RUNTIME`**; `dev-insecure` refused in production; **fail-closed — never a silent downgrade**.
- **E4-AD-4** the **run-orchestrator is a control-api module**; the **Docker socket is mounted only into control-api, never a sandbox**.
- **E4-AD-8** the **deterministic fail-closed establish order** (adapted: cost-key step is 4.5).
- **E4-AD-9** the harness↔Guard request is a **versioned contract** (model call = chat-completions shape).
- **E4-AD-10** event provenance: the harness emits **turn + done**; the Guard will own metrics/refusals (fuller in 4.5) — for 4.1 the harness may emit a `refusal`/failed `turn` on a model error, but authoritative cost/refusal is the Guard's job later.
- **Inherited (binding):** AD-1 (topological isolation), AD-4 (one ephemeral container per run), AD-7 (orchestrator sole Run writer), AD-9 (immutable job spec, one channel out), AD-10 (no secret in the sandbox — the master key stays in the guard, never the harness).

### macOS / Docker realities (this dev machine — Apple Silicon, runc only)
- **`SANDBOX_RUNTIME=dev-insecure`** here: a plain `runc` container, still `--network=none` + the UDS + stdio. gVisor kernel isolation is **not** present locally; the egress/cost **topology** is what's verified here. Never let dev-insecure be a silent fallback.
- **Docker-in-container:** control-api reaches the daemon via the **mounted `/var/run/docker.sock`** using `dockerode` (no docker CLI in the slim image). Containers the orchestrator starts are **siblings** on the host daemon, not nested.
- **Shared UDS volume:** a **named volume** mounted into both `egress-guard` (`/run/guard`) and each sandbox (`/guard`); both live on the same Docker VM so the socket crosses the macOS boundary. Do **not** use a host bind path for the socket.
- **Harness image:** the orchestrator runs the prebuilt `turanga/agent-harness:dev` image — it must exist in the daemon (build it via compose `build`/`run.sh`) before a run launches; if missing, the run **fails-closed** with a stated reason (which is correct behavior, but document the build step so tests can pass).
- **`--stop-timeout` / reap:** use `AutoRemove: true` + an explicit `kill()`; assert no leftover containers in the integration test.

### Files being modified / created
- **NEW:** `apps/control-api/src/runs/{repo,runtime,orchestrator,routes,guardClient}.ts` (+ tests), `apps/egress-guard/src/guard.ts` (+ test), migration `0008`.
- **UPDATE:** `packages/contracts/src/index.ts` (guard model contract), `apps/control-api/src/db/schema.ts` (runs), `apps/control-api/src/app.ts` + `server.ts` (mount runs routes + build orchestrator/runtime/guard client), `apps/control-api/package.json` (`dockerode`), `apps/egress-guard/src/app.ts` (run-admin API), `apps/agent-harness/src/main.ts` (the loop), `apps/agent-harness/Dockerfile` (if needed), `deploy/compose.yaml` (docker.sock, shared volume, env), `run.sh`/`README` (build step + SANDBOX_RUNTIME note).
- **PRESERVE:** every Epic 1–3 route + behavior; the web app is untouched (the test-pane UI is 4.2).

### Previous-story intelligence (Epics 1–3)
- **Repo/route/guard pattern:** factory routes over an injected repo (interface + Drizzle + in-memory); `requireSession(authRepo)`; tests use `app.request` with a real login session (give each `appWithSession` a distinct `x-forwarded-for` — the login limiter, learned in 3.3/3.4). Last migration `0007` → this adds `0008`. [3-1..3-6]
- **Contracts already present:** `JobSpecSchema` (`v, runId, agentId, model, instructions, skills, taskInput`) and `ControlChannelMessageSchema` (`turn | metrics | refusal | done`). Reuse verbatim; add the guard model contract alongside. [1-1]
- **Guard/harness are skeletons:** `egress-guard` is health-only Hono; `agent-harness` parses a job spec (stub). Both get real bodies here. [1-1]
- **No web change** → no Playwright change; keep the 15 e2e green by not touching existing routes/UI. The run UI arrives in 4.2.

### Testing standards
- **Unit-first:** the orchestrator's correctness (sequence, fail-closed, single guard register/teardown) is proven with `fakeSandboxRuntime` — no Docker needed, always runs in CI. The guard proxy is proven with a fake fetch + a temp-dir socket.
- **One gated integration test** exercises the real `dev-insecure` container end-to-end; it **must be skippable** (env flag) so `pnpm -r test` is green without Docker-in-control-api.
- `pnpm -r build` 6/6, `pnpm lint` clean, `svelte-check` 0, Epic 1–3 unit + e2e untouched/green.
- **DoD:** a run launches a real `--network=none` sandbox, injects the job spec on stdin, streams the transcript from stdout, the model call leaves only via the guard UDS, the container is reaped, and an un-establishable sandbox fails-closed with a stated reason (never unsandboxed). Only 4.1 scope; every later-story concern is a marked seam.

### Project Structure Notes
- New control-api area `src/runs/` (repo/runtime/orchestrator/routes/guardClient + tests); egress-guard gains `src/guard.ts`; migration `0008`; `dockerode` dep; compose gains the socket mount + shared volume + env. No new packages. Contracts extended (no version bump). [ARCHITECTURE-SPINE (epic-4) Structural Seed; parent AD-4, AD-7]

### References
- [Source: _bmad-output/planning-artifacts/epics.md#Epic-4 / Story-4.1; FR-7, NFR-1, AD-1, AD-4, AD-9]
- [Source: _bmad-output/planning-artifacts/architecture/epic-4-execution-plane/ARCHITECTURE-SPINE.md — E4-AD-1,2,3,4,8,9,10 + inherited AD-1/4/7/9/10]
- [Source: _bmad-output/planning-artifacts/architecture/architecture-turanga-2026-07-31/ARCHITECTURE-SPINE.md — AD-1..AD-10]
- [Source: packages/contracts/src/index.ts (JobSpec, ControlChannelMessage); apps/egress-guard, apps/agent-harness (skeletons); apps/control-api (repo/route/guard patterns, 3-1..3-6)]
- [Source: project-context.md; deferred-work.md]

## Dev Agent Record

### Agent Model Used
claude-opus-4-8[1m]

### Debug Log References
- **The bug that cost the most:** `POST /runs` hung 60s. Root cause — `docker.modem.demuxStream` does NOT propagate `end`/`close` to its target streams, so the stdout line-iterator never terminated. Fixed by ending the stdout/stderr PassThroughs on the attach stream's `end`/`close`/`error`. After the fix, a run returns in ~0.2s.
- **dockerode stdin-attach hangs** (macOS Docker Desktop): the attach-stdin dance blocked. Pivoted job-spec injection to a **create-time `JOB_SPEC` env var** (harness keeps a stdin fallback for `docker run -i`). Amended **E4-AD-2** in the epic spine + logged the change to its memlog (env var preserves the AD-9 immutable/create-time/no-side-channel intent).
- **pnpm build-script gate:** `dockerode` pulls `ssh2`/`cpu-features`/`protobufjs` native builds; we use the unix socket, so set them to `false` in `pnpm-workspace.yaml allowBuilds` (clears ERR_PNPM_IGNORED_BUILDS).
- **Verified end-to-end on the live stack:** a real `--network=none` `dev-insecure` container launched, the model call left ONLY via the guard UDS → LiteLLM (which returned "Invalid model name" — correct with no provider key, proving the topology), the transcript streamed back on stdout, and the container was reaped (`AutoRemove`, no leftovers).

### Completion Notes List
- **Task 1** — `GuardModelRequestSchema`/`GuardModelResponseSchema` in `packages/contracts` (harness↔Guard model call, E4-AD-9). `CONTRACT_VERSION` stays 1 (additive schemas).
- **Task 2** — `runs` table (migration `0008`) + `RunsRepo` (Drizzle + memory), orchestrator sole-writer (AD-7).
- **Task 3** — `SandboxRuntime` interface + `dockerRuntime` (dockerode over the mounted socket; `--network=none`; `runsc` under gvisor, default runc under dev-insecure; job spec via `JOB_SPEC`; stdout demuxed to a line iterator; `AutoRemove`). `resolveSandboxRuntimeKind` refuses dev-insecure in production; **fail-closed — no silent downgrade**. `fakeSandboxRuntime` for unit tests.
- **Task 4** — `runOrchestrator.launch` = the fail-closed establish order (E4-AD-8, minus the 4.5 cost key): Run=created + immutable job-spec snapshot → guard.registerRun → runtime.establish (fail → Run=failed + reason + guard teardown, never unsandboxed) → Run=running → consume+validate the control channel → terminal status → always reap + teardown. `runRoutes` (`POST /runs`, `GET /runs/:id`, `GET /runs`) behind `requireSession`; mounted in `app.ts`; real Docker orchestrator built in `server.ts` (fake-runtime default keeps the app/tests Docker-free).
- **Task 5** — `egress-guard`: `createGuard` (per-run UDS http server → proxies the model call to LiteLLM with the master key; allowlist/connection-reads/cost-key/filter-hook are marked seams for 4.3–4.6) + a run-admin API (`/admin/runs/:id/register|teardown`, token-guarded, control-plane-only). control-api `httpRunGuard` client.
- **Task 6** — `agent-harness` bare loop: read `JOB_SPEC` (stdin fallback) → user turn → one model call over `/guard/<runId>.sock` → agent turn + done on stdout NDJSON. No network, no DB; loop guarded to run only as the entrypoint.
- **Task 7** — compose: Docker socket mounted **only** into control-api; shared `guard-run` volume (guard `/run/guard` ↔ sandbox `/guard`); `SANDBOX_RUNTIME=dev-insecure` default + guard/harness env; a build-only `agent-harness-image` service tags `turanga/agent-harness:dev`; `run.sh` builds it + notes the macOS runtime.
- **Task 8** — control-api unit +8 (orchestrator happy/fail-closed/404/400/exit-code/malformed-lines, RunsRepo, runtime-kind resolution) → **66 + 1 skipped**; egress-guard unit +3 (proxy ok/err + socket lifecycle) → **4**; a **gated** live integration test (`RUN_SANDBOX_IT=1`) that spins a real sandbox — passes against the stack, skips by default so `pnpm -r test` is green everywhere.
- **Verification** — `pnpm -r build` 6/6, `pnpm -r test` all green (control-api 66/1-skip, egress-guard 4, contracts 3, harness 1, domain 2), `pnpm lint` clean, `svelte-check` 0, web/Playwright untouched. Live: `POST /runs` → 201 in ~0.2s with the transcript; container reaped.

**Documented deviations:** (1) job spec via `JOB_SPEC` env, not stdin (E4-AD-2 amended). (2) 4.1 is synchronous store-and-return; live SSE streaming is 4.2. (3) With no provider key, a run ends `failed` at the model call — that proves the topology; a successful completion needs a configured provider. (4) Marked seams for later stories: allowlist + credentialed reads (4.3), skill/permission enforcement (4.4), per-run cost key + kill-on-429 + live meter (4.5), filter hook (4.6). (5) `dev-insecure` on macOS has no gVisor kernel isolation — the guarantee is topological here; verify `gvisor` on a Linux host before real use.

### File List
- NEW `apps/control-api/src/runs/{repo,runtime,orchestrator,routes,guardClient,runs.test,sandbox.integration.test}.ts`
- NEW `apps/control-api/drizzle/0008_complete_hulk.sql` (+ meta)
- NEW `apps/egress-guard/src/{guard,guard.test}.ts`
- MOD `packages/contracts/src/index.ts` (guard model contract)
- MOD `apps/control-api/src/db/schema.ts` (runs) · `app.ts` + `server.ts` (mount + wire) · `package.json` (dockerode, @turanga/contracts, @types/dockerode)
- MOD `apps/egress-guard/src/{app,server}.ts` (run-admin) · `package.json` (@turanga/contracts)
- MOD `apps/agent-harness/src/main.ts` (the loop)
- MOD `deploy/compose.yaml` (docker.sock, guard-run volume, env, build-only harness image) · `run.sh` (build step + note)
- MOD `pnpm-workspace.yaml` (allowBuilds for dockerode native deps) · `pnpm-lock.yaml`
- MOD `_bmad-output/planning-artifacts/architecture/epic-4-execution-plane/ARCHITECTURE-SPINE.md` (E4-AD-2 amend) + its `.memlog.md`

### Change Log
- 2026-08-02 — Story 4.1 implemented: real per-run sandbox bare loop — orchestrator + Docker runtime (dev-insecure/gvisor, fail-closed) + guard UDS + control channel + job-spec injection; verified end-to-end. Status → review.
