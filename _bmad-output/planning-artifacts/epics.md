---
stepsCompleted: [step-01-validate-prerequisites, step-02-design-epics, step-03-create-stories, step-04-final-validation]
inputDocuments:
  - _bmad-output/planning-artifacts/prds/prd-turanga-2026-07-31/prd.md
  - _bmad-output/planning-artifacts/prds/prd-turanga-2026-07-31/addendum.md
  - _bmad-output/planning-artifacts/architecture/architecture-turanga-2026-07-31/ARCHITECTURE-SPINE.md
  - _bmad-output/planning-artifacts/ux-designs/ux-turanga-2026-07-30/DESIGN.md
  - _bmad-output/planning-artifacts/ux-designs/ux-turanga-2026-07-30/EXPERIENCE.md
---

# turanga - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for turanga, decomposing the requirements from the PRD, the UX Design spine pair (DESIGN.md + EXPERIENCE.md), and the Architecture spine into implementable stories.

> **Reconciliation note.** The UX spines (status: draft, 2026-07-30) were authored before the PRD and Architecture were finalized. Where they diverge, the **final PRD and Architecture win**, and the divergence is flagged inline as `[RECONCILE]`. The UX work is otherwise incorporated in full.

## Requirements Inventory

### Functional Requirements

FR-1: The builder can create an Agent and edit its model, instructions, attached Skills, and Permission Scopes. New Agents start in Draft; edits autosave.
FR-2: The builder can select an Agent's model from models exposed by a connected Model Provider; unconfigured providers show disabled with a connect link.
FR-3: The builder can attach Skills to an Agent and set a Permission Scope for each; default scope is most-restrictive (deny); out-of-scope invocations are refused and recorded.
FR-4: The builder can run an Agent in Test on demand — sandboxed, against the Agent's live Data Connection data in read-only mode — producing a transcript + per-turn metrics (latency, tokens, cost).
FR-5: The builder can promote an Agent to Active (Activate) — a deliberate action, blocked with a stated reason unless a model is selected and both cost caps are set; Active agents can be returned to Draft (Deactivate).
FR-6: Every Agent has exactly one visible Lifecycle State (Draft/Test/Active), shown via dot + word (never colour alone); a Draft agent cannot run a production Run.
FR-7: Every Agent Run executes inside a Sandbox by default; there is no un-sandboxed path; sandbox-establish failure fails the Run (fail-closed); concurrent Runs share no state.
FR-8: The Guard permits a Run to reach only allowlisted destinations (default-deny); blocked egress is refused and recorded with the attempted destination.
FR-9: The Guard governs ingress; an Agent receives data only from its configured, permitted Connections, attributable to a specific Connection.
FR-10: The Guard exposes a Filter Hook interface for future ingress/egress inspection; no-op when no filter is registered; a registered test filter demonstrably blocks a matching payload.
FR-11: The builder can set two hard Cost Caps per Agent — a per-run cap and a per-day cap; an Agent cannot be Activated without both; caps editable while Active.
FR-12: turanga meters spend live against both caps and terminates an in-progress Run on breach (kill within one model round-trip); the meter matches summed Run metrics (no drift).
FR-13: The builder can connect a Model Provider by credential; its models become selectable; status shown as connected/error/unconfigured; invalid key surfaces a cause; stored keys masked.
FR-14: The builder can configure a generic Data Connection an Agent may use, subject to the Guard; MVP ships one implementation — Gmail via scoped OAuth; no email-specific logic in platform code paths.
FR-15: The builder can view and manage all Agents and Connections from a single management surface; agents list shows Lifecycle State + live cost meter; removing an in-use Connection surfaces dependents first.
FR-16: The builder can sign in with email + password; unauthenticated access to any non-Login surface is refused; passwords hashed; SSO slot reserved, not implemented.
FR-17: turanga ships a small built-in Skill set — read/search, draft reply, flag/label, summarize — as generic capabilities exposed through the Skill interface (not email-specific), each attachable and permission-scoped.
FR-18: Any Skill with an outbound effect (e.g. sending a drafted reply) requires an explicit Permission Scope grant and never sends automatically; sending is a distinct, permission-gated action.

### NonFunctional Requirements

NFR-1: Isolation integrity — a Run must never execute outside a Sandbox, even on error paths; fail-closed, never fall-through.
NFR-2: Egress fail-closed — any Guard error/misconfiguration results in refused egress, never permitted egress.
NFR-3: Cost enforcement reliability — kill-on-breach and the meter hold under concurrent Runs; no undercount that silently exceeds a cap.
NFR-4: Observability — every Run records its transcript, metrics, and any Guard/permission refusals ("what did it do and what was blocked").
NFR-5: Local-first data — single-machine; the builder's data and keys stay on the builder's infrastructure; no turanga-operated cloud dependency to run agents.
NFR-6: Visual identity — all UI conforms to the Warm Ink design system and the UX spines; status never colour-only; numbers mono/tabular.

### Additional Requirements

*(From the Architecture spine — ADs, conventions, stack, and structural seed. These drive foundation/infra stories.)*

- **Greenfield scaffold (Epic 1, Story 1):** no external starter template chosen. Stand up an **all-TypeScript monorepo**: `apps/web` (frontend), `apps/control-api`, `apps/egress-guard`, `apps/agent-harness`; `packages/contracts` (job-spec + control-channel schemas, control-api-owned, versioned), `packages/domain` (Glossary entities); `deploy/compose.yaml`. (AD-3, Structural Seed)
- **Three-plane topology (AD-1):** trusted control plane, untrusted per-Run execution plane, mediating Guard broker; the sandbox has exactly one outbound edge — the Guard.
- **Single Guard choke point, two policy modules (AD-2):** one broker classifies outbound flow — Model-Provider → cost meter + kill; else → allowlist + filter hook.
- **Two deployment tiers (AD-4):** long-lived services via `docker compose` (`control-api`, `egress-guard`, `litellm`, `postgres`, `redis`); sandboxes created per-Run by the orchestrator via Docker API with `--runtime=runsc` (gVisor) + `--network=none`, reaped on completion.
- **Egress guard two modes (AD-5):** credentialed-connection gateway (terminates TLS, injects held credential) + plain allowlisted CONNECT tunnel (SNI allowlist, opaque); allowlist = union of attached Connections' declared destinations + explicit additions; agent never holds raw credentials.
- **Cost enforcement via LiteLLM (AD-6):** per-agent virtual key (daily budget) + per-run key (per-run cap); LiteLLM 429 is the hard stop; orchestrator kill merely reaps; cap-config owned by control-api, spend owned by LiteLLM (Redis/Postgres); MVP trusts LiteLLM enforcement (reserve-then-reconcile = roadmap).
- **Single-writer per entity (AD-7):** control-api sole writer of Agent/Connection; run-orchestrator sole writer of Run; nobody writes spend. Postgres = record of truth.
- **Lifecycle transitions (AD-8):** Activate (gated) / Deactivate; Run lifecycle created → running → (succeeded | failed | killed). `[RECONCILE: UX "review" state and "Deploy" verb → MVP uses succeeded|failed|killed and the verb "Activate"; mid-run review is roadmap.]`
- **Job-spec + control-channel contract (AD-9):** immutable job spec injected at Run start (versioned, control-api-owned); harness emits results on one control channel; runtime data ingress = proxy-mediated Connection reads only.
- **Secrets never in sandbox (AD-10):** provider keys in LiteLLM; OAuth tokens in egress-guard; encrypted at rest.
- **Conventions:** ULID IDs; UTC ISO-8601 timestamps; money as integer minor units + currency; structured refusal records; fail-closed everywhere; single authenticated surface.
- **Stack seed (verify at build):** TypeScript/Node LTS; Next.js 16 **or** SvelteKit (pick at build start); LiteLLM 1.94 (sidecar); Docker + gVisor `runsc`; PostgreSQL 16; Redis 7.

### UX Design Requirements

*(Extracted in full from DESIGN.md + EXPERIENCE.md. `[RECONCILE]` marks where the draft UX must bend to the final PRD/Architecture.)*

UX-DR1: Adopt the **Warm Ink design system** as the token/foundation layer — import the token CSS (colours: ink ramp, signal, semantic, agent-state, viz; typography: Instrument Sans + IBM Plex Mono, 11–48px scale, weights 400/500/600 only; spacing: 4px grid + control heights + layout constants; shape: radii/borders/shadows; motion: durations/easings). Consume **semantic tokens only**; light + dark via `data-theme`, no per-surface theme branches.
UX-DR2: **App shell** — left sidebar 248px (nav: Agents, Settings; collapsible; selected uses `--surface-selected`), topbar 48px (workspace name, theme toggle, account menu), content max 1240px.
UX-DR3: **Login surface** — centered login-card (400px, `--surface-card`, subtle border, `--shadow-sm`), email + password with persistent labels, product name in Instrument Sans Medium (no logo), reserved SSO slot below a hairline.
UX-DR4: **Agents list surface** (post-login landing) — lists agents with lifecycle status (dot + word) and live cost meter for Active agents; empty state "No agents yet." + *Create agent*; `/` focuses filter.
UX-DR5: **Agent-definition two-pane split** (60/40 draggable; collapses to a `Test` toggle < 1024px) — left = agent-editor-pane with collapsible sections; autosave with `Saving… → Saved` micro-cap state, no manual Save for config. `[RECONCILE: sections are Model, Instructions, Skills, Variables, Cost caps, Allowlist — "Tools/Knowledge" from the draft become "Skills" (FR-17) and drop Knowledge/RAG (roadmap).]`
UX-DR6: **Instructions editor** — mono textarea; typing `{` opens a variable-insert popover; inserted `{vars}` render as signal-tinted variable-token; an undefined `{var}` surfaces a caution hint linking to Variables.
UX-DR7: **Test pane** — persistent chat transcript; send → streaming turn with the pulsing running dot; resolves to succeeded/failed dot + mono metrics (latency ms, tokens, cost); `Clear` resets; `Cmd/Ctrl+Enter` runs the test. `[RECONCILE: Test runs against live Data Connection data read-only (FR-4); no "review" resolution in MVP.]`
UX-DR8: **Model selector** — grouped by provider; unconfigured provider disabled with `Connect in Settings`; leading provider-status dot; renders `provider / model-id` in mono.
UX-DR9: **Skill chip** — rectangular (4px, not a pill); `Add` opens a searchable picker popover; removable inline. `[RECONCILE: "Add tool" → "Add skill".]`
UX-DR10: **Provider card** (Settings › Model providers) — status dot + word; masked key; actions Connect / Update key / Remove; inline pending → connected/error with a cause.
UX-DR11: **Agent status-dot component** — 6–7px dot + word; running pulses 1600ms; used in agents list + test pane; never colour-only. `[RECONCILE: MVP states = idle | running | succeeded | failed | killed; "review" is roadmap (AD-8).]`
UX-DR12: **Settings sub-nav** — selected uses `--surface-selected`. `[RECONCILE: MVP sections = Model providers, Data connections, Profile. Workspace + Billing are roadmap (PRD Non-Goals); a Data connections section is required for Gmail (FR-14).]`
UX-DR13: **Five state patterns** on every data surface — Loading (skeletons, no full-page spinners), Empty (fact + one action), Error (cause → consequence → recovery, inline), Saving/Saved, Agent lifecycle (dot + word).
UX-DR14: **Interaction primitives** — autosave for config; explicit verbs for state changes; keyboard (`Cmd/Ctrl+Enter` run test, `Esc` close, full tab order, `/` filter); hover = one surface step up / press = one down / focus = always-visible teal ring; only looping motion is the running pulse; destructive actions confirm in a dialog naming the consequence.
UX-DR15: **Accessibility floor** — every interactive element keyboard-reachable with a visible focus ring (never removed); status never colour-only; WCAG AA body text; persistent form labels + associated, announced errors; mono metric text ≥ 12px.
UX-DR16: **Voice & microcopy** — sentence case; verb-first buttons (`Activate`, `Run test`, `Connect`, `Add skill`, `Remove`); second person for the user / third for the agent; specific unrounded numbers; empty states = fact + one action; errors = cause → consequence → recovery; no exclamation marks, no emoji; agent state stated, never celebrated. `[RECONCILE: use "Activate" not "Deploy".]`
UX-DR17: **Theme** — light + dark as equals; theme is a Profile setting persisted per user; toggle in the topbar.
UX-DR18: **Responsive & platform** — desktop-first, min width 1024px; agent-definition two-pane ≥ 1024 collapses below; Login + Settings single-column reflow; no mobile experience in v1.
UX-DR19: **Icons** — Lucide, `currentColor`, 16/20px; no emoji, no unicode glyphs as icons.
UX-DR20: **Cost-caps UI + live meter** (new, PRD-driven) — per-run and per-day cap inputs in agent-definition (money minor units), required before Activate; live cost meter (current run vs per-run cap; day vs per-day cap) surfaced in agent-definition and the agents list, mono/tabular.
UX-DR21: **Data connections surface** (new, PRD-driven) — connect Gmail via scoped **OAuth** (not API-key paste); connection status dot + word; revoke; declared destinations visible.
UX-DR22: **Skills & permissions UI** (new, PRD-driven) — attach built-in skills; per-skill permission scope; the send action shown as a distinct, gated permission; a drafted reply is a produced artifact reviewed/sent as a separate action (FR-18).
UX-DR23: **Egress allowlist view** (new, arch-driven) — per-agent allowlist (Connection-derived destinations + explicit additions, default-deny); blocked-egress refusals surfaced in the test/run view with destination + reason (NFR-4).
UX-DR24: **Activate-gating UI** (new, PRD-driven) — Activate control disabled with a stated reason until a model is selected and both caps are set (FR-5); Deactivate returns to Draft.

### FR Coverage Map

- FR-1: Epic 3 — create/edit agent definition (Draft).
- FR-2: Epic 3 — select model from a connected provider.
- FR-3: Epic 3 — attach skills + scoped permissions (authoring); Epic 4 — runtime refusal enforcement.
- FR-4: Epic 4 — run agent in Test (sandboxed, live read-only).
- FR-5: Epic 5 — promote to Active (Activate) / Deactivate, gated.
- FR-6: Epic 3 — Draft state + visibility; Epic 5 — Active state.
- FR-7: Epic 4 — sandbox every run by default (fail-closed).
- FR-8: Epic 4 — default-deny egress allowlist.
- FR-9: Epic 4 — controlled ingress via Connections.
- FR-10: Epic 4 — filter hook seam.
- FR-11: Epic 3 — set per-run + per-day caps; Epic 4/5 — enforcement.
- FR-12: Epic 4 — live meter + kill-on-breach during runs; Epic 5 — in production.
- FR-13: Epic 2 — manage model provider connections.
- FR-14: Epic 2 — Gmail data connection via OAuth (generic Connection).
- FR-15: Epic 2 — connections management; Epic 3 — agents management; Epic 5 — live status/meter.
- FR-16: Epic 1 — single-user email + password auth.
- FR-17: Epic 3 — built-in skill set attachable; Epic 4 — execution.
- FR-18: Epic 3 — send-gate configuration; Epic 4 — outbound action gating at runtime.

## Epic List

### Epic 1: Foundation & Access
The builder can open turanga, sign in, and land in a styled, navigable app shell. Stands up the greenfield all-TypeScript monorepo (scaffold), the Warm Ink design system, the app shell + theme toggle, and single-user authentication.
**FRs covered:** FR-16 (+ scaffold, conventions, UX-DR1, UX-DR2, UX-DR3, UX-DR17)

### Epic 2: Connections
The builder can connect and centrally manage the model provider(s) and a Gmail data connection their agents will use — with credentials held securely off the agent (LiteLLM holds provider keys; the egress-guard holds OAuth tokens).
**FRs covered:** FR-13, FR-14, FR-15 (connections) (UX-DR10, UX-DR21; AD-5, AD-10)

### Epic 3: Agent Definition
The builder can create and fully configure an agent in Draft — model, instructions with variables, attached skills with scoped permissions, and per-run + per-day cost caps — and manage all agents from one place.
**FRs covered:** FR-1, FR-2, FR-3 (authoring), FR-6 (Draft + visibility), FR-11 (set caps), FR-15 (agents), FR-17, FR-18 (send-gate config) (UX-DR4, UX-DR5, UX-DR6, UX-DR8, UX-DR9, UX-DR20, UX-DR22)

### Epic 4: Sandboxed Execution & the Guard
The builder can Test an agent and watch it run inside an isolated sandbox — reaching only allowlisted destinations, metered live, killed on breach — with every action and refusal observable. The trust core.
**FRs covered:** FR-4, FR-7, FR-8, FR-9, FR-10, FR-12, FR-3/FR-17/FR-18 (runtime enforcement) (UX-DR7, UX-DR11, UX-DR13, UX-DR23; AD-1, AD-2, AD-4, AD-5, AD-6, AD-9)

### Epic 5: Activation & Operation
The builder can deliberately Activate an agent (gated on model + both caps), operate it in production with caps and guard holding, and see live status + spend across all agents — the exhale test.
**FRs covered:** FR-5, FR-6 (Active), FR-11/FR-12 (production enforcement), FR-15 (live status/meter) (UX-DR24; AD-8)

### Epic 6: Tools — the agent↔tool contract + remote MCP
Agents gain **tools**: capabilities they invoke at runtime beyond the model. Establishes the agent↔tool contract (MCP over streamable HTTP, brokered by the Guard), the permission model (attach + per-operation grant, mirroring Skills), tool discovery, credential custody (Guard-held — the agent never holds a tool's URL or key), and invocation observability — proven end-to-end with the cheap endpoint type, **remote MCP** (URL + credential). The Guard gains its server-side agent→tool broker; endpoint type is an adapter (remote now, container in Epic 7). *(Post-MVP; captured 2026-08-03. AD-5, AD-7, AD-10, E4-AD-10.)*

### Epic 7: Self-deployed tool containers
The builder can deploy their **own** trusted tool containers into turanga and have them registered as tools once they satisfy a packaging contract. Inherits Epic 6's contract wholesale; adds the container packaging contract (MCP-HTTP + `/health` + manifest), UI deploy with **legible per-clause contract verification**, the tool as a long-lived (one-per-operator) guard-fronted node with its **own** Guard-mediated egress (a tool can have its own connections), and the Guard's client-side tool→world broker. Containers are trusted (operator-authored, trusted SDLC); "untrust it" (gVisor, input screening) is a later flag. *(Post-MVP; captured 2026-08-03. AD-1, AD-5, AD-10.)*

### Epic 8: Agent memory — the self-improving loop
Agents **learn from their runs**. turanga already records every run (the transcript) but nothing reads it back. This epic closes the loop: a control-plane **memory store** (pgvector), a **recall** step that injects the most relevant memories into the immutable job spec at run start, and a post-run **reflection** step that distills the transcript into durable, scoped memories — so an agent that fails a task once can succeed the next time because it *remembered* (the Hermes-style do → reflect → remember → recall → improve loop, on turanga's isolation rails). Memory is **off by default and three-level configurable — per individual agent (enable/disable, recall vs reflect, per kind) governed by global defaults an operator sets once** — because it is a privacy-sensitive, data-collecting surface; the toggle is enforced control-plane (AD-7). All storage/retrieval/consolidation is control-plane; the sandbox never touches memory (AD-1); memories are secret-free spec content (AD-10); recall is zero-cost (embedding-only) and reflection is observed-not-metered. mempalace's distinctives (scoped recall, temporal knowledge graph, memory-as-a-tool) are additive later phases. *(Post-MVP; captured 2026-08-03. AD-1, AD-7, AD-9, AD-10, FR-7.)*

### Epic 9: Chat — a multi-turn conversation with a published agent
The builder **converses** with an agent instead of firing one-shot test tasks. Chat is **threaded runs**: each user message spawns a fresh run — against the agent's **published version**, with the conversation history injected into the immutable job spec — whose reply streams back and appends to the thread. Every turn stays network-isolated, cost-capped, Guard-fronted, and observable (AD-1/AD-9); the conversation is a control-plane thread that reuses the entire run/harness/Guard/observability machinery. Chat is short-term *thread* memory and composes with Epic 8's long-term memory. **Builder-first** (single-tenant, control-plane only); a **deployable/shared end-user** surface (identity, access control, per-conversation isolation, abuse/rate limits) is an additive later phase, and true mid-turn human-in-the-loop is deferred (a turn completes, then you reply). Requires a published agent — ties into the draft/publish model. *(Post-MVP; captured 2026-08-05. AD-1, AD-7, AD-9, AD-10.)*

### Epic 10: Evals — measuring agent performance over time
A repeatable way to **grade an agent** so quality is a tracked number, not a vibe. An **eval case** = a fixed task input + a grader (**assertion** — deterministic; **LLM-as-judge** — a control-plane, observed-not-metered model call; or **human rating**); an eval run is just a turanga run, so it reuses the whole run/Guard/observability stack. Produces a **per-agent score timeline** correlated with publish versions and learning events. Its keystone use is **memory oversight**: run a suite against different **memory states** (off / current / a snapshot) and after each consolidation — if learning drops the score, alert and quarantine the offending memories. Evals also gate publishes and (Epic 9) chat flows. *(Post-MVP; captured 2026-08-05. Consumes Epic 8's memory-state hooks. AD-1, AD-7.)*

### Epic 11: Agent data & artifacts — an agent-scoped store
A first-class, **agent-scoped, authoritative data store** for the structured/exact data an agent owns (the stock-advisor's **portfolio**), distinct from learned memory: a **structured store** (CRUD records), **artifacts/blobs** (files the agent reads/writes), and **reference knowledge** (user-authored authoritative docs). Runtime read/write means it is **Guard-brokered** (the Epic 6 tool path, not job-spec injection), agent-isolated (enforced control-plane), quota'd, credential Guard-held — effectively a first-party "the agent's own store" tool. Inherits **Epic 8's foundations**: the agent-scoped control-plane store + isolation pattern, the generalized "first-party store exposed as a Guard tool" seam, and the embedding/recall infra (for reference-knowledge RAG). *(Post-MVP; captured 2026-08-05. Builds on Epic 6 broker + Epic 8 store patterns. AD-1, AD-5, AD-7, AD-10.)*

### Epic 12: Model-driven tool loop — the agent actually decides
The **Epic 6 follow-on that makes tools real.** Epic 6 shipped the tool *contract*, the Guard *broker*, per-operation *grants*, and *observability* — but the harness never tells the model its tools exist and never lets the model choose to call one. Instead a deterministic stub (Story 6.4) blindly fires each tool's *first* operation once, folds a bare "Called X." note into context, and asks for text — so agents on capable models still confabulate a fake toolkit and deny the tools they were just handed. This epic replaces that stub with a real **reason→act→observe loop** built on the **Vercel AI SDK**: the model is told its granted tools (a function-calling manifest), *chooses* which to call with what arguments, the Guard brokers each call, the result folds back into context, and it iterates until a final answer or a bounded stop. A **Phase-0 seam spike is done and proven** (branch `spike/agent-tool-loop`, offline + deterministic): the SDK routes both model and tool calls entirely through the per-run Guard socket with **no credential and no network in the sandbox**. The architecture principle: the **SDK owns cognition** (the loop, step-counting, tool-call parsing, result fold-back, malformed-call repair); **turanga keeps owning transport + enforcement** (the Guard socket, no secrets, no network, cost metering, kill-on-breach). *(Post-MVP; captured 2026-08-05. Completes Epic 6. AD-1, AD-7, AD-9, AD-10; cost cap Story 4.5.)*

> **Cross-cutting UX conventions** (applied as ACs across all UI stories, not standalone): UX-DR14 interaction primitives, UX-DR15 accessibility floor, UX-DR16 voice/microcopy, UX-DR19 Lucide icons. Established as project conventions in Story 1.2 and re-asserted per surface.

## Epic 1: Foundation & Access

The builder can open turanga, sign in, and land in a styled, navigable app shell.

### Story 1.1: Scaffold the all-TypeScript monorepo and service skeleton

As the builder,
I want the turanga project to stand up as a running skeleton,
So that every later feature has a place to live and a way to run.

**Acceptance Criteria:**

**Given** an empty repo
**When** the monorepo is scaffolded
**Then** it contains `apps/web`, `apps/control-api`, `apps/egress-guard`, `apps/agent-harness`, `packages/contracts`, `packages/domain`, and `deploy/compose.yaml` (per the Architecture Structural Seed)
**And** the frontend framework is chosen (Next.js or SvelteKit) and recorded.

**Given** the scaffold
**When** `docker compose up` runs
**Then** the long-lived services start (`control-api`, `egress-guard`, `litellm`, `postgres`, `redis`) and each reports a health check
**And** sandboxes are NOT declared in compose (they are created per-run later).

**Given** the running skeleton
**When** the web app is opened
**Then** it loads and reaches `control-api` (a health/version endpoint), confirming the control plane is wired.

### Story 1.2: Adopt the Warm Ink design system as the foundation layer

As the builder,
I want turanga's UI built on the Warm Ink tokens from day one,
So that every surface is consistent and themable without rework.

**Acceptance Criteria:**

**Given** the web app
**When** the design layer is added
**Then** the Warm Ink token CSS is imported and components consume semantic tokens only (colours, typography Instrument Sans + IBM Plex Mono, spacing, shape, motion) — UX-DR1.

**Given** the token layer
**When** the theme is switched via `data-theme`
**Then** light and dark both render correctly with no per-surface theme branch — UX-DR17.

**Given** project conventions
**When** a component is built
**Then** icons are Lucide/`currentColor` (UX-DR19), numbers render mono/tabular, and the accessibility + voice baselines (UX-DR15, UX-DR16) are documented as conventions.

### Story 1.3: App shell — sidebar, topbar, content, theme toggle

As the builder,
I want a consistent shell to navigate turanga,
So that I can move between Agents and Settings from anywhere.

**Acceptance Criteria:**

**Given** the authenticated app
**When** the shell renders
**Then** it shows a 248px left sidebar (nav: Agents, Settings; selected uses `--surface-selected`), a 48px topbar (workspace name, theme toggle, account menu), and a max-1240px content area — UX-DR2.

**Given** the shell
**When** the theme toggle is used
**Then** the theme persists for the user across reloads — UX-DR17.

**Given** the shell
**When** navigating
**Then** Agents and Settings routes resolve (placeholder content ok) with a visible focus ring on every interactive element — UX-DR15.

### Story 1.4: Single-user email + password authentication

As the builder,
I want to sign in with email and password,
So that only I can reach my agents.

**Acceptance Criteria:**

**Given** the login surface
**When** it renders
**Then** it shows a centered 400px login-card with email + password fields (persistent labels), the product name in Instrument Sans Medium, and a reserved-but-inactive SSO slot below a hairline — UX-DR3, FR-16.

**Given** valid credentials
**When** the builder signs in
**Then** a session is established and the app shell loads; passwords are stored hashed, never plaintext.

**Given** no valid session
**When** any non-Login surface is requested
**Then** access is refused and the user is sent to Login.

**Given** wrong credentials
**When** sign-in is attempted
**Then** an inline error states the cause without leaking which field was wrong.

## Epic 2: Connections

The builder can connect and centrally manage the model provider(s) and a Gmail data connection their agents will use.

### Story 2.1: Connect and manage a model provider

As the builder,
I want to connect a model provider,
So that my agents have a model to run on.

**Acceptance Criteria:**

**Given** Settings › Model providers
**When** the builder connects a provider with a credential
**Then** the credential is stored in LiteLLM (not in an agent), the provider card shows connected/error/unconfigured (dot + word), and the key is masked — FR-13, UX-DR10, AD-10.

**Given** an invalid credential
**When** verification runs
**Then** the card shows an error with the cause and the provider is not marked connected.

**Given** a connected provider
**When** models are listed
**Then** its models become available for later selection.

### Story 2.2: Connect a Gmail data connection via OAuth

As the builder,
I want to connect my Gmail via OAuth,
So that an agent can work with my mail without ever holding my credential.

**Acceptance Criteria:**

**Given** Settings › Data connections
**When** the builder connects Gmail
**Then** a scoped OAuth flow completes and the token is stored in the egress-guard (encrypted at rest), never exposed to an agent — FR-14, AD-5, AD-10, UX-DR21.

**Given** a connected Gmail
**When** the connection is viewed
**Then** it shows status (dot + word) and its declared destinations, and offers Revoke.

**Given** the generic Connection abstraction
**When** the Gmail connection is implemented
**Then** it is consumed only through the generic Connection interface (no email-specific logic leaks into platform code paths) — SM-4.

### Story 2.3: Central connections management + Settings shell

As the builder,
I want one place to see and manage my connections,
So that I can keep my providers and data sources in order.

**Acceptance Criteria:**

**Given** Settings
**When** it renders
**Then** it shows a sub-nav (Model providers, Data connections, Profile), selected item on `--surface-selected` — UX-DR12.

**Given** the connections views
**When** a connection is removed
**Then** it is removed cleanly (dependent-agent guard is added in Story 3.6 once agents can reference connections) — FR-15 (connections).

**Given** Profile
**When** viewed
**Then** the builder can update name, email, password, and theme — UX-DR12.

## Epic 3: Agent Definition

The builder can create and fully configure an agent in Draft, and manage all agents from one place.

### Story 3.1: Create an agent and see the agents list

As the builder,
I want to create an agent and see it listed,
So that I have something to configure and run.

**Acceptance Criteria:**

**Given** the Agents surface (empty)
**When** it renders
**Then** it shows "No agents yet." + *Create agent* and supports `/` to focus a filter — UX-DR4.

**Given** *Create agent*
**When** used
**Then** a new Agent is created in Draft (FR-1, FR-6), written by `control-api` only (AD-7), and appears in the list with its Lifecycle State as a dot + word (never colour-only) — FR-6, UX-DR11.

### Story 3.2: Agent-definition surface and model selection

As the builder,
I want the two-pane builder with model selection,
So that I can start configuring an agent.

**Acceptance Criteria:**

**Given** an agent
**When** its definition opens
**Then** the two-pane split renders (config left, test pane right; collapses to a Test toggle < 1024px) with collapsible config sections and autosave showing `Saving… → Saved` (no manual Save) — UX-DR5, UX-DR18.

**Given** the Model section
**When** selecting a model
**Then** models are grouped by provider; an unconfigured provider is disabled with `Connect in Settings`; the choice renders `provider / model-id` in mono — FR-2, UX-DR8.

### Story 3.3: Instructions editor with variables

As the builder,
I want to write instructions with variables,
So that my agent has reusable, parameterized guidance.

**Acceptance Criteria:**

**Given** the Instructions section
**When** editing
**Then** it is a mono editor; typing `{` opens a variable-insert popover and inserted `{vars}` render as signal-tinted variable-tokens — FR-1, UX-DR6.

**Given** an undefined `{var}` referenced in text
**When** detected
**Then** a caution hint surfaces linking to the Variables section (validation warning before Test).

### Story 3.4: Attach skills with scoped permissions and send-gate config

As the builder,
I want to attach skills and scope what each may do,
So that my agent has capabilities without over-permission.

**Acceptance Criteria:**

**Given** the Skills section
**When** attaching
**Then** the built-in skills (read/search, draft reply, flag/label, summarize) are attachable as rectangular chips via a searchable picker (not pills) — FR-17, UX-DR9, UX-DR22.

**Given** an attached skill
**When** its Permission Scope is set
**Then** the default is most-restrictive (deny) and must be widened explicitly — FR-3.

**Given** an outbound skill (send a drafted reply)
**When** configured
**Then** its send permission is a distinct grant, off by default — FR-18, UX-DR22.

### Story 3.5: Set per-run and per-day cost caps

As the builder,
I want to set spend ceilings on an agent,
So that it can never run away with my money.

**Acceptance Criteria:**

**Given** the Cost caps section
**When** the builder sets caps
**Then** both a per-run and a per-day cap are captured as money (integer minor units + currency) and persisted (config owned by `control-api`) — FR-11, UX-DR20, AD-6, AD-7.

**Given** a missing or invalid cap
**When** entered
**Then** validation blocks it with a stated reason.

### Story 3.6: Manage agents centrally and guard connection removal

As the builder,
I want to manage all agents and see connection dependents,
So that I don't break a running agent by removing a connection.

**Acceptance Criteria:**

**Given** the agents list
**When** viewed
**Then** it shows every agent with Lifecycle State (and a cost-meter placeholder for later Active agents) — FR-15.

**Given** a connection referenced by one or more agents (from Story 2.3)
**When** it is removed
**Then** the dependent agents are surfaced before the removal is confirmed — FR-15.

## Epic 4: Sandboxed Execution & the Guard

The builder can Test an agent and watch it run inside an isolated sandbox — reaching only allowlisted destinations, metered live, killed on breach — with every action and refusal observable.

### Story 4.1: Run an agent in an isolated sandbox (bare loop)

As the builder,
I want to run an agent inside a real sandbox,
So that execution is isolated from the first line of code.

**Acceptance Criteria:**

**Given** an agent with a model
**When** a Test run is launched
**Then** the run-orchestrator creates one ephemeral container per run with `--runtime=runsc` (gVisor) and `--network=none`, injects an immutable job spec (versioned contract, `control-api`-owned), and reaps it on completion — FR-7, AD-4, AD-9.

**Given** the sandbox cannot be established
**When** a run is launched
**Then** the run fails with a stated reason and never falls back to unsandboxed execution — NFR-1.

**Given** a running agent
**When** it makes a model call
**Then** the call exits only via the Guard → LiteLLM, and a transcript returns on the single control channel — AD-1, AD-9.

### Story 4.2: Test pane — streaming transcript and metrics

As the builder,
I want to watch a test run live,
So that I can judge the agent before trusting it.

**Acceptance Criteria:**

**Given** the agent-definition test pane
**When** a test is run (button or `Cmd/Ctrl+Enter`; `Esc` closes popovers; the running pulse is the only looping motion)
**Then** turns stream in; the in-flight turn shows the pulsing running dot; on completion it resolves to a succeeded/failed dot with mono metrics (latency ms, tokens, cost) — FR-4, UX-DR7, UX-DR11, UX-DR14.

**Given** the five UI states
**When** the pane is loading/empty/erroring/succeeding
**Then** each renders per the state patterns (skeletons, fact+action empty, cause→consequence→recovery error) — UX-DR13.

**Given** a transcript
**When** `Clear` is used
**Then** the session transcript resets.

### Story 4.3: Default-deny egress with the credentialed-connection gateway

As the builder,
I want the agent to reach only what I allow, without holding my credentials,
So that a hijacked agent can't exfiltrate or overreach.

**Acceptance Criteria:**

**Given** an agent with an attached Gmail connection
**When** it reads mail during a run
**Then** the Guard (mode a) terminates TLS, attaches the held credential, and forwards to Gmail — the agent never holds the token — FR-9, AD-5.

**Given** a destination not on the allowlist
**When** the agent attempts to reach it
**Then** the egress is refused and recorded with the attempted destination (allowlist = Connection-derived destinations + explicit additions, default-deny) — FR-8, UX-DR23, NFR-2, NFR-4.

**Given** an empty allowlist
**When** the agent runs
**Then** it can reach no external destination.

### Story 4.4: Skill execution and permission enforcement at runtime

As the builder,
I want skills to run only within their scope,
So that permissions are real, not decorative.

**Acceptance Criteria:**

**Given** attached, scoped skills
**When** the agent runs
**Then** read/search, flag/label, and summarize operate through the generic Connection interface — FR-17, SM-4.

**Given** a skill invoked outside its Permission Scope
**When** attempted
**Then** it is refused and the refusal is recorded on the Run — FR-3, NFR-4.

**Given** the draft-reply skill without a send grant
**When** the agent tries to send
**Then** sending is refused; the run produces a draft artifact and completes (no auto-send) — FR-18.

### Story 4.5: Live cost metering and kill-on-breach

As the builder,
I want spend metered and hard-stopped,
So that the caps I set are real.

**Acceptance Criteria:**

**Given** an agent with caps
**When** it runs
**Then** each model call carries a per-agent key (daily budget) and a per-run key (per-run cap); the live meter reflects run and daily spend — FR-12, AD-6.

**Given** either cap is reached
**When** the next model call is made
**Then** LiteLLM refuses it (429) and the orchestrator reaps the run within one model round-trip; spend cannot exceed the cap regardless of harness behavior — FR-12, NFR-3, AD-6.

**Given** a completed run
**When** its spend is displayed
**Then** the meter matches the summed run metrics (no drift).

### Story 4.6: Filter hook seam

As the builder,
I want an inspection seam in the Guard,
So that content scanning can be added later without rework.

**Acceptance Criteria:**

**Given** no registered filter
**When** traffic passes the Guard
**Then** the Filter Hook is a no-op and does not alter behavior — FR-10.

**Given** a trivial test filter that blocks a sentinel string
**When** a matching payload passes
**Then** it is demonstrably blocked — proving the seam works end to end.

## Epic 5: Activation & Operation

The builder can deliberately Activate an agent, operate it in production with caps and guard holding, and see live status + spend across all agents.

### Story 5.1: Activate and Deactivate with gating

As the builder,
I want to deliberately promote an agent to production,
So that going live is an intentional, safe act.

**Acceptance Criteria:**

**Given** an agent missing a model or either cap
**When** Activate is viewed
**Then** it is disabled with a stated reason — FR-5, UX-DR24.

**Given** a fully-configured Draft agent
**When** Activate is used
**Then** its state becomes Active and it is eligible for production runs under its Guard and caps — FR-5, FR-6, AD-8.

**Given** an Active agent
**When** Deactivate is used
**Then** it returns to Draft and is no longer eligible for production runs.

### Story 5.2: Operate active agents — live status and spend

As the builder,
I want to see all my agents' live status and spend,
So that I can trust what's running without babysitting it.

**Acceptance Criteria:**

**Given** Active agents
**When** the agents list is viewed
**Then** each shows live Lifecycle State (dot + word) and a live cost meter (daily spend vs per-day cap) in mono/tabular — FR-15, FR-12, UX-DR11.

**Given** an active run
**When** it executes
**Then** it runs under the same Sandbox, Guard, and caps as Test, with refusals and metrics recorded — NFR-1, NFR-2, NFR-4.

### Story 5.3: Run history and observability

As the builder,
I want to review what an agent did and what was blocked,
So that I can always answer "what happened."

**Acceptance Criteria:**

**Given** an agent with past runs
**When** its history is viewed
**Then** each Run shows its transcript, metrics, and any Guard/permission refusals — NFR-4.

**Given** a killed or failed run
**When** reviewed
**Then** the outcome and cause (cap breach, blocked egress, error) are legible.

---

## Epic 6: Tools — the agent↔tool contract + remote MCP

Agents gain **tools** — capabilities they invoke at runtime beyond talking to the model (query a DB, hit a company API, run a calculation). This epic defines the *contract* that every tool honors and proves it with the cheap endpoint type (remote MCP), so Epic 7 inherits the spine wholesale.

**The keystone (party-mode brainstorm, 2026-08-03):** the *contract between the agent and the tool* is the common denominator. Remote MCP and containerized MCP are just two **endpoint types** behind one brokered path — a `Tool` is `{ endpoint: remote | container }`; the agent talks to it identically either way.

### Architecture & scope decisions (binding constraints)
- **Contract = MCP over streamable HTTP, brokered by the Guard.** The harness issues a *logical* tool call; the Guard resolves the endpoint, attaches the held credential, forwards over its own TLS, records the call, returns. The agent never learns the URL or holds the key (AD-10). This reuses AD-5(a) — the credentialed-connection gateway — as the transport.
- **Endpoint type is an adapter.** Epic 6 ships `remote` (an external MCP server: URL + credential). Epic 7 adds `container`. Same brokered path; different resolver.
- **Guard, server-side half only, this epic.** The agent→tool direction. The tool→world direction (a tool that itself calls out) is Epic 7 — build the two halves separately, don't build the broker twice.
- **Permission model mirrors Skills (FR-3).** Attach a tool to an agent, then **grant per operation**; the Guard enforces the grant at runtime, exactly like skill scopes. Discovery: `list-tools` handshake at attach-time (through the Guard) so the builder sees what they're granting.
- **Observability, not metering.** Every tool call is **recorded on the Run** — count, latency, outcome, refusal (extends E4-AD-10's Guard→orchestrator event ledger). **No cost-cap, no kill-on-breach** for tool calls in v1; the ledger is the hook if enforcement is wanted later.
- **AD-7:** control-api is the sole writer of Tool state.

### Story 6.1: Model tools and a Tools management surface

As the builder,
I want turanga to treat a Tool as a first-class thing I manage in one place,
So that a tool's identity is stable and endpoint-type-agnostic before anything invokes it.

**Acceptance Criteria:**

**Given** the contracts package
**When** the agent↔tool contract is defined
**Then** a tool invocation is a **versioned control-plane message** (a logical invoke request + result) carrying **no endpoint URL and no credential** — AD-9, AD-10.

**Given** a Tool entity
**When** it is created, renamed, or removed
**Then** `control-api` is its **sole writer** (AD-7); it records an `endpoint` type (`remote` | `container`) so the type is an adapter, not a fork; IDs/timestamps follow project conventions (ULID, UTC).

**Given** the Tools page
**When** it is viewed
**Then** it lists every tool with its type + status (dot + word, never colour-only), with an empty state and an "Add a tool" action — FR-15-style management, NFR-6.

### Story 6.2: Connect a remote MCP tool

As the builder,
I want to connect an external MCP server by URL and credential and see what it offers,
So that I can grant its operations to agents without ever exposing the credential to an agent.

**Acceptance Criteria:**

**Given** the "Add a tool → Remote" flow
**When** I enter a URL + credential and connect
**Then** the credential is **held Guard-side** (never stored where an agent can reach it, AD-10); the connection is verified; failure shows a stated cause; the stored credential is masked — mirrors FR-13.

**Given** a connected remote tool
**When** the connection is established
**Then** turanga performs a **`list-tools` handshake through the Guard** and surfaces the operations the server offers (so the builder sees exactly what they can grant).

### Story 6.3: Attach tools to an agent with per-operation grants

As the builder,
I want to attach a tool to an agent and grant only specific operations,
So that an agent can use a tool with least privilege, enforced — not on trust.

**Acceptance Criteria:**

**Given** the agent-definition surface
**When** the **Tools** section (next to Skills) is used
**Then** I can attach a connected tool and **grant per operation**; the default is most-restrictive (deny), mirroring Skills/permission scopes — FR-3.

**Given** an agent with granted tool operations
**When** its definition is saved
**Then** the grants persist server-side (AD-7) and are the authoritative set the Guard will enforce at runtime (the agent-visible job spec carries the granted operation IDs, never the endpoint/credential — AD-10).

### Story 6.4: Invoke a tool at runtime through the Guard

As the builder,
I want a running agent to call its granted tools through the Guard,
So that every tool call goes through the one choke point — resolved, credentialed, and enforced — with no new hole in the sandbox.

**Acceptance Criteria:**

**Given** a sandboxed run whose agent has a granted remote tool
**When** the harness issues a **logical** tool call
**Then** the **Guard resolves the endpoint, attaches the held credential, forwards over its own TLS, and returns the result** — the sandbox's only outbound edge stays the Guard (AD-1, AD-5a); the agent never learns the URL or key (AD-10).

**Given** a tool call for an operation the agent was **not** granted
**When** it reaches the Guard
**Then** it is **refused and recorded** on the Run (a permission refusal, like an out-of-scope skill) — fail-closed, NFR-2/NFR-4.

**Given** the Guard→orchestrator event path (E4-AD-10)
**When** a tool call completes
**Then** it is merged into the Run as a recorded event (this epic builds only the **agent→tool** / server-side half of the broker; the tool→world half is Epic 7).

### Story 6.5: Tool invocation observability

As the builder,
I want to see how my tools are being used,
So that I can trust what's running and answer "what did it call, and what was blocked" — without cost surprises being the only signal.

**Acceptance Criteria:**

**Given** runs that invoked tools
**When** a tool's activity is viewed
**Then** each shows **invocation statistics** — count, latency, outcome, and any refusals — recorded per tool and on the Run (NFR-4).

**Given** tool calls
**When** they execute
**Then** they are **observed only** — recorded, **not metered against the cost cap and not killed on breach** (decision 2026-08-03; the E4-AD-10 ledger is the hook if enforcement is wanted later).

### Open questions (resolve at story time)
- Exact MCP version/profile to target; how `list-tools` + `call-tool` map onto the versioned control-plane contract.
- One egress-guard brokering tool calls for all runs vs. per-tool routing (leans: reuse the existing guard path).
- Whether a remote MCP's *own* downstream egress is ever our concern (it isn't — it runs on their infra; only container tools bring egress into scope, Epic 7).

---

## Epic 7: Self-deployed tool containers

The builder deploys their **own** tool containers into turanga; once a container satisfies a packaging contract, it registers as a tool and agents use it exactly like a remote one. This epic inherits Epic 6's agent↔tool contract wholesale and adds only the hard hosting parts.

**Trust posture (decision):** containers are **trusted** — operator-authored, shipped through a trusted SDLC. The v1 threat model is **least-privilege / blast-radius + contract conformance**, *not* hostile-code containment. But the isolation is designed so "untrust this tool" (run it under gVisor, screen its inputs) is a **later flag**, not a redesign.

### Architecture & scope decisions (binding constraints)
- **A tool container is topologically another sandbox-like node.** Single edge out to a guard, `--network=none` otherwise, its own allowlist built from its own attached connections, and **no ambient secrets** — the guard injects them (AD-10 generalizes: "no secret in the sandbox" → "no secret in any untrusted node"). It never holds its own API keys.
- **A tool can have its own connections; its egress is Guard-intercepted.** This is the Guard's **client-side** (tool→world) broker — the second half deferred from Epic 6. A tool that hits a company API/DB does so through the guard, against its manifest-declared allowlist.
- **Lifecycle = long-lived, shared, one instance per operator** (like litellm, not like a per-run sandbox). Per-run ephemeral / stateful tools are **deferred**. The one lifecycle wrinkle vs. a run: a long-lived tool's held credentials are **refreshed**, not minted-and-reaped.
- **The packaging contract** a container must satisfy: speaks **MCP over HTTP** on a declared port; exposes **`/health`**; ships a **manifest** declaring the tools it provides, the connections/egress it needs, resource caps, and a `stateful?` flag. Verification must report **pass/fail per clause, legibly** (Sally + Amelia: "which clause failed" is the hardest, most important part).
- **AD-7 / AD-1 / AD-5** all hold: control-api sole writer of tool/container state; the tool plane is isolated; the guard is the choke point in both directions.

### Provisional story sketch (NOT yet broken down — expect this to shift as Epic 6 teaches us)
- The **container packaging contract** + manifest schema; a reference/example tool image.
- **Deploy a tool** via UI (point at an image) → run **contract verification** (health + MCP handshake + manifest) → legible per-clause pass/fail.
- The **tool plane**: bring up a trusted tool container as a long-lived, network-isolated, guard-fronted node (orchestrator via the Docker API, reusing Epic 4's sandbox machinery).
- The Guard's **tool→world broker** (client-side): a tool's connections + Guard-mediated egress allowlist; no ambient secrets.
- **Lifecycle** management via UI: health, version, start/stop, long-lived credential refresh.
- (Deferred flags noted, not built: gVisor for tools; input screening; per-run/stateful tools; tool-call cost metering.)

### Open questions (resolve at story time)
- Image source/trust: registry pull vs. local build; how the operator points turanga at an image.
- One guard instance brokering all tools vs. a guard edge per tool container.
- Credential-refresh mechanics for long-lived held creds (OAuth refresh vs. static keys).
- Whether "which contract clause failed" verification can be made deterministic/e2e-testable without a real image (likely gated/manual, like provider connect).

---

## Epic 8: Agent memory — the self-improving loop

Agents **learn from their runs**. turanga already records every run (the transcript — turns, tool calls, refusals, outcomes) but nothing reads it back. This epic closes the loop: a control-plane **memory store**, a **recall** step that injects the most relevant memories into the run at start, and a post-run **reflection** step that distills the transcript into durable, scoped memories — so an agent that fails a task once can succeed the next time because it *remembered*. It ships the **Hermes-style loop** (do → reflect → remember → recall → improve) on turanga's existing isolation rails, with **mempalace's** structured-recall / temporal-graph / memory-as-a-tool ideas sequenced as additive later phases.

**The keystone:** turanga's isolation architecture already provides the memory plumbing. Memory is not a new plane — recall is a control-plane similarity query injected into the immutable job spec; reflection is a post-run control-plane step; **the sandbox never touches memory** (it can't reach a DB — AD-1). Epics 4 and 6 built the rails this reuses.

**Configurability is first-class (operator decision, 2026-08-03):** given the isolation/security stance, memory is a **privacy-sensitive, data-collecting** surface — so it is **off by default**, **configurable per individual agent** (enable/disable, recall-vs-reflect independently, per memory kind), and **governed by global defaults** an operator sets once. The effective toggle is resolved + **enforced control-plane** (AD-7); the harness never decides whether to remember.

### Architecture & scope decisions (binding constraints)
- **Control-plane-only, three seams around one store.** Store = a new **pgvector** table in Postgres, **single-writer** (a control-api `memory` module; the orchestrator calls it — AD-7). Recall = a similarity query run in the orchestrator **before the job spec is built** → a new sandbox-visible `JobSpec.memories` field (CONTRACT_VERSION bump) → folded into the model's system context by the harness. Reflect = a **post-run** step reading the completed transcript. The sandbox owns none of it (AD-1/AD-9).
- **Memory is secret-free spec content (AD-10).** Injected memories are text, like instructions/task input — never a credential or endpoint. Embedding compute uses the LiteLLM `/embeddings` path (control-plane or Guard-proxied); no embedding key enters the sandbox.
- **Off by default; three-level configurable.** Global defaults (an operator Settings surface) → per-agent override (`inherit | on | off`) → per-capability granularity (**recall** and **reflect** toggled independently; memory **kinds** — episodic/semantic/procedure — selectable). A global **kill switch** disables memory platform-wide; per-agent disable optionally **purges** that agent's memories.
- **Per-agent isolation by default (FR-7-adjacent).** An agent's memories are scoped to its `agentId`; no cross-agent recall. A "shared across a builder's agents" scope is an explicit, later opt-in — never the default.
- **Observed, not metered.** Recall is embedding-similarity only (zero LLM cost per query — the mempalace property that doesn't fight the cost cap). The one LLM call is the batched post-run reflection, **recorded but not metered against the run's cost cap and not killed on breach** (the Story 6.5 tool-observability precedent).
- **Auditable causality.** Every recall records *which* memories it injected into *which* run; every memory records its `sourceRunId`. The "it learned and it changed the next run" chain is inspectable — the acceptance bar.
- **AD-1 / AD-7 / AD-9 / AD-10 all hold.**

### Story 8.1: The memory model, store, and configuration spine

As the builder,
I want turanga to model memory + its per-agent and global configuration as first-class things before anything reads or writes them,
So that memory is a stable, governed, opt-in capability from the start.

**Acceptance Criteria:**

**Given** the domain + contracts
**When** memory is modeled
**Then** a `Memory` is a control-plane record (`kind`: episodic | semantic | procedure; verbatim content + summary; embedding; topic/scope; salience; `sourceRunId`; temporal validity; usage) keyed by `agentId`, and a `MemoryConfig` models the three-level toggle (global defaults → per-agent `inherit|on|off` → recall/reflect + per-kind granularity) — no secret ever in a memory (AD-10).

**Given** the store
**When** it is created
**Then** an `agent_memories` table (**pgvector**) lands with **control-api as its sole writer** (AD-7); pgvector is enabled in the Postgres image/init; IDs/timestamps follow project conventions.

**Given** the security stance
**When** memory ships
**Then** it is **off by default** — an agent has no memory behavior until explicitly enabled (globally or per-agent).

### Story 8.2: Global memory settings + per-agent memory controls

As the builder,
I want a global memory settings screen and a per-agent memory toggle,
So that I decide — per agent, and by default — whether an agent remembers, what it remembers, and whether it recalls, reflects, or both.

**Acceptance Criteria:**

**Given** Settings → Memory (a new surface alongside Model providers / Data connections / Tools)
**When** it is used
**Then** the operator sets the **global defaults**: the memory on/off default for new agents, the embedding model, the consolidation trigger + retention/decay policy, the privacy/scope default, and a global **kill switch** — control-api is the sole writer (AD-7); status is dot + word (NFR-6).

**Given** the agent-definition surface
**When** the **Memory** section (next to Tools) is used
**Then** the builder sets this agent's memory to `inherit` (the global default), `on`, or `off`; independently toggles **recall** and **reflect**; and selects which memory **kinds** apply — default-inherit, most-restrictive when unset (mirrors the Skills/Tools grant posture, FR-3).

**Given** the toggles
**When** a run executes
**Then** the effective config is resolved + **enforced control-plane** — the orchestrator skips recall/reflect the agent isn't configured for; the harness never decides (AD-7/AD-9). Disabling an agent's memory optionally purges its memories.

### Story 8.3: Recall — inject relevant memories into a run

As the builder,
I want a memory-enabled agent to start each run with what it has learned that's relevant to the task,
So that it doesn't repeat past mistakes or re-derive what it already knows.

**Acceptance Criteria:**

**Given** a memory-enabled agent with recall on
**When** a run is launched
**Then** the orchestrator (control-plane, **before** building the job spec) embeds the task input (LiteLLM `/embeddings`), runs a **scoped similarity query** over the agent's memories (filtered by temporal validity + salience), and injects the top-k as a **sandbox-visible `JobSpec.memories`** field (secret-free, immutable at run start — AD-9/AD-10; CONTRACT_VERSION bump).

**Given** the harness
**When** it assembles the model context
**Then** it folds the recalled memories into the system context (mirroring the tool-outcome fold), and the run **records which memories it recalled** (auditable causality).

**Given** recall
**When** it runs
**Then** it is **embedding-similarity only** — zero LLM cost per query, never on the run's cost cap.

### Story 8.4: Reflect — the post-run consolidation loop (the "it learns" story)

As the builder,
I want turanga to distill each run into durable memories,
So that the agent's next run is better than its last — the self-improving loop.

**Acceptance Criteria:**

**Given** a memory-enabled agent with reflect on
**When** a run completes
**Then** a **control-plane post-run step** reads the completed transcript and distills it (one LiteLLM call) into **semantic memories** (durable facts, preferences, lessons) and — when the run had ≥N tool calls — **learned procedures** (reusable workflows, Hermes-style); written via the sole memory writer; the harness never writes memory (AD-7/AD-9).

**Given** consolidation
**When** it writes
**Then** it **scores → promotes → forgets** (the mempalace-evolve equivalent): dedupes against existing memories, bumps salience on reuse, marks superseded facts via temporal validity, prunes low-salience — so memory improves rather than bloats.

**Given** reflection's LLM call
**When** it executes
**Then** it is **observed, not metered** — recorded per the run, not charged to the cost cap, not killed on breach (Story 6.5 precedent).

### Story 8.5: Memory observability + management

As the builder,
I want to see and curate what an agent has learned,
So that I can trust the loop — inspect what it knows, see which memory changed a run, and forget anything wrong.

**Acceptance Criteria:**

**Given** a memory-enabled agent
**When** its memory is viewed
**Then** the builder sees the agent's memories (kind, summary, salience, last used, source run) and, per run, **which memories it recalled** — the visible "learned → improved" causal chain (NFR-4).

**Given** a memory
**When** the builder acts on it
**Then** they can **pin** (protect from decay), **edit**, or **forget** it (control-api sole writer) — the curation surface; memories that can carry real user data are handled per the privacy/redaction default set in 8.2.

### Story 8.6: Learning visibility + human oversight

As the builder,
I want to see what an agent learned and be able to gate it before it takes effect,
So that a self-improving agent with real access can't silently drift — I stay in the loop.

**Acceptance Criteria:**

**Given** a run/conversation that produced new memories
**When** reflection completes
**Then** a legible **"here's what I learned"** surface shows the new memories in plain language, each with **pin / edit / forget**; and an **optional staged-approval mode** (per-agent / global config, default off = auto-apply) holds new memories **pending** until the builder accepts them — the strong human-in-the-loop form for an agent with real access.

**Given** an agent's memory over time
**When** it is viewed
**Then** a per-agent **learning changelog** shows what was learned / forgotten (low salience) / superseded (temporal validity), version by version — the "git-log for the agent's mind"; and where a run recalled a memory, it is **attributed inline** in the transcript (the auditable causality made visible; lands in Epic 9 chat too).

**Given** a memory suspected of hurting performance
**When** the builder — or an eval (Epic 10) — flags it
**Then** it can be **quarantined** (disabled non-destructively, not just forgotten) so a learning regression is rolled back and A/B-comparable — the seam Epic 10 evals gate on.

### Foundations this epic lays (for future epics)
Epic 8 is deliberately shaped so two later epics plug in without a rewrite:
- **Evals (Epic 10)** — recall is **parameterizable by memory state** (off / current / a named snapshot), memories are individually **quarantinable**, and every recall records its causal link to a run. An eval can therefore run a suite against a chosen memory state and gate learning on the score delta (the memory-oversight loop).
- **Agent data & artifacts (Epic 11)** — the **agent-scoped, control-plane, single-writer, isolated store** pattern (`agent_memories`) is written to **generalize** (memory is the first store; a structured data store is the next), and the **memory-as-a-Guard-tool** later phase is designed as a general **"first-party store exposed as a Guard tool"** seam (runtime CRUD), of which memory is the first instance. The embedding/recall infra is reusable for reference-knowledge RAG.

### Provisional later-phase sketch (NOT broken down — the mempalace distinctives, additive)
- **Structured/scoped recall** — topic/room scoping + verbatim-plus-summary duality (recall quality beyond flat top-k).
- **Temporal knowledge graph** — entity→relationship edges with validity windows: *the differentiator* — an agent with real access must never act on a stale fact (a changed endpoint, a rotated format).
- **Memory-as-a-Guard-tool** — expose the store through Epic 6's tool broker so an agent can `recall()`/`remember()` **mid-run** (mempalace's self-managed model), reusing the shipped, code-reviewed tool path.
- (Deferred flags noted, not built: shared-per-builder memory scope; a local/bundled embedding model; automatic PII redaction; memory-as-a-tool self-management.)

### Open questions (resolve at story time)
- **Naming clash:** turanga already has **"Skills"** (Gmail read/send scopes) — the Hermes "skill" (a distilled procedure) is a *different* thing. Name ours **learned procedures / playbooks**.
- Embedding model: LiteLLM-hosted (`text-embedding-3-small`) vs a bundled local model (mempalace's zero-cost path).
- Consolidation trigger: every run vs a threshold; synchronous post-run vs a background sweep.
- Salience/decay policy; how aggressively to forget; a per-agent memory budget/cap.
- Memory privacy: memories can carry real user data (email contents) — redaction rules; and per-agent isolation vs the later shared-per-builder scope.
- e2e/testability: a `fakeEmbedder` + `fakeReflector` (mirroring `fakeMcpVerifier`) so recall/reflect are deterministically testable without a live model.
- Config precedence + retroactivity: does turning memory **off** stop recall only, or also purge? Does changing a global default apply to `inherit` agents immediately?

---

## Epic 9: Chat — a multi-turn conversation with a published agent

The builder **converses** with an agent instead of firing one-shot test tasks (the test console). Chat turns the interaction model from single-shot into a thread — while keeping every turn inside the same isolation guarantees.

**The keystone: chat = threaded runs.** A run today is single-shot: an immutable `JobSpec` (AD-9) → a `--network=none`, cost-capped, Guard-fronted sandbox → a transcript → done. Chat makes each user message a **fresh run** whose `JobSpec` carries the conversation history so far; the agent's reply streams back and appends to the thread. A **Conversation** is a control-plane entity (an ordered thread of turns); every turn stays immutable, sandboxed, cost-capped, and observable. This reuses the run/harness/Guard/observability machinery wholesale and preserves AD-1/AD-9 — no long-lived stateful sandbox, no bidirectional side-channel into a running sandbox. **Chat is short-term *thread* memory; Epic 8 is long-term cross-conversation memory — they compose** (same seam: inject context into the immutable spec at run start).

**Decisions (operator, 2026-08-05):** (1) **Builder-first** — single-tenant, the builder chatting with their own agents (a productized, multi-turn evolution of the test console); a deployable/shared end-user surface is an additive later phase, not a rewrite. (2) **Against the published version** — a conversation runs the agent's **published snapshot**, not the working draft (the draft editor + test console stay the iteration loop; Chat is where you *use* the stable thing). This ties into the draft/publish model — an unpublished agent can't be chatted with until it's published. (3) **Threaded runs** — confirmed over a long-lived interactive session; the one accepted limitation is no mid-turn human-in-the-loop (a turn completes, then the user replies).

### Architecture & scope decisions (binding constraints)
- **A turn is a normal run, parameterized by a DEFINITION.** Today the orchestrator resolves the agent's *draft* row (`agents`) to build a run. Chat generalizes this: a run is built from a **definition** — the test console runs the draft; a chat turn runs the **published snapshot** (`agent_versions`). The run's model/instructions/skills/attachedTools/costCap all come from the snapshot, so a chat turn behaves exactly as the published definition specifies.
- **The conversation pins its published version.** A conversation records the published version it started against; republishing the agent does NOT retroactively change an in-flight conversation (the immutable-snapshot model makes this clean). The UI surfaces "the agent was updated — start a new chat to use v_N."
- **History injected into the immutable spec (AD-9/AD-10).** A new sandbox-visible `JobSpec.history` field carries the prior turns (role + content) — secret-free content, like instructions/task input; the harness folds it into the model context ahead of the current message. CONTRACT_VERSION bump. No mid-run side-channel; the whole thread-so-far is baked in at turn start.
- **Every turn is isolated + capped + guarded.** Each turn is a fresh `--network=none` sandbox (AD-1), one control channel out, Guard-fronted model/tool/connection access, and the published version's **cost caps** apply per turn (kill-on-breach unchanged). A conversation-level budget is a later refinement.
- **control-api is the sole writer (AD-7).** New `conversations` state + the run↔conversation link are control-plane; the run-orchestrator owns run/turn writes, control-api owns conversation metadata.
- **Reuses the run SSE for streaming.** A turn's reply streams over the existing run event stream (the test console's mechanism); the chat surface renders turns with the existing `RunTranscript`.
- **Deployable-later is designed for, not built.** The Conversation model is shaped so a future shared/end-user surface (identity, access control, per-conversation isolation, abuse/rate limits, embed) is additive.

### Story 9.1: The conversation model + published-version binding (spine)

As the builder,
I want turanga to model a chat conversation as a first-class thread bound to a published agent version,
So that chatting is a stable, governed capability before any turn runs.

**Acceptance Criteria:**

**Given** the domain + contracts
**When** chat is modeled
**Then** a `Conversation` is a control-plane thread `{ id, agentId, publishedVersion (pinned), title, createdAt }`; a run gains a `conversationId` + `turnIndex` link; and `JobSpec` gains a sandbox-visible `history` field (prior turns, secret-free — AD-10) — CONTRACT_VERSION bump. control-api is the sole writer (AD-7).

**Given** an agent that has never been published
**When** a chat is attempted
**Then** it is refused with a stated cause ("Publish this agent to chat with it") — chat runs a published snapshot, never the draft.

**Given** the store
**When** it is created
**Then** a `conversations` table lands (control-plane), IDs/timestamps per convention; the run table carries the conversation link.

### Story 9.2: Run a chat turn against the published version, with history

As the builder,
I want each message I send to run the agent's published definition with the conversation so far,
So that the agent replies in context, safely, exactly as published.

**Acceptance Criteria:**

**Given** a conversation pinned to published version v_N
**When** the builder sends a message
**Then** the orchestrator builds a run from the **published snapshot** (`agent_versions` v_N) — model/instructions/skills/attachedTools/costCap from the snapshot, NOT the draft — injects the prior turns into `JobSpec.history`, and runs it as a fresh `--network=none`, cost-capped, Guard-fronted sandbox (AD-1/AD-9); the harness folds the history into the model context ahead of the new message.

**Given** the turn runs
**When** the agent replies
**Then** the reply streams over the run event stream and is appended to the conversation as the next turn (the run is linked by `conversationId`/`turnIndex`); the published version's caps apply per turn (kill-on-breach unchanged), observed like any run.

**Given** the agent is republished mid-conversation
**When** the next turn runs
**Then** it still uses the conversation's **pinned** version (in-flight behavior doesn't change); the UI offers starting a new chat for the newer version.

### Story 9.3: The chat surface (web) + enable the nav

As the builder,
I want a chat page where I pick a published agent and hold a conversation,
So that I can actually use my agents conversationally.

**Acceptance Criteria:**

**Given** the `/chat` route (the nav's disabled Chat item is enabled)
**When** it is opened
**Then** the builder picks a **published** agent, starts or continues a conversation, sends a message, and sees the reply **stream** in (reusing `RunTranscript` + the run SSE); multiple conversations per agent are listed. An agent with no published version shows the "publish first" empty state.

**Given** a conversation
**When** it is viewed
**Then** the thread shows the interleaved user/agent turns, the pinned version, and per-turn cost/observability — voice + a11y per the cross-cutting conventions (UX-DR15/16, NFR-6).

### Story 9.4: Conversation management + guardrails

As the builder,
I want to manage my conversations and trust their limits,
So that chat is organized and safe to leave running.

**Acceptance Criteria:**

**Given** a list of conversations
**When** the builder manages them
**Then** they can rename, delete, and start a new conversation (control-api sole writer, AD-7); a conversation surfaces its agent + pinned version + last activity.

**Given** a long conversation
**When** a turn runs
**Then** the injected `history` is bounded (a windowing/summarization policy — the seam that later composes with Epic 8 memory), so a turn's context (and cost) can't grow unbounded; the per-turn cost cap remains authoritative.

### Provisional later-phase sketch (NOT broken down — additive)
- **Deployable / shared end-user chat** — a surface where others chat with a published agent (share/embed): identity, access control, per-conversation isolation, abuse + rate limiting, a per-conversation/per-viewer budget. The single biggest additive phase.
- **Mid-turn human-in-the-loop** — an agent that pauses to ask a clarifying question and resumes with the answer (needs a suspend/resume run model — a real departure from immutable single-shot).
- **Token-level streaming** — stream model deltas, not just per-turn (a harness + control-channel change).
- **Chat against the draft** — a dev-loop variant that converses with the working draft (blurs into the test console; deliberately not the default).
- **Conversation-level cost budgets** — a cap across a whole thread, above the per-turn cap.

### Open questions (resolve at story time)
- Version pin: latest-at-conversation-start (chosen) vs a per-conversation selectable version vs always-latest-published.
- History windowing: raw last-K turns vs summarize-old-turns (the Epic 8 memory tie-in) vs a token budget.
- Conversation titles: auto-derived from the first message vs user-named.
- The run path refactor: how cleanly can "run this definition" be parameterized so the test console (draft) and chat (published snapshot) share one orchestrator path without a fork.
- Relationship to the test console: coexist (test = draft iteration, chat = published use) vs eventually fold the test console into chat-against-draft.
- e2e/testability: a threaded-run test (turn N sees turns 1..N-1 in its `JobSpec.history`) without a live model.

---

## Epic 12: Model-driven tool loop — the agent actually decides

The **Epic 6 follow-on that makes tools real.** Epic 6 built the tool *contract*, the Guard *broker*, per-operation *grants*, and *observability* — everything except the one thing that makes an agent an agent: the model deciding, mid-run, which tool to call and acting on the result. Today `apps/agent-harness/src/main.ts` (Phase-1b, Story 6.4) never puts the tools in front of the model — `buildMessages` folds only instructions + memories + history + the task, and `GuardModelRequest` carries no `tools`. The harness blindly fires each attached tool's *first* granted operation once, with empty arguments, folds a bare "Called X." note into context, and does a single text-only model call. So a capable model (e.g. `gpt-oss-20b` — tool-trained, 131K window) reports it "cannot access" its tools and invents a fake toolkit, even as the real call returns `ok`. This epic replaces the stub with a real loop.

**The keystone (party-mode brainstorm → seam spike, 2026-08-05):** *adopt the loop engine, keep the boundary.* We don't hand-roll the agentic loop and we don't let a framework own the network. The **Vercel AI SDK owns cognition**; **turanga owns transport + enforcement.** The seam is two injection points, both proven in the Phase-0 spike (branch `spike/agent-tool-loop`, offline + deterministic, harness 14/14 + guard 31/31 green): a **custom `fetch` → `guardModelCall`** (the SDK's model calls leave only via the Guard socket, holding no key) and a **custom tool executor → `guardToolCall`** (the SDK decides *which* tool; the Guard enforces *whether* and injects the credential). LiteLLM, already in the stack, normalizes function-calling across every provider — a capability we have today and were discarding by stripping the request to `{ messages }`.

### Architecture & scope decisions (binding constraints)
- **The SDK owns cognition; turanga owns transport + enforcement.** The AI SDK runs *inside* the sandbox and owns the loop, step-counting, tool-call parsing, result fold-back, and repair. It holds **no credential** and touches **no network** — its only egress is the per-run Guard socket, and `--network=none` (AD-1) fails closed anything that tries otherwise. The Guard remains the sole holder of the LiteLLM key and every tool's endpoint + credential (AD-10).
- **Two injection points, nothing else crosses the boundary.** (a) a custom `fetch` that translates the SDK's OpenAI-shaped model request into a typed `GuardModelRequest` over the UDS and back; (b) a custom tool executor that maps each granted operation to `guardToolCall`. No third channel; the JobSpec stays immutable at run start (AD-9) — the loop *consumes* the spec, it never mutates policy or reaches a side-channel.
- **Two independent backstops bound the loop.** The **per-run cost cap** (Story 4.5, Guard-side, kill-on-breach) is the **financial** backstop — a multi-call turn is simply *N* metered model round-trips under one run's cap, needing no new budget machinery. A **max-step ceiling** (harness-side, default ~10, configurable) is the **control** backstop — a model that loops on the same call dies on logic before it burns the budget. Both stops, and a natural final answer, are **recorded distinctly** — never a silent truncation.
- **Tool calls stay observed-not-metered** (Story 6.5 posture, unchanged): each brokered call is recorded on the Run (count/latency/outcome/refusal), carries no cost, and never touches the breach/kill path. Only model round-trips are metered.
- **The Skills path (Story 4.4) is untouched.** The deterministic, policy-gated Gmail skills pipeline (read→draft→send with the Guard send-gate) runs alongside the loop as a separate path. Only the blind `operations[0]` **stub** dies.
- **Capability is a signal, not a gate.** A model's tool-calling reliability is surfaced at attach-time (a warning + a verified-models list we actually run the loop against); no model config is *forbidden*. `gpt-oss-20b` is tool-trained and stays usable — the signal communicates reliability, not permission.
- **AD-7:** control-api / the orchestrator remain the sole writers of run state; the harness decides nothing about policy.

### Story 12.1: The tool-calling contract and version bump

As a platform maintainer,
I want the harness↔Guard contract to carry tools and tool calls,
So that the model can be told what it may call and can express a call, with no secret ever crossing the sandbox boundary.

**Acceptance Criteria:**

**Given** the contracts package
**When** the model-call contract is extended for tool use
**Then** `GuardModelRequest` gains an optional `tools` (OpenAI function-calling shape: name + description + JSON-schema parameters) and `toolChoice`; the message schema gains the `tool` role and `tool_calls`/`tool_call_id`; `GuardModelResponse` gains `toolCalls` + `finishReason` — and every field is **secret-free** (a logical tool name + argument schema, never an endpoint or credential — AD-10).

**Given** `JobTool`
**When** a tool's granted operations are described to the model
**Then** `operations` carries each op's **argument schema** (`{ name, description, inputSchema }`), not a bare string, so the model can call an operation with structured arguments — still no endpoint/credential in the spec (AD-10).

**Given** a breaking shape change to the agent↔harness↔Guard contract
**When** the contract is published
**Then** `CONTRACT_VERSION` is **bumped** and every producer/consumer (contracts, orchestrator, Guard, harness) is updated in lockstep; a plain (draft/skill) model call that omits `tools` remains valid and behaves exactly as before (backward-compatible default).

### Story 12.2: Resolve granted operations into the job spec

As the builder,
I want each of my agent's granted tool operations described to the model with its real argument schema,
So that the model calls tools correctly and sees only what I granted — nothing more.

**Acceptance Criteria:**

**Given** an agent with attached tools and per-operation grants
**When** the orchestrator assembles a run (`resolveRunTools`)
**Then** it resolves each **granted** operation's real input JSON schema from the tool registration (the `list-tools` handshake data, Story 6.2) into `JobSpec.tools` — replacing the spike's placeholder open-object schema.

**Given** a tool with many operations of which only some are granted
**When** the spec is built
**Then** **only granted operations** are manifested (least-privilege *and* a bounded context/token footprint — the ~90-op tool contributes only its 12 granted ops), and the manifest carries no endpoint or credential (AD-10).

**Given** the immutable job spec (AD-9)
**When** it is injected at run start
**Then** the resolved tool manifest is fixed for the run — the harness never augments or re-resolves it mid-loop.

### Story 12.3: The Guard forwards tools and meters the multi-call loop

As a platform maintainer,
I want the Guard to offer the model its tools and stay the cost authority across every round-trip,
So that a multi-step loop is bounded and killed on breach exactly like a single call.

**Acceptance Criteria:**

**Given** a model call that carries `tools`
**When** the Guard proxies it to LiteLLM
**Then** it forwards `tools`/`tool_choice` and returns the model's `tool_calls` + `finishReason` to the harness; a call **without** `tools` is forwarded byte-identically to before (the non-tool path is unchanged).

**Given** a loop of *N* model round-trips within one run
**When** each round-trip executes
**Then** **every** call is metered on the run's per-run cost key and reported to the orchestrator out-of-band (E4-AD-10) — the loop is *N* metered calls under one per-run cap, with no new budget machinery.

**Given** the per-run or per-day budget is exceeded mid-loop
**When** LiteLLM 400s the call
**Then** kill-on-breach fires (Story 4.5): the run is reaped, the loop ends cleanly with the **last text that stood**, and the outcome is recorded as a cost-cap kill — not a crash (NFR-2).

### Story 12.4: The model-driven loop replaces the stub

As the builder,
I want my agent to reason, call a tool, see the result, and continue until it answers,
So that it actually *uses* the tools I granted instead of denying them.

**Acceptance Criteria:**

**Given** a sandboxed run whose agent has granted tools
**When** the harness runs the turn
**Then** the **Vercel AI SDK loop** (`runToolLoop`) replaces the Phase-1b stub: the model is given the tool manifest, chooses calls, each is brokered via `guardToolCall` (the Guard enforcing the grant + injecting the credential — AD-10), the **real result** (not a "Called X." note) folds back into context, and it iterates to a final answer.

**Given** the loop
**When** it runs
**Then** it is bounded by `stopWhen: stepCountIs(N)` (configurable, default ~10) — the control backstop — and every model call leaves the sandbox **only** via the Guard socket, holding no credential and reaching no network (AD-1, AD-10).

**Given** an agent with attached **skills** (Story 4.4)
**When** its run executes
**Then** the deterministic skill pipeline (read→draft→send, Guard send-gate) runs **unchanged** alongside the loop; only the blind `operations[0]` stub is removed — no skill behavior regresses.

**Given** a run with **no** granted tools
**When** the turn runs
**Then** it produces a normal text answer (the loop degenerates to a single model call) — no regression to the existing draft/test-console or chat text path.

### Story 12.5: Tool-call repair — weak models self-correct

As the builder running a smaller local model,
I want a malformed or failed tool call to be corrected rather than fatal,
So that a capable-but-streaky model reliably completes a multi-step task.

**Acceptance Criteria:**

**Given** the model emits a malformed tool call (bad JSON arguments, unknown operation) or a call returns a tool error
**When** the loop processes it
**Then** the **error is fed back** into the model context (the SDK's repair path) and the model may retry within the step budget — a single flubbed call is not a run failure.

**Given** repair attempts
**When** they occur
**Then** they are **visible in the transcript** (each attempt recorded as a `tool` event with its outcome), so a human can see the model recovered rather than the recovery being invisible.

**Given** a call that cannot be repaired within the step ceiling
**When** the ceiling is reached
**Then** the run ends cleanly with the last text that stood and a recorded **step-limit** stop — never a crash and never a silent stop (NFR-2).

### Story 12.6: Multi-step observability — every step and every stop on the record

As the builder,
I want to see the agent's whole reasoning trail and exactly why it stopped,
So that I can trust a multi-step run — "what did it call, what came back, and why did it end."

**Acceptance Criteria:**

**Given** a multi-step loop
**When** each step executes
**Then** it emits its `tool` transcript event (count/latency/outcome/refusal — Story 6.5 reused), preserving **order** across the loop so the reason→act→observe trail is legible.

**Given** a completed turn
**When** its stop reason is recorded
**Then** it is one of **final answer / step-limit / cost-cap-kill**, each distinct and explicit — a truncation is **never** presented as a clean finish (the Story 6.5 lesson).

**Given** the web completed-turn view
**When** a builder inspects a turn that used tools
**Then** the steps render **legibly** (recorded *and* readable, not buried) — status stated with a word, mono numerals for latency, per project UI conventions (NFR-6, UX-DR15/16).

### Story 12.7: Model capability signal (not a gate)

As the builder,
I want turanga to tell me how reliable a model is at tool use when I attach it,
So that I can choose with eyes open — without being blocked from a config I want to run.

**Acceptance Criteria:**

**Given** a **verified-models list** — models we actually run the tool loop against
**When** it is maintained
**Then** it records which models emit well-formed tool calls reliably (evidence-based, not vibes), and is the source for the signal below.

**Given** the agent-definition surface where a model is selected and tools are attached
**When** the chosen model has limited or unverified tool-calling reliability
**Then** a **non-blocking signal** is shown ("limited tool-calling reliability; verified models: …") — stated plainly, never celebratory, and it **does not prevent** attaching or running (a signal, not a gate). `gpt-oss-20b` is tool-trained and stays fully usable.

**Given** the signal
**When** it renders
**Then** it follows project UI conventions — status stated with a word (never colour-only), verb-first actions, sentence case, mono model IDs (UX-DR15/16, NFR-6).

### Acceptance demo (the Stage-2 product proof)
Point the finished loop at **Mortimer's unchanged config** (`gpt-oss-20b` + the BitsBy8 tool, 12 granted ops incl. `list_drives`) on the dev stack and ask for a real multi-step task. The model **selects** tools, the Guard **brokers** each call, the **result** folds back, a flubbed call is **repaired**, the run **completes**, and the transcript shows **every step and its stop reason**. Invariants verified live: no credential in the sandbox, `--network=none` holds, the per-run cost cap bounds the loop, and kill-on-breach fires mid-loop with the last text standing. "We didn't move your goalposts — we fixed our bug."

### Explicitly deferred (out of this epic)
- **Parallel / concurrent tool calls** — v1 is serial, one call per step (simpler to bound and reason about).
- **Live streaming of intermediate steps** over the chat SSE — the loop records every step for post-turn inspection; token/step-level live streaming is a later harness + control-channel change.
- **Mid-loop human-in-the-loop** — the agent pausing to ask and resuming (needs a suspend/resume run model; shared with the Epic 9 deferral).
- **Sub-agents** — an agent spawning agents.
- **Automatic tool-result summarization/truncation** — a large tool result folds back raw in v1; smart compaction is a later refinement.
- **A hard capability gate** — blocking weak models outright (we ship a signal instead).

### Open questions (resolve at story time)
- AI SDK version/adapter specifics: `createOpenAICompatible` + custom `fetch` (spike path) vs a bespoke `LanguageModelV2` provider — the spike chose the former; confirm at Story 12.4.
- Guard model endpoint: keep the typed `GuardModelRequest` + translate OpenAI↔Guard in the shim (spike/chosen) vs an OpenAI-passthrough branch — chosen keeps the typed boundary.
- Abort/kill propagation into the SDK loop (`abortSignal`) vs the Guard staying the sole kill authority (leans: Guard stays authoritative; the shim surfaces a kill as a non-ok model response that ends the loop).
- Default step ceiling `N` and whether it is per-agent configurable or a global default.
- AI SDK dependency/bundle audit for the sandbox image (tolerable **because** the box has no network and no secret — the isolation is what lets us accept a fat dependency here).
- Where the verified-models list lives (control-plane config vs a checked-in reference) and how the signal is computed.
