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
