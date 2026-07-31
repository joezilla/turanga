---
baseline_commit: 3380a804743c34d04bedfae31653ee80c4b6a8a5
---
# Story 1.1: Scaffold the all-TypeScript monorepo and service skeleton

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As the builder,
I want the turanga project to stand up as a running skeleton,
so that every later feature has a place to live and a way to run.

## Acceptance Criteria

1. The monorepo contains `apps/web`, `apps/control-api`, `apps/egress-guard`, `apps/agent-harness`, `packages/contracts`, `packages/domain`, and `deploy/compose.yaml` (per the Architecture Structural Seed), and the frontend framework choice (**SvelteKit**) is recorded. [Source: epics.md#Story-1.1; ARCHITECTURE-SPINE.md#Structural-Seed]
2. `docker compose up` (from `deploy/`) starts the long-lived services (`control-api`, `egress-guard`, `litellm`, `postgres`, `redis`) and each reports a health check; sandboxes are NOT declared in compose (they are created per-run later). [Source: epics.md#Story-1.1; ARCHITECTURE-SPINE.md AD-4]
3. The web app loads and reaches `control-api` (a health/version endpoint), confirming the control plane is wired. [Source: epics.md#Story-1.1]

## Tasks / Subtasks

- [x] **Task 1: Initialize the pnpm-workspace monorepo skeleton** (AC: #1)
  - [x] Init git-tracked repo root with `package.json` (private, `packageManager: pnpm@11.18.x`), `pnpm-workspace.yaml` (packages: `apps/*`, `packages/*`), a base `tsconfig.base.json`, and root `.npmrc` (see Dev Notes → pnpm hoisting).
  - [x] Create `packages/domain` (TS lib) holding the Glossary entities as types (Agent, Connection, Run, Skill, CostCap, LifecycleState, Allowlist) — types only, no logic yet. [Source: prd.md#3-Glossary; ARCHITECTURE-SPINE.md Consistency-Conventions]
  - [x] Create `packages/contracts` (TS lib) holding placeholder, versioned schemas for the **job spec** and the **control-channel** messages (owned here per AD-9; Zod schemas, exported types). Stub shapes are fine — they harden in Epic 4.
  - [x] Scaffold `apps/web` via `npx sv create apps/web` (SvelteKit, Svelte 5 runes, TypeScript, ESLint+Prettier, Vitest, Playwright; **do NOT add Tailwind** — Warm Ink is the design layer, added in Story 1.2). Record Node 22 LTS in `.nvmrc`/`engines`.
  - [x] Scaffold `apps/control-api` and `apps/egress-guard` as **Hono** (4.12.x) Node services (TS, `@hono/node-server`), each with a minimal server entry and a `Dockerfile`.
  - [x] Scaffold `apps/agent-harness` as a plain Node/TS package (entry stub only — it runs inside a sandbox later; no server). Add a `Dockerfile` for the harness image.
  - [x] Add a root `README.md` recording the **frontend decision (SvelteKit, Svelte 5 runes) and rationale** (solo-dev simplicity; AD-3 build-start binding) — this satisfies the "recorded" clause of AC1.

- [x] **Task 2: Docker Compose for the long-lived services** (AC: #2)
  - [x] Create `deploy/compose.yaml` declaring ONLY long-lived services: `postgres:17`, `redis:8.x`, `litellm` (image `litellm/litellm-database:v1.94.1` — pin the immutable tag, never `:latest`), `control-api`, `egress-guard`. [Source: ARCHITECTURE-SPINE.md AD-4, Structural-Seed]
  - [x] Wire `litellm` to `postgres` + `redis` (required for virtual keys + budget enforcement) via a minimal `litellm-config.yaml`; provide `deploy/.env.example` (NO real secrets committed — see AD-10 / .gitignore).
  - [x] Add a `healthcheck` to every service: postgres (`pg_isready`), redis (`redis-cli ping`), litellm (`/health`), control-api + egress-guard (their `/health`). `control-api`/`egress-guard` depend_on the datastores with `condition: service_healthy`.
  - [x] Add an explicit comment block in `compose.yaml`: sandboxes are created per-run by the run-orchestrator via the Docker API with `--runtime=runsc` + `--network=none` and are intentionally NOT declared here (AC2 + AD-4).
  - [x] Verify `docker compose up` brings all five services healthy on a clean machine.

- [x] **Task 3: Control-plane connectivity — health/version endpoint + web reaches it** (AC: #3)
  - [x] In `apps/control-api`, add `GET /health` (→ `{ ok: true }`) and `GET /version` (→ package version + git short SHA if available), using Hono. Enable permissive CORS for the local web origin only.
  - [x] In `apps/web`, on the root route load, call `control-api`'s `/health` (base URL from an env var, e.g. `PUBLIC_CONTROL_API_URL`) and render a minimal, unstyled "control plane: connected / unreachable" state. (Warm Ink styling is Story 1.2 — keep this plain.)
  - [x] Provide the compose/env wiring so `apps/web` (dev) can reach `control-api`.

- [x] **Task 4: Workspace tooling, scripts, and the test harness** (AC: #1, #2, #3)
  - [x] Root scripts (pnpm): `dev`, `build`, `lint`, `format`, `test` (fan out across workspaces).
  - [x] Vitest configured in `packages/*` and the Node services; Playwright configured in `apps/web`.
  - [x] ESLint + Prettier shared config at the root; ensure `pnpm lint` and `pnpm build` pass clean on the empty skeleton.
  - [x] Add `.gitignore` entries for `node_modules`, build output, and — critically — `deploy/.env` and any secrets (AD-10). Confirm nothing secret is tracked.

## Dev Notes

**This is the foundation story — get the skeleton right and everything downstream inherits it. Keep it minimal: skeletons, health, and wiring only. Do NOT build features, UI polish (Story 1.2), or auth (Story 1.4).**

### Architecture the scaffold must embody
- **Three planes, five long-lived services + per-run sandboxes** (AD-1, AD-4). The compose file is the *long-lived* tier only. Sandboxes are dynamic and must NOT be added to compose — a reviewer will check this. [Source: ARCHITECTURE-SPINE.md AD-1, AD-4, Structural-Seed]
- **All first-party code is TypeScript; LiteLLM is the only non-TS box, run as a sidecar image** (AD-3). Do not write Python. [Source: ARCHITECTURE-SPINE.md AD-3]
- **Source tree (target):** [Source: ARCHITECTURE-SPINE.md#Structural-Seed]
  ```text
  turanga/
    apps/
      web/            # SvelteKit (Svelte 5 runes) — Warm Ink UI (styling lands in 1.2)
      control-api/    # Hono: agents, connections, lifecycle, orchestrator (later)
      egress-guard/   # Hono: allowlist, credential injection, filter hook (later)
      agent-harness/  # runs INSIDE each sandbox; job-spec in, control-channel out (later)
    packages/
      contracts/      # job-spec + control-channel schemas (versioned, control-api owns) — AD-9
      domain/         # Glossary entities shared across TS apps
    deploy/
      compose.yaml    # long-lived services only (NOT sandboxes)
  ```
- **Conventions to seed now** (so later stories inherit them): ULID IDs, UTC ISO-8601 timestamps, money as integer minor units + currency, structured error/refusal shapes, fail-closed defaults. Put shared types/util stubs in `packages/domain`. [Source: ARCHITECTURE-SPINE.md#Consistency-Conventions]
- **Single-writer ownership** (AD-7) is a later-enforced rule, but structure the services now so `control-api` will own Agent/Connection writes and a run-orchestrator (inside/next to control-api) will own Run writes. Don't give `apps/web` direct DB access.

### Verified toolchain (web-checked 2026-07-31 — re-verify before bumping)
- **SvelteKit** `@sveltejs/kit` **2.69.x**, Svelte 5 (runes stable, default). Scaffold with **`npx sv create`** (NOT the deprecated `npm create svelte`). Node **22 LTS**. [Source: svelte.dev/docs/kit/creating-a-project]
- **pnpm** **11.18.x** workspaces (bare — no Turborepo/Nx at this scale; add Turborepo only if build/cache times hurt). [Source: npmjs.com/package/pnpm]
- **Hono** **4.12.x** for `control-api` + `egress-guard` (zero-dep, Web-Standard, first-class TS; use `@hono/node-server`). [Source: npmjs.com/package/hono]
- **LiteLLM** image **`litellm/litellm-database:v1.94.1`** (bundles key-gen/migrations); requires Postgres + Redis; virtual keys with per-key max-budget exist via `/key/generate` (used in Epic 4, not here). **Pin the immutable tag.** [Source: docs.litellm.ai/docs/proxy/release_cycle]
- **gVisor (runsc)** — not needed to *run* compose, but document the target: `sudo runsc install` registers the `runsc` Docker runtime; per-run containers will use `--runtime=runsc --network=none` (Epic 4). Do NOT wire sandbox creation in this story. [Source: gvisor.dev/docs/user_guide/quick_start/docker]
- **Images to pin:** `postgres:17`, `redis:8.x`. [Source: hub.docker.com/_/postgres, _/redis]

### Gotchas (will bite if ignored)
- **pnpm + SvelteKit/Vite hoisting:** pnpm's strict non-hoisted `node_modules` can break Vite/SvelteKit plugin resolution in a workspace. Mitigation: keep each app's direct deps in its own `package.json` (don't rely on root hoisting); if a plugin "cannot be found," add a `.npmrc` `public-hoist-pattern` or set `node-linker=hoisted` for the web app. Reference `contracts`/`domain` as `workspace:*` deps.
- **LiteLLM** ships weekly minor releases with occasional breaking config changes — pin the version and don't use rolling tags.
- **Svelte 5 runes** are the default; ignore older Svelte 4 store-syntax tutorials.
- **Secrets:** never commit `deploy/.env` or provider keys/OAuth tokens (AD-10). The repo already `.gitignore`s `*.user.toml`/`*.user.yaml`; add env + secret patterns.

### Testing standards
- **Unit (Vitest):** `packages/domain` (a type/util smoke test), `packages/contracts` (schema parse/round-trip on the stub job-spec + control-channel shapes).
- **Service (Vitest + Hono test client):** `control-api` `GET /health` returns 200 `{ ok: true }`; `GET /version` returns a version string. Hono's `app.request()` makes this a fast in-process test — no server needed.
- **E2E (Playwright):** `apps/web` root route loads and shows the control-plane connectivity state (mock or hit a running `control-api`).
- **Definition of done for this story:** `pnpm install && pnpm build && pnpm lint && pnpm test` all pass on the skeleton; `docker compose up` brings all five services healthy; the web app renders the control-api health state. No feature code, no styling beyond default, no auth.

### Project Structure Notes
- Matches the Architecture Structural Seed exactly (see tree above). The only build-start binding added is **SvelteKit** for `apps/web` (AD-3 refinement, logged in the architecture memlog 2026-07-31). No variance from the spine.
- `apps/agent-harness` has no server and is not in compose — it is packaged as a Docker image that the orchestrator will run per-run in Epic 4. Scaffolding it now keeps the monorepo shape complete (AC1) without implying runtime wiring.

### References
- [Source: _bmad-output/planning-artifacts/epics.md#Epic-1 / Story-1.1]
- [Source: _bmad-output/planning-artifacts/architecture/architecture-turanga-2026-07-31/ARCHITECTURE-SPINE.md#Design-Paradigm, AD-1, AD-3, AD-4, AD-7, AD-9, #Consistency-Conventions, #Stack, #Structural-Seed]
- [Source: _bmad-output/planning-artifacts/prds/prd-turanga-2026-07-31/prd.md#3-Glossary, NFR-5]
- [Source: _bmad-output/planning-artifacts/architecture/.../addendum.md — sandbox/guard/cost mechanics for Epic 4 (not this story)]
- [Source: .claude/skills/warm-ink-design/ — design system, applied in Story 1.2]

## Dev Agent Record

### Agent Model Used

claude-opus-4-8 (Amelia / dev-story)

### Debug Log References

- `pnpm install` initially ignored esbuild's build script (pnpm 11 gate) → approved via `allowBuilds`/`onlyBuiltDependencies` + `pnpm rebuild esbuild`.
- Node services failed `tsc` with "Cannot find name 'process'/'console'" → added `@types/node@^22` to control-api, egress-guard, agent-harness.
- `pnpm lint` flagged 98 errors, all in `.claude/skills/warm-ink-design/support.js` (vendor bundle) → added `.claude/**` to eslint ignores.

### Completion Notes List

- **AC1 met:** monorepo scaffolded with the exact Structural-Seed tree (apps/web, control-api, egress-guard, agent-harness; packages/contracts, domain; deploy/compose.yaml). Frontend bound to **SvelteKit (Svelte 5 runes)** and recorded in `README.md`; also written back to the architecture spine Stack + Deferred and its memlog (AD-3 refinement). Built by hand rather than the interactive `sv create` to stay deterministic; all-TS, no Python.
- **AC2 met (verified live):** `docker compose up --build` brought all five long-lived services to **healthy** — postgres:17, redis:8, litellm (`litellm/litellm-database:v1.94.1`), control-api, egress-guard. Compose declares NO sandboxes; a comment block documents that per-run gVisor sandboxes are created by the orchestrator (AD-4). Stack torn down after verification.
- **AC3 met (verified live):** control-api `GET /health` → `{"ok":true}` and `GET /version` reachable from host; the SvelteKit page fetches control-api `/health` and a **Playwright e2e passed** asserting the page reads "control plane: connected" against the running stack (dev origin :5173 matches control-api CORS allowlist).
- **Verification:** `pnpm -r build` (6/6), `pnpm -r test` (domain 2, contracts 3, control-api 2, egress-guard 1, agent-harness 1, web svelte-check 0 errors), `pnpm lint` clean, compose all-healthy, Playwright 1 passed.
- **Scope honored:** no Warm Ink styling (Story 1.2), no auth (Story 1.4), no feature logic. `packages/contracts` + `domain` are stubs that seed conventions (ULID, UTC, money-as-minor-units) per AD-7/AD-9. Secrets: `deploy/.env` and `**/.env` gitignored; only `.env.example` committed (AD-10).
- **Note for reviewer:** Node service images build pnpm inside via `corepack`; `.npmrc` public-hoist patterns added to avoid pnpm+Vite plugin-resolution issues (documented gotcha).

### File List

**Root:** `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `tsconfig.base.json`, `.npmrc`, `.nvmrc`, `eslint.config.js`, `.prettierrc.json`, `.prettierignore`, `.gitignore` (modified), `README.md` (modified)
**packages/domain:** `package.json`, `tsconfig.json`, `src/index.ts`, `src/index.test.ts`
**packages/contracts:** `package.json`, `tsconfig.json`, `src/index.ts`, `src/index.test.ts`
**apps/control-api:** `package.json`, `tsconfig.json`, `Dockerfile`, `src/app.ts`, `src/server.ts`, `src/app.test.ts`
**apps/egress-guard:** `package.json`, `tsconfig.json`, `Dockerfile`, `src/app.ts`, `src/server.ts`, `src/app.test.ts`
**apps/agent-harness:** `package.json`, `tsconfig.json`, `Dockerfile`, `src/main.ts`, `src/main.test.ts`
**apps/web:** `package.json`, `tsconfig.json`, `svelte.config.js`, `vite.config.ts`, `playwright.config.ts`, `.env.example`, `src/app.html`, `src/app.d.ts`, `src/routes/+page.svelte`, `tests/health.spec.ts`
**deploy:** `compose.yaml`, `litellm-config.yaml`, `.env.example`
**Also updated (planning):** `_bmad-output/planning-artifacts/architecture/architecture-turanga-2026-07-31/ARCHITECTURE-SPINE.md` + `.memlog.md` (SvelteKit binding recorded)

### Change Log

- 2026-07-31 — Scaffolded the all-TypeScript pnpm-workspace monorepo (SvelteKit web, Hono control-api + egress-guard, agent-harness, domain + contracts packages), the long-lived docker-compose stack (Postgres/Redis/LiteLLM), and control-plane health wiring. All ACs verified live (builds, unit tests, lint, compose health, Playwright e2e). Status → review.
