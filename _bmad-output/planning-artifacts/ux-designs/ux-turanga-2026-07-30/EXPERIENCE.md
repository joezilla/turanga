---
name: turanga — Experience
description: Information architecture, behavior, states, interactions, accessibility, and key flows for turanga's MVP surfaces — Login, Agents, Agent definition, Settings. Visual identity lives in DESIGN.md (which inherits the Warm Ink baseline). Reconciled 2026-07-31 against the final PRD + Architecture spine.
status: final
updated: 2026-07-31
sources:
  - file:DESIGN.md
  - file:{project-root}/.claude/skills/warm-ink-design/readme.md
  - file:{project-root}/_bmad-output/planning-artifacts/prds/prd-turanga-2026-07-31/prd.md
  - file:{project-root}/_bmad-output/planning-artifacts/architecture/architecture-turanga-2026-07-31/ARCHITECTURE-SPINE.md
---

## Foundation

- **Form-factor:** desktop web. turanga is a builder tool; the primary work happens at a wide viewport with a mouse and keyboard. Minimum supported width **1024px**; below that the two-pane builder degrades (see Responsive & Platform). No mobile experience in v1.
- **UI system:** the **Warm Ink** internal design system is the visual identity reference. Every surface inherits its tokens and components; this spine specifies only the behavioral delta. Visual specs → `DESIGN.md`.
- **Theme:** light and dark are equals. The active theme is a `Profile` setting persisted per user; components read semantic tokens only, so no surface needs a theme branch.
- **Stakes:** internal tool, single user (single-machine). Density and speed over polish; the accessibility floor below is the pragmatic-but-real bar.

## Information Architecture

Two zones: **unauthenticated** (Login only) and the **authenticated app shell**.

App shell (Warm Ink layout):
- **Left sidebar (248px):** primary nav — `Agents`, `Settings`. Collapsible. Selected item uses `--surface-selected` (no coloured indicator).
- **Topbar (48px):** workspace name (left), theme toggle + account menu (right).
- **Content (max 1240px):** the active surface.

Surfaces and their reason to exist:

| Surface | Route (indicative) | Delivers |
|---|---|---|
| Login | `/login` | Authenticate (email + password); the only surface outside the shell |
| Agents (list) | `/agents` | Post-login landing; every agent + its live status and cost meter; entry to the builder |
| Agent definition | `/agents/:id` | Define + test one agent (model, instructions, skills, variables, cost caps, allowlist) |
| Settings › Model providers | `/settings/providers` | Connect model providers, manage keys |
| Settings › Data connections | `/settings/connections` | Connect Gmail via OAuth, view destinations, revoke |
| Settings › Profile | `/settings/profile` | Name, email, password, theme |

*Roadmap surfaces (not in MVP): Settings › Workspace, Settings › Billing.*

**Surface closure:** every stated need has a surface, and every surface has a journey that lands there (see Key Flows). The Agents list is the post-login landing and the entry point to the builder.

## Voice and Tone

Inherits Warm Ink's content fundamentals (sentence case, second person for the user / third for the agent, verb-first buttons, specific unrounded numbers, no exclamation marks, no emoji). Product-specific microcopy:

- **Buttons are verbs:** `Save`, `Run test`, `Activate`, `Deactivate`, `Connect`, `Add skill`, `Remove`. Never `Submit` / `OK` / `Deploy`.
- **Agent state is stated, never celebrated:** "Succeeded in 428 ms." not "Done! 🎉". "Killed — per-day cost cap reached ($5.00)." not "Uh oh!".
- **Errors name cause → consequence → recovery:** "OpenAI key rejected (401), so this agent can't run. Update the key in Settings › Model providers."
- **Refusals are stated plainly:** "Blocked egress to api.example.com — not on this agent's allowlist." + *Add to allowlist*.
- **Empty states are a fact + one action:** "No agents yet." + *Create agent*. "No test runs." + *Run test*.

## Component Patterns (behavioral)

Visual specs live in `DESIGN.md`; here is how they *behave*.

- **`{components.agent-editor-pane}`** — collapsible sections (Model, Instructions, Skills, Variables, Cost caps, Allowlist). All config edits **autosave** (debounced); the save state is shown (`Saving… → Saved`), never a manual Save button for config.
- **Instructions editor** — a mono text area. Typing `{` opens a variable-insert popover; inserted `{vars}` render as `{components.variable-token}`. An undefined `{var}` referenced in text surfaces a caution hint linking to the Variables section.
- **`{components.test-pane}`** — a persistent chat transcript for the current agent, run against **live Data Connection data in read-only mode**. Send → a new turn streams in; the in-flight turn shows the pulsing `{colors.agent-running}` dot; on completion it resolves to `{colors.agent-succeeded}` / `{colors.agent-failed}` / `{colors.agent-killed}` with mono metrics (latency, tokens, cost). Blocked egress or permission refusals appear inline as refusal rows. `Clear` resets the transcript.
- **`{components.model-selector}`** — grouped by provider; a provider with no key is disabled with an inline `Connect in Settings` link. Leading dot = provider status.
- **`{components.skill-chip}`** — `Add skill` opens a searchable picker popover; chips removable inline; each carries a permission scope; the send permission is a distinct, off-by-default grant.
- **`{components.cost-caps-control}`** — per-run and per-day money inputs; both required before Activate; paired with the live `{components.cost-meter}`.
- **`{components.connection-card}`** — model provider (masked key; `Connect` / `Update key` / `Remove`) or data connection (Gmail OAuth → declared destinations + `Revoke`); status shown as dot + word; verifying shows an inline pending state then resolves to connected/error with a cause.
- **`{components.allowlist-view}`** — Connection-derived destinations (read-only) + explicit additions (editable); default-deny stated; run refusals surfaced with destination + reason.

## State Patterns

Every data surface defines five states. Defaults:

- **Loading** — skeleton rows/panes in `--surface-inset`; no spinners on full-page loads. Inline actions use a pending state on the control itself.
- **Empty** — fact + one primary action (see Voice). No illustrations.
- **Error** — cause + consequence + recovery, inline where the action was taken; destructive/blocking errors use `{colors.agent-failed}` sparingly (dot + text, never a full red banner).
- **Saving / saved** — config autosave shows `Saving… → Saved` in `--text-tertiary` micro-cap near the section; never blocks editing.
- **Agent lifecycle** — `idle | running | succeeded | failed | killed`, the product's most-repeated status, rendered as `{components.agent-status-dot}` in the agents list and test pane. `killed` = a guardrail stopped the run (cost cap or blocked egress). *(Mid-run `review` / human-in-the-loop is roadmap.)*

## Interaction Primitives

- **Autosave** for agent config; explicit verbs for state-changing actions (`Activate`, `Deactivate`, `Connect`, `Remove`).
- **Keyboard:** `Cmd/Ctrl+Enter` runs the test from anywhere in the editor; `Esc` closes popovers/dialogs; full tab order through config sections; `/` focuses the agents-list filter.
- **Hover/press/focus** per Warm Ink: hover = one surface step up, press = one down, focus = the always-visible `{components.focus-ring}` (2px gap + teal ring). No transforms, no bounce.
- **The only looping motion** in the product is the running-agent pulse (1600ms). Nothing else animates on a resting screen.
- **Destructive/irreversible actions** (Remove connection, Delete agent, Deactivate, Revoke) confirm in a dialog naming the consequence; removing a connection in use first surfaces the dependent agents.

## Accessibility Floor

Pragmatic internal-tool bar, but non-negotiables:
- Every interactive element is keyboard-reachable with the visible Warm Ink focus ring; focus is never removed.
- Status is **never colour-only** — the dot always pairs with a word (`running`, `killed`), so lifecycle reads without colour perception.
- Text contrast follows Warm Ink's semantic tokens (text-on-tint is always ink). Target WCAG AA for body text.
- Form fields have persistent labels (not placeholder-only); errors are associated with their field and announced.
- Mono metric text stays ≥ 12px.

## Key Flows

**Protagonist — Ravi, the builder-operator** (the only user: he both builds agents and runs them).

### Flow 1 — First agent, from draft to the exhale test
1. Ravi opens turanga to `/login`. Enters email + password, `Sign in`.
2. Lands on **Agents** — empty. "No agents yet." + *Create agent*. He clicks it; a new agent is created in **Draft**.
3. The **agent-definition** split opens. He picks a model — the selector shows `openai / gpt-4o` **disabled**: no key yet, with `Connect in Settings`.
4. He goes to **Settings › Model providers**, `Connect`s OpenAI, pastes the key → status dot flips **connected**. Then **Settings › Data connections**, `Connect with Google` → OAuth → Gmail **connected**, its declared destinations shown.
5. Back in the agent: model selectable. He writes instructions with a `{variable}`, adds the **read/search** and **draft reply** skills (draft's *send* left ungranted), and sets a **per-run** and **per-day** cost cap.
6. **Climax:** `Cmd+Enter`. The **test pane** runs the agent *sandboxed against his real inbox, read-only* — the pulsing running dot, then a **succeeded** dot with `1,284 tokens · $0.0041` in mono. He was willing to point it at his real mail. The exhale.
7. `Activate` was disabled until model + both caps were set; now it's live. He clicks it → **Active**. Back on Agents, his agent sits with a live status dot and a ticking, capped meter.

### Flow 2 — A run overreaches and turanga stops it
1. From the test pane, Ravi's agent (mid-run) tries to reach a destination not on its allowlist — or its next model call would breach a cap.
2. **Climax:** turanga **blocks the egress** (a refusal row: destination + "not on allowlist") *or* **kills the run** on cap breach — the turn resolves to a **killed** dot with the cause stated plainly ("Killed — per-day cost cap reached ($5.00).").
3. Ravi sees exactly what was attempted and why. He adds the destination via the **allowlist view** (or raises the cap), re-runs, and watches it resolve **succeeded**. The guard did its job: it stopped, said why, and handed him the recovery — no drama.

## Responsive & Platform

Desktop-first, minimum width **1024px**. At ≥1024px the agent-definition surface is the two-pane split (`{spacing.editor-split}`); below 1024px the test pane collapses to a `Test` toggle and the config editor goes single-column. Login and Settings are single-column and reflow cleanly. No dedicated mobile experience in v1.

## Inspiration & Anti-patterns

- **Inspiration:** Dify's agent/app builder (config-left / preview-right split), Linear's keyboard-first density, Warm Ink's status-as-the-only-colour discipline.
- **Anti-patterns to avoid:** saturated brand colour on every button (Warm Ink's core warning); pill-shaped skill chips; a second status grammar for connections vs agents; modal-heavy config; celebratory success copy; placeholder-only form labels; hiding what the guard blocked.

---

*Visual identity → `DESIGN.md` (inherits the Warm Ink baseline; wins on conflict). This spine owns behavior. Reconciled 2026-07-31 against the final PRD + Architecture; all prior `[ASSUMPTION]` tags resolved.*
