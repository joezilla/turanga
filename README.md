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

## Connecting Gmail (optional)

The Gmail data connection (Settings → Data connections) needs your own Google Cloud OAuth client. Without it, the UI shows "Google OAuth isn't configured" — everything else works.

1. In the [Google Cloud Console](https://console.cloud.google.com/), create a project.
2. **OAuth consent screen** → External, publishing status **Testing**, and add your own Google account under **Test users**. (Testing-mode refresh tokens expire after 7 days — fine for local use; reconnect when it lapses.)
3. **Credentials → Create OAuth client ID → Web application.** Add an **Authorized redirect URI**: `http://localhost:8080/oauth/google/callback`.
4. Put the client id/secret in `deploy/.env`:
   ```
   GOOGLE_OAUTH_CLIENT_ID=…
   GOOGLE_OAUTH_CLIENT_SECRET=…
   TOKEN_ENC_KEY=<a long random string>   # encrypts the refresh token at rest; set once
   ```
5. `docker compose up -d` (recreate control-api), reload the UI, and click **Connect with Google**.

Scopes requested (least-privilege): `gmail.modify` (read + label + draft, no auto-send) + `openid email`. The refresh token is stored **encrypted** by control-api and never reaches the browser or an agent.
