# turanga

A generic, isolation-first platform for building, securing, and operating your own ecosystem of agents. Every agent runs in a sandbox you control — a container with a guarded data ingress/egress boundary — under a hard cost ceiling, moved deliberately from draft → test → Activate. The wedge: **agents you can trust with real access.**

Planning artifacts live under `_bmad-output/planning-artifacts/` (product brief, PRD, architecture spine, UX spines, epics & stories).

## Architecture (build shape)

Three planes (see `_bmad-output/planning-artifacts/architecture/.../ARCHITECTURE-SPINE.md`):

- **Control plane** — `apps/web` (UI) + `apps/control-api` (agents, connections, lifecycle, run-orchestrator).
- **Guard broker** — `apps/egress-guard` (allowlist + credential injection + filter hook) + LiteLLM (model gateway sidecar).
- **Execution plane** — `apps/agent-harness` running inside per-run gVisor sandboxes (created dynamically, never in compose).

Shared: `packages/domain` (Glossary entities) · `packages/contracts` (versioned job-spec + control-channel schemas, owned by control-api).

## Stack decision — frontend framework

**`apps/web` is SvelteKit** (Svelte 5, runes), bound at build start (2026-07-31) per architecture AD-3. Rationale: for a solo builder, SvelteKit is less ceremony and one framework can serve the UI and (if desired) a thin API from the same Node server. This choice has **no ripple into the security architecture**. Backend services (`control-api`, `egress-guard`) are **Hono** on Node 22; the monorepo uses **pnpm workspaces**.

## Develop

```bash
pnpm install
pnpm build        # builds all packages/apps
pnpm test         # unit tests + svelte-check
pnpm lint

# bring up the long-lived services (Postgres, Redis, LiteLLM, control-api, egress-guard)
cd deploy && cp .env.example .env && docker compose up --build
```

Sandboxes are created per-run by the orchestrator (Epic 4), not by compose.
