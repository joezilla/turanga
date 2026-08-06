# turanga

A generic, isolation-first platform for building, securing, and operating your own ecosystem of agents. Every agent runs in a sandbox you control — a container with a guarded data ingress/egress boundary — under a hard cost ceiling, moved deliberately from **draft → test → Activate**. The wedge: **agents you can trust with real access.**

Planning artifacts live under `_bmad-output/planning-artifacts/` (product brief, PRD, architecture spine, UX spines, epics & stories).

## What you can do today

- **Define an agent** — pick a model, write instructions (with variables), attach **skills** and **tools** with per-operation grants, and set **per-run + per-day cost caps**. Everything starts in Draft.
- **Test it in a sandbox** — run the agent inside an isolated, network-denied container and watch a live transcript: every model turn, tool call, refusal, and the running spend.
- **Give it real capabilities, safely:**
  - **Skills** — provider-agnostic connection operations (e.g. Gmail read → draft → send) with a Guard-enforced permission scope and send-gate.
  - **Tools** — remote **MCP** servers (streamable HTTP) attached with least-privilege per-operation grants. The agent invokes them through the Guard, which resolves the endpoint and injects the credential — the agent never sees a URL or key.
  - **A model-driven tool loop** — the model is told which tools it has, **chooses** which to call with what arguments, sees the result, and **iterates** until it answers (built on the Vercel AI SDK, bounded by a step ceiling *and* the cost cap).
- **Activate & operate** — promote a vetted agent to Active (gated on model + both caps), then watch live status and spend across every agent.
- **Chat** — hold a multi-turn conversation with a **published** agent. Chat is threaded runs: each message is a fresh sandboxed, cost-capped, Guard-fronted run carrying the thread so far.
- **Memory (opt-in)** — agents can learn from their runs: a control-plane vector store recalls the most relevant past learnings into a run and distills durable memories afterward. Off by default, three-level configurable, privacy-scoped per agent.

**Roadmap:** self-deployed tool containers · evals (a tracked quality score, incl. memory oversight) · a first-class agent-scoped data store · and the remaining tool-loop polish (repair hardening, richer step observability, model-capability signals).

## Architecture (build shape)

Three planes (see `_bmad-output/planning-artifacts/architecture/architecture-turanga-2026-07-31/ARCHITECTURE-SPINE.md`). The load-bearing invariants:

- **AD-1** — a run's sandbox is `--network=none`; its **only** egress is the per-run Guard Unix socket.
- **AD-7** — `control-api` is the sole writer of agent/connection/tool state; the run-orchestrator owns run lifecycle.
- **AD-9** — the JobSpec is immutable at run start; the harness decides no policy and has no mid-run side-channel.
- **AD-10** — no secret ever reaches the sandbox; it names only logical handles + operations + argument schemas. The Guard holds every endpoint and credential; LiteLLM holds the model keys.

| Plane | What runs there |
|---|---|
| **Control** | `apps/web` (SvelteKit UI) + `apps/control-api` (Hono: agents, connections, tools, memory, conversations, the run-orchestrator, cost-key minting). |
| **Guard broker** | `apps/egress-guard` (Hono: default-deny allowlist, credential injection, the agent→model + agent→tool + agent→connection brokers, live cost metering + kill-on-breach, the filter-hook seam) + **LiteLLM** (model gateway sidecar; normalizes function-calling across providers). |
| **Execution** | `apps/agent-harness` running inside per-run **gVisor** sandboxes, created dynamically by the orchestrator (never in compose). Runs the model-driven tool loop (Vercel AI SDK) over the Guard socket. |

Shared: `packages/domain` (Glossary entities) · `packages/contracts` (versioned JobSpec + control-channel + harness↔Guard schemas, owned by control-api — currently **CONTRACT_VERSION 9**).

**How a tool loop stays safe.** The AI SDK owns *cognition* (the loop, step-counting, tool-call parsing, result fold-back); turanga owns *transport + enforcement*. The SDK's model calls leave only via the Guard socket holding **no** credential, and each tool call is brokered by the Guard (per-op grant + injected credential). A multi-step turn is simply N metered model round-trips under one per-run cost cap — the cap bounds the loop for free, with a step ceiling as an independent control backstop. The fat SDK dependency is tolerable *because* the sandbox has no network and no secret (AD-1/AD-10).

## Stack

**All-TypeScript** monorepo (pnpm workspaces, Node 22).

- **Frontend:** `apps/web` is **SvelteKit** (Svelte 5, runes), bound at build start (2026-07-31, architecture AD-3). No Tailwind — the **Warm Ink** design system (semantic CSS tokens) is the design layer. This choice has **no ripple into the security architecture**.
- **Services:** `control-api` + `egress-guard` are **Hono** on Node 22. Data: **Postgres 17 + pgvector** (Drizzle ORM), **Redis 8**. Model gateway: **LiteLLM** (the only non-TS box). Sandboxes: **Docker + gVisor**. Agentic loop: **Vercel AI SDK** (`ai@7`) inside the harness.

## Develop

```bash
pnpm install
pnpm -r build     # builds all packages/apps
pnpm -r test      # unit tests + svelte-check
pnpm lint

# bring up the long-lived services (Postgres+pgvector, Redis, LiteLLM, control-api,
# egress-guard, an MCP stub for tools) and build the per-run agent-harness image
cd deploy && cp .env.example .env && docker compose up --build
```

Sandboxes are created **per-run** by the orchestrator (Epic 4), not by compose — `agent-harness-image` in compose only builds the image the orchestrator launches.

> **Isolated e2e stack:** use `deploy/test-stack.sh` (the `turanga-e2e` compose project with throwaway volumes) for end-to-end testing so `down -v` can never wipe the dev stack's data.

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

## Connecting a tool (MCP)

Tools → Add a tool → **Remote MCP**: give an MCP server's URL + credential. turanga runs a `list-tools` handshake through the Guard so you can see the operations it offers, then attach the tool to an agent and grant operations one by one (default-deny). At runtime the agent invokes them by logical name; the Guard resolves the endpoint, injects the held credential, and records every call. The credential is **held Guard-side** and never reaches the agent (AD-10).
