---
title: turanga
status: final
created: 2026-07-31
updated: 2026-07-31
---

# PRD: turanga
*Working title — confirm.*

## 0. Document Purpose

This PRD is for the builder-operator (initially a single person) and the downstream BMAD workflows — architecture (`bmad-architecture`) and epics/stories (`bmad-create-epics-and-stories`) — that consume it. It defines *what the MVP must do*, not how to build it; implementation choices (container runtime, egress-guard mechanism, cost-meter placement) are deliberately deferred to architecture and captured in `addendum.md`. It builds on, and does not duplicate, three existing artifacts: the finalized **product brief** (`../../briefs/brief-turanga-2026-07-31/brief.md`), the **competitive research** (same folder, `research/`), and the **UX spines** (`../../ux-designs/ux-turanga-2026-07-30/` — `DESIGN.md` + `EXPERIENCE.md`, which own visual identity and interaction behavior). Vocabulary is Glossary-anchored; features are grouped with globally-numbered FRs; inferred decisions are tagged `[ASSUMPTION]` inline and indexed in §9.

## 1. Vision

turanga is a generic platform for building, securing, and operating your own ecosystem of agents. Every agent runs inside a sandbox you control — a container with a guarded data ingress/egress boundary — under a hard cost ceiling, and is moved deliberately from **draft** to **test** to **Activate**. The platform never knows or cares what any given agent does; use cases like email triage, portfolio watching, or home automation are built *on* turanga, never baked into it.

The wedge is trust, not capability: *agents you can trust with real access.* Where the category (Dify, Openclaw, Hermes) optimizes for how much an agent can do, turanga optimizes for the opposite fear — how much it can do *to you*. Agents are guilty until sandboxed.

The MVP proves exactly one thing end to end: that the builder can take a generic agent from draft to real work against real data, inside isolation they trust, under a cost cap it cannot breach — and would actually click **Activate** against their own inbox. If that click feels safe, turanga works.

## 2. Target User

### 2.1 Jobs To Be Done

- **As the builder:** define an agent (its model, instructions, skills, and permissions) and get it working against my real data without writing platform plumbing each time.
- **As the operator (same person, different hat):** run that agent knowing it *cannot* exceed a spend ceiling, *cannot* reach data or destinations I didn't allow, and *cannot* act in production until I deliberately promote it.
- **Emotional core:** stop choosing between usefulness and safety. Give an agent real reach into my life and still sleep.
- **As the platform builder:** add the *second* agent (portfolio, home) as a fork of the same machinery, not a rewrite — because nothing in the platform is use-case-specific.

### 2.2 Non-Users (v1)

- Teams / multiple users. v1 is single-user, single-machine; roles and multi-tenant isolation are a different security model, explicitly deferred.
- People wanting a no-code, use-case-packaged product ("an email assistant"). turanga is the platform you build such a thing *in*.

### 2.3 Key User Journeys

*Single operator role; journeys mirror the UX spine (`EXPERIENCE.md`, protagonist "Ravi") in downscaled form. FRs reference these by ID.*

- **UJ-1. Ravi takes an agent from draft to a trusted first run.** Ravi, the builder-operator, signs in, creates an agent in **draft**, picks a model, writes instructions, and attaches a skill with a scoped permission. He connects a model provider and a data connection. He hits **Test**: the agent runs *sandboxed* against real data in a test context, and he watches a transcript with live cost/latency metrics. Satisfied, he sets a daily cost cap and clicks **Activate**. **Climax:** the first saturated color he sees is the *succeeded* status — and he did it willing to point the agent at his real inbox. **Resolution:** the agent sits in the agents list with a live status and a ticking, capped meter.

- **UJ-2. A run tries to overreach and turanga stops it.** Ravi's agent, during a run, attempts to send data to a destination not on its allowlist (or would exceed its budget). **Climax:** turanga blocks the egress (or kills the run on breach) and states the cause plainly. **Resolution:** Ravi sees exactly what was attempted and why it was refused; he adjusts the allowlist or the cap and re-runs. The guard did its job: it stopped, said why, and handed him the recovery.

## 3. Glossary

- **Agent** — A configured unit turanga can run: a model + instructions + attached Skills + scoped Permissions. Has exactly one Lifecycle State at a time. Runs produce Runs.
- **Skill** — A capability attachable to an Agent (a tool/function the agent may invoke). Governed by a Permission Scope. Skill authoring/marketplace is out of scope; MVP ships a small built-in set (read/search, draft reply, flag/label, summarize — FR-17).
- **Connection** — A configured, credentialed link to an external system: either a **Model Provider Connection** (a source of models) or a **Data Connection** (a source/sink of the user's data, e.g. an inbox). The first Data Connection implementation is **Gmail via scoped OAuth** (FR-14).
- **Model Provider** — The source of an LLM behind a Model Provider Connection; holds an API key.
- **Sandbox** — The isolated execution environment (one per Agent Run) in which an Agent executes. Provides containment and hosts the Guard.
- **Guard (Ingress/Egress Guard)** — The control layer around a Run that governs what data enters the Sandbox and what may leave it. MVP enforces an **Allowlist**; it exposes a **Filter Hook** for future content inspection.
- **Allowlist** — The set of destinations/sources a Run is permitted to reach. Default-deny: anything not on it is refused.
- **Filter Hook** — A defined extension point in the Guard where inspection logic (e.g. secret/PII scanning) can be added later without changing agents. No inspector ships in MVP.
- **Permission Scope** — The declared bounds on what an Agent may do with a given Skill or Connection.
- **Cost Cap (Budget)** — Hard spend ceilings for an Agent: a **per-run** cap (any single Run) *and* a **per-day** cap (cumulative spend, resets daily) — FR-11. Enforced with a live meter and Kill-on-breach.
- **Test (read-only)** — A Test Run executes against the Agent's live Data Connection data in read-only mode: real data in, no writes or sends out (FR-4).
- **Kill-on-breach** — Termination of an in-progress Run when its Agent's Cost Cap is reached.
- **Lifecycle State** — One of **Draft** (editable scratchpad, not live), **Test** (executed in a test context on demand), or **Active** (promoted to production; runs under its Cost Cap and Guard). *Activate* is the promotion action; *draft→test→Activate* is the lifecycle.
- **Run** — A single execution of an Agent (test or active), producing a transcript and metrics (latency, tokens, cost).

## 4. Features

### 4.1 Agent Definition

**Description:** The builder defines an Agent by selecting a model, writing instructions, attaching Skills, and setting Permission Scopes — the anatomy specified in the UX `DESIGN.md`/`EXPERIENCE.md` agent-definition surface. Definition is generic: nothing here is use-case-specific. Realizes UJ-1. Uses Glossary terms exactly.

**Functional Requirements:**

#### FR-1: Create and edit an agent definition
The builder can create an Agent and edit its model, instructions, attached Skills, and Permission Scopes.
**Consequences (testable):**
- A new Agent is created in **Draft** state (see FR-6).
- Instructions support inline `{variable}` references; an undefined variable reference is surfaced as a validation warning before Test.
- Edits to a Draft persist automatically without a manual save action `[ASSUMPTION: autosave — carried from UX spine]`.

#### FR-2: Select a model for an agent
The builder can choose the model an Agent uses from models exposed by a connected Model Provider (FR-13).
**Consequences (testable):**
- Only models from a **connected** Model Provider are selectable; models from unconfigured providers are shown disabled with a link to connect.
- The selected model is displayed as `provider / model-id`.

#### FR-3: Attach skills with scoped permissions
The builder can attach one or more Skills to an Agent and set a Permission Scope for each.
**Consequences (testable):**
- An attached Skill with no explicit Permission Scope defaults to the most restrictive scope (deny), not open.
- At Run time, an Agent invoking a Skill outside its Permission Scope is refused and the refusal is recorded on the Run.

#### FR-17: Ship the MVP built-in skill set
turanga provides a small built-in set of generic Skills sufficient to make the dogfood email Agent useful: **read/search data**, **draft a reply**, **flag/label**, and **summarize/digest**. These are generic capabilities exposed to the Agent through the Skill interface — not email-specific platform code (they operate on whatever Data Connection is attached).
**Consequences (testable):**
- Each built-in Skill is attachable to an Agent (FR-3) and governed by a Permission Scope.
- The read/search, flag/label, and summarize Skills operate through the generic Connection interface (SM-4).

#### FR-18: Outbound actions are permission-gated and never automatic
Any Skill that produces an outbound effect (e.g. sending a drafted reply) requires an explicit Permission Scope grant and does not send automatically.
**Consequences (testable):**
- With the send permission ungranted, the draft-reply Skill can produce a draft but cannot send; a send attempt is refused and recorded.
- Sending is a distinct, permission-gated action — a drafted reply is never dispatched as a side effect of a Run.

### 4.2 Agent Lifecycle & Testing

**Description:** Every Agent moves through **Draft → Test → Active**. Draft is an editable scratchpad that never runs in production. Test executes the Agent on demand in a sandboxed test context so the builder can observe behavior and cost before committing. **Activate** is a deliberate promotion. Realizes UJ-1.

**Functional Requirements:**

#### FR-4: Run an agent in test
The builder can execute a Draft (or Active) Agent on demand against a test input, sandboxed (FR-8), and observe the result.
**Consequences (testable):**
- A Test Run executes inside a Sandbox with the Guard active (FR-9) — testing is never unsandboxed.
- A Test Run executes against the Agent's **live Data Connection data in read-only mode** — real data, no writes/sends — so the builder observes true behavior before Activate.
- The Run produces a transcript and per-turn metrics: latency (ms), token counts, and cost, rendered as specified in the UX spine.
- A Test Run is subject to the same Permission Scopes and Cost Caps as production, but is clearly labeled **Test** and does not count as an Active run.

#### FR-5: Promote an agent to Active (Activate)
The builder can promote an Agent from Draft to **Active** in a deliberate, explicit action.
**Consequences (testable):**
- Activate is blocked with a stated reason unless the Agent has: a selected model from a connected provider, and a Cost Cap set (FR-10).
- On Activate, the Agent's state becomes **Active** and it becomes eligible to run in production under its Guard and Cost Cap.
- The builder can return an Active Agent to Draft (deactivate), which makes it ineligible for production runs.

#### FR-6: Agent lifecycle state is explicit and visible
Every Agent has exactly one Lifecycle State (Draft / Test / Active) that is visible wherever the Agent appears.
**Consequences (testable):**
- State is shown using the agent-status vocabulary from the UX spine (dot + word), never color alone.
- A Draft Agent cannot execute a production (Active) Run.

### 4.3 Sandboxed Execution & the Ingress/Egress Guard

**Description:** The heart of the product. Every Run — test or active — executes inside a per-Run Sandbox with a Guard that enforces default-deny ingress/egress against an Allowlist, and exposes a Filter Hook for later content inspection. Isolation is **on by default and not optional** — this is the single most important behavioral guarantee in turanga. Realizes UJ-2. *Implementation (container runtime, network mechanism) is an architecture concern — see `addendum.md`; this PRD specifies the guarantee, not the mechanism.*

**Functional Requirements:**

#### FR-7: Isolate every run in a sandbox by default
Every Agent Run executes inside a Sandbox; there is no configuration that runs an Agent un-sandboxed.
**Consequences (testable):**
- Attempting to run an Agent when a Sandbox cannot be established fails the Run with a stated reason; it does not fall back to unsandboxed execution.
- Two concurrent Runs do not share sandbox state (filesystem, memory, or runtime identity).

#### FR-8: Enforce default-deny egress against an allowlist
The Guard permits a Run to reach only destinations on its Allowlist; everything else is refused.
**Consequences (testable):**
- With an empty Allowlist, a Run can reach no external destination.
- An attempted egress to a non-allowlisted destination is blocked *and* recorded on the Run with the attempted destination.
- The Allowlist is per-Agent (or per-Connection) and is default-deny, not default-allow.

#### FR-9: Control ingress to the sandbox
The Guard governs what data is passed into a Run; an Agent receives only data from its configured, permitted Connections.
**Consequences (testable):**
- A Run cannot read data from a Connection the Agent is not configured to use.
- Data entering the Sandbox is attributable to a specific permitted Connection.

#### FR-10: Expose a filter hook for future inspection
The Guard exposes a defined Filter Hook interface at which inspection logic can run on ingress/egress payloads, without shipping an inspector in MVP.
**Consequences (testable):**
- With no filter registered, the Hook is a no-op and does not alter Guard behavior.
- Registering a trivial test filter (e.g. one that blocks a sentinel string) demonstrably blocks a matching payload — proving the seam works end to end.

**Notes:** `[NOTE FOR PM]` The *adversarial-grade* egress guard (surviving prompt-injection exfiltration) is the roadmap moat per the brief; MVP delivers default-deny allowlist + the Hook, not the injection-resistant inspector.

### 4.4 Cost Governance

**Description:** Each Active Agent runs under a hard Cost Cap over a time window, with a live meter and Kill-on-breach. Cost is a first-class product promise, not observability. Realizes UJ-2.

**Functional Requirements:**

#### FR-11: Set hard cost caps per agent (per-run and per-day)
The builder can set two Cost Caps for an Agent: a **per-run** cap (maximum spend for any single Run) and a **per-day** cap (maximum cumulative spend per day).
**Consequences (testable):**
- An Agent cannot be Activated (FR-5) without both caps set.
- A single Run cannot exceed the per-run cap (FR-12); cumulative daily spend cannot exceed the per-day cap.
- Cap amounts are editable while Active; the per-day cap resets at the start of each day; changes apply going forward.

#### FR-12: Meter spend live and kill on breach
turanga meters an Agent's spend against both Cost Caps in real time and terminates an in-progress Run when either cap is reached.
**Consequences (testable):**
- The live meter reflects both the current Run's spend (vs per-run cap) and the day's cumulative spend (vs per-day cap), visible wherever the Agent is operated.
- When a Run's spend reaches the per-run cap, or cumulative daily spend reaches the per-day cap, the in-progress Run is terminated (Kill-on-breach); further Runs are refused until the day resets (per-day) — a per-run breach does not disable the Agent for the day.
- Kill-on-breach terminates the in-flight Run within one model round-trip of the breach `[target — architecture bounds exact overshoot]`.
- The meter's reported spend for a completed Run matches the sum of its Run metrics (no silent drift). `[NOTE FOR PM: exact enforcement semantics under streaming/concurrency — reserve-then-reconcile — are an architecture concern flagged in the brief; this FR states the guarantee.]`

### 4.5 Connections & Central Management

**Description:** A single place to manage Agents, Connections (Model Provider and Data), and keys. Connections are generic; the first Data Connection *implementation* is Gmail (via OAuth), but nothing platform-level is email-specific. Realizes UJ-1.

**Functional Requirements:**

#### FR-13: Manage model provider connections
The builder can connect a Model Provider by providing credentials, and the models it exposes become selectable (FR-2).
**Consequences (testable):**
- Provider connection status is shown as connected / error / unconfigured (dot + word).
- An invalid key surfaces an error with the cause; the provider is not marked connected.
- Stored keys are masked in the UI after entry.

#### FR-14: Manage a data connection (generic; first impl = Gmail via OAuth)
The builder can configure a Data Connection that an Agent may read from / write to, subject to the Guard. The MVP ships one implementation — **Gmail via scoped OAuth** — behind a generic Connection abstraction.
**Consequences (testable):**
- The Gmail Connection is authorized via scoped OAuth (the builder grants only the scopes the Connection needs); tokens are stored securely and revocable.
- The Gmail Connection is consumed by Agents only through the generic Connection interface; no Gmail/email-specific logic exists in the Agent-definition, Lifecycle, Sandbox, or Cost-governance code paths (genericity check — see SM-4).
- A Data Connection's reachable destinations are governed by the Allowlist (FR-8).

#### FR-15: Central agent & connection management
The builder can view and manage all Agents and Connections from a single management surface.
**Consequences (testable):**
- The agents view lists every Agent with its Lifecycle State and live cost meter (for Active agents).
- Removing a Connection in use surfaces which Agents depend on it before confirming.

### 4.6 Access & Single-User Setup

**Description:** A single-user authentication gate. Thin by design; SSO and multi-user are non-goals. Mirrors the UX Login spine.

**Functional Requirements:**

#### FR-16: Single-user email + password authentication
The builder can sign in with email and password to reach the authenticated app.
**Consequences (testable):**
- Unauthenticated access to any surface other than Login is refused.
- Credentials are stored using a standard password-hashing scheme (not plaintext).
- The login surface reserves space for a future SSO option but does not implement it in MVP.

## 5. Non-Goals (Explicit)

In v1, turanga will **not**:
- Become a use-case product. No packaged "email assistant," "portfolio manager," or "home hub" — those are built on top. `[NON-GOAL for MVP]`
- Support multiple users, teams, roles, or multi-tenant isolation.
- Ship workflows or an eventing engine (agents sitting in orchestrated processes).
- Ship self-learning / skill auto-updating, or agent memory management.
- Ship a runtime macro language in Skills, an MCP/tool marketplace, or model routing.
- Ship local inference (llama.cpp) or an OpenRouter integration — a single connected provider suffices for MVP. `[NON-GOAL for MVP]`
- Ship multi-agent orchestration.
- Ship a content-inspection / PII engine. The Filter Hook (FR-10) is in; the inspector is not.
- Become an adversarially-hardened egress guard in v1. MVP is default-deny allowlist + Hook; the injection-resistant reference monitor is the roadmap moat.

## 6. MVP Scope

### 6.1 In Scope
- Agent Definition (model, instructions, skills, scoped permissions) + the built-in skill set (read/search, draft reply send-gated, flag/label, summarize) — FR-1..3, FR-17..18.
- Lifecycle & Testing (draft → test-against-live-data-read-only → Activate) — FR-4..6.
- Sandboxed execution + default-deny ingress/egress Guard + Filter Hook — FR-7..10.
- Cost governance (per-run + per-day hard caps, live meter, kill-on-breach) — FR-11..12.
- Connections & central management (model provider + one generic Data Connection, first impl Gmail via OAuth) — FR-13..15.
- Single-user email/password access — FR-16.
- **Dogfood proof:** an email Agent built entirely on the above, Activatable against a real inbox, with zero email-specific platform code.
- Single-user, single-machine.

### 6.2 Out of Scope for MVP
- Everything in §5 Non-Goals.
- The Gmail *Connection implementation* is in scope; a library of connectors is not — one generic Connection + one implementation. `[NOTE FOR PM: the second connector is the first roadmap validation of genericity — revisit right after MVP.]`
- Per-agent-group and rolling-window cost caps (MVP is per-run + per-day, per Agent). Deferred to v2.

## 7. Success Metrics

**Primary**
- **SM-1 (The exhale test):** The builder builds an email Agent on turanga and is willing to **Activate** it against a real inbox. Target: yes. Validates FR-1..18 as a whole — the one falsifiable outcome.
- **SM-2 (Guard holds):** Across a test battery, 100% of egress attempts to non-allowlisted destinations are blocked and recorded; 0 unsandboxed executions occur. Validates FR-7, FR-8, FR-9.
- **SM-3 (Cost cap holds):** Across a test battery, no Active Agent exceeds its Cost Cap for the window; every breach terminates the in-progress Run. Validates FR-11, FR-12.

**Secondary**
- **SM-4 (Genericity holds):** The platform source (Agent-definition, Lifecycle, Sandbox, Cost, Connection-interface code paths) contains no use-case-specific logic; the email Agent is built only through generic interfaces. Target: pass a code inspection. Validates FR-14.
- **SM-5 (Second agent is cheap):** A second, different Agent (non-email) can be created and Activated without modifying platform code — measured post-MVP. Validates the generic thesis.

**Counter-metrics (do not optimize)**
- **SM-C1 (Don't lock it into uselessness):** Counterbalances SM-2/SM-3 — security and caps must not make the exhale test *fail the other way* (so restrictive the builder won't use it). If achieving SM-2/SM-3 makes the builder abandon the tool, that is failure, not success.
- **SM-C2 (Don't chase features):** Counterbalances a breadth reflex — number of connectors/skills shipped is explicitly *not* a success measure for MVP; depth on the Guard and the cap is.

## 8. Open Questions

*Resolved this pass (2026-07-31): cost window (per-run + per-day), email connection (Gmail via OAuth), test-context data (live inbox, read-only), MVP skill set (read/search, draft-reply send-gated, flag/label, summarize), kill-on-breach target (within one model round-trip). Remaining:*

1. **Gmail OAuth scopes** — the minimal (least-privilege) scope set for the read/search, draft, flag/label, and summarize Skills. Resolve with architecture.
2. **Default cap amounts** — sensible default $ values to pre-fill for the per-run and per-day caps (UX detail).
3. **Allowlist authoring** — how the builder expresses allowed destinations, and whether the default lives per-Agent or per-Connection (UX + architecture).

## 9. Assumptions Index

*Remaining `[ASSUMPTION]` tags, surfaced for explicit confirmation:*
- FR-1 — Draft edits **autosave** (carried from the UX spine). `[ASSUMPTION]`
- FR-16 — Email + password auth, no SSO in MVP. `[ASSUMPTION — confirmed direction in party session]`

*Resolved this pass (no longer assumptions): cost caps per-run + per-day (FR-11); Data Connection = Gmail via OAuth (FR-14); Test runs against live read-only data (FR-4).*

---

## 10. Cross-Cutting NFRs

- **NFR-1 (Isolation integrity):** The isolation guarantee (FR-7) is the product's core safety property; a Run must never execute outside a Sandbox, even on error paths. Failure to sandbox = fail-closed, never fall-through.
- **NFR-2 (Egress fail-closed):** The Guard defaults to deny. Any Guard error or misconfiguration results in *refused* egress, never permitted egress.
- **NFR-3 (Cost enforcement reliability):** Kill-on-breach must hold under concurrent Runs; the meter must not undercount such that a cap is silently exceeded. (Mechanism — reserve-then-reconcile — is architecture; the guarantee is here.)
- **NFR-4 (Observability):** Every Run records its transcript, metrics, and any Guard/permission refusals, so the builder can always answer "what did it do and what was blocked."
- **NFR-5 (Local-first data):** Single-machine; the builder's data and keys stay on the builder's infrastructure. No turanga-operated cloud dependency for running agents.
- **NFR-6 (Visual identity):** All UI conforms to the Warm Ink design system (`.claude/skills/warm-ink-design`) and the UX spines — status is never color-only; numbers are mono/tabular.

## 11. Constraints and Guardrails

**Safety**
- Sandbox-on-by-default and egress-default-deny are non-negotiable invariants (NFR-1, NFR-2). No "disable sandbox" affordance ships.
- Promotion to Active is always a deliberate human action (FR-5); nothing auto-activates.

**Privacy**
- Data and credentials are single-machine and local (NFR-5). Keys are masked in UI and never logged in plaintext.

**Cost**
- Every Active Agent has a hard cap (FR-11); there is no "unlimited" Active state.
- Feature breadth is not a goal; depth on Guard + cap is (SM-C2).
