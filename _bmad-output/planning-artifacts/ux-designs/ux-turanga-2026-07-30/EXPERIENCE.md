---
name: turanga — Experience
description: Information architecture, behavior, states, interactions, accessibility, and key flows for turanga's first three surfaces — Login, Agent definition, Settings. Visual identity lives in DESIGN.md (which inherits the Warm Ink baseline). This spine references DESIGN.md tokens as {path.to.token}.
status: draft
updated: 2026-07-30
sources:
  - file:DESIGN.md
  - file:{project-root}/.claude/skills/warm-ink-design/readme.md
---

## Foundation

- **Form-factor:** desktop web. turanga is a builder tool; the primary work happens at a wide viewport with a mouse and keyboard. Minimum supported width **1024px**; below that the two-pane builder degrades (see Responsive & Platform). `[ASSUMPTION — no mobile in v1; confirm]`
- **UI system:** the **Warm Ink** internal design system is the visual identity reference. Every surface here inherits its tokens and components; this spine specifies only the behavioral delta. Visual specs → `DESIGN.md`.
- **Theme:** light and dark are equals. The active theme is a `Profile` setting and persists per user; components read semantic tokens only, so no surface needs a theme branch.
- **Stakes:** internal tool. Density and speed over polish; the accessibility floor below is the pragmatic-but-real bar, not a consumer-grade ceiling.

## Information Architecture

Two zones: **unauthenticated** (Login only) and the **authenticated app shell**.

App shell (Warm Ink layout):
- **Left sidebar (248px):** primary nav — `Agents`, `Settings`. Collapsible. Selected item uses `--surface-selected` (no coloured indicator).
- **Topbar (48px):** workspace name/switcher (left), theme toggle + account menu (right).
- **Content (max 1240px):** the active surface.

Surfaces and their reason to exist:

| Surface | Route (indicative) | Delivers |
|---|---|---|
| Login | `/login` | Authenticate; the only surface outside the shell |
| Agents (list) | `/agents` | Post-login landing; every agent + its live status; entry to the builder `[ASSUMPTION — landing surface]` |
| Agent definition | `/agents/:id` | Define + test one agent (model, instructions, tools, knowledge, variables) |
| Settings › Model providers | `/settings/providers` | Connect model providers, manage API keys |
| Settings › Profile | `/settings/profile` | Name, email, password, theme |
| Settings › Workspace | `/settings/workspace` | Workspace name, members, roles `[for owners/operators later]` |
| Settings › Billing | `/settings/billing` | Token spend, cost, plan |

**Surface closure:** the three stated surfaces (Login, Agent definition, Settings) all have a home. One inferred surface — the **Agents list** — is needed as the post-login landing and the entry point to the builder; it's tagged `[ASSUMPTION]` because you named the builder, not the list. If you'd rather land directly in a single agent, say so and IA collapses accordingly.

## Voice and Tone

Inherits Warm Ink's content fundamentals (sentence case, second person for the user / third for the agent, verb-first buttons, specific unrounded numbers, no exclamation marks, no emoji). Product-specific microcopy:

- **Buttons are verbs:** `Save`, `Deploy`, `Run test`, `Connect provider`, `Add tool`, `Remove`. Never `Submit` / `OK`.
- **Agent state is stated, never celebrated:** "Succeeded in 428 ms." not "Done! 🎉". "Paused for review — the refund exceeds the $500 limit." not "Uh oh!".
- **Errors name cause → consequence → recovery:** "OpenAI key rejected (401), so this agent can't run. Update the key in Settings › Model providers."
- **Empty states are a fact + one action:** "No agents yet." + *Create agent*. "No test runs." + *Run test*.

## Component Patterns (behavioral)

Visual specs live in `DESIGN.md`; here is how they *behave*.

- **`{components.agent-editor-pane}`** — collapsible sections (Model, Instructions, Tools, Knowledge, Variables). All edits **autosave** (debounced); the save state is shown, never a manual Save button for config. `[ASSUMPTION — autosave over explicit save; confirm]`
- **Instructions editor** — a mono text area. Typing `{` opens a variable-insert popover; inserted `{vars}` render as `{components.variable-token}`. Undefined `{vars}` referenced in text surface a caution hint linking to the Variables section.
- **`{components.test-pane}`** — a persistent chat transcript for the current agent. Send a message → a new turn streams in; the in-flight turn shows the pulsing `{colors.agent-running}` dot; on completion it resolves to `{colors.agent-succeeded}` / `{colors.agent-failed}` with mono metrics (latency, tokens, cost). Transcript persists per session; `Clear` resets it.
- **`{components.model-selector}`** — grouped by provider; a provider with no key is shown disabled with an inline `Connect in Settings` link. Leading dot = provider status.
- **`{components.tool-chip}`** — `Add tool` opens a picker popover (searchable list). Chips are removable inline.
- **`{components.provider-card}`** — status dot + word; masked key (`sk-…3f2a`); actions `Connect` / `Update key` / `Remove`. Verifying a key shows an inline pending state, then resolves to connected/error with a cause on failure.

## State Patterns

Every data surface defines five states. Defaults:

- **Loading** — skeleton rows/panes in `--surface-inset`; no spinners on full-page loads. Inline actions use a pending state on the control itself.
- **Empty** — fact + one primary action (see Voice). No illustrations.
- **Error** — cause + consequence + recovery, inline where the action was taken; destructive/blocking errors use `{colors.agent-failed}` sparingly (dot + text, never a full red banner).
- **Saving / saved** — config autosave shows `Saving…` → `Saved` in `--text-tertiary` micro-cap near the section; never blocks editing.
- **Agent lifecycle** — `idle | running | succeeded | review | failed`, the product's most-repeated status. Rendered as `{components.agent-status-dot}` in the agents list and test pane. `review` = paused, needs a human.

## Interaction Primitives

- **Autosave** for agent config; explicit verbs for state-changing actions (`Deploy`, `Connect`, `Remove`).
- **Keyboard:** `Cmd/Ctrl+Enter` runs the test from anywhere in the editor; `Esc` closes popovers/dialogs; full tab order through config sections; `/` focuses the agents-list filter. `[ASSUMPTION — shortcuts; confirm]`
- **Hover/press/focus** per Warm Ink: hover = one surface step up, press = one down, focus = the always-visible `{components.focus-ring}` (2px gap + teal ring). No transforms, no bounce.
- **The only looping motion** in the product is the running-agent pulse (1600ms). Nothing else animates on a resting screen.
- **Destructive actions** (Remove provider, Delete agent) confirm in a dialog naming the consequence; never a bare icon-click.

## Accessibility Floor

Pragmatic internal-tool bar, but non-negotiables:
- Every interactive element is keyboard-reachable with the visible Warm Ink focus ring; focus is never removed.
- Status is **never colour-only** — the dot always pairs with a word (`running`, `failed`), so lifecycle reads without colour perception.
- Text contrast follows Warm Ink's semantic tokens (text-on-tint is always ink). Target WCAG AA for body text.
- Form fields have persistent labels (not placeholder-only); errors are associated with their field and announced.
- Mono metric text stays ≥ 12px.

## Key Flows

**Protagonist — Ravi, the builder-operator** (initially the only user: he both builds agents and runs them). `[ASSUMPTION — persona stands in for the owner]`

### Flow 1 — First agent, first successful test
1. Ravi opens turanga to `/login`. Enters email + password, `Sign in`.
2. Lands on **Agents** — empty. "No agents yet." + *Create agent*. He clicks it.
3. The **agent-definition** split opens. Left: config, collapsed to `Model` first. He picks a model — but the selector shows `openai / gpt-4o` **disabled**: no key yet, with `Connect in Settings`.
4. He follows it to **Settings › Model providers**, clicks `Connect` on OpenAI, pastes his key. It verifies inline → status dot flips to `{colors.provider-connected}` **connected**. He returns to the agent.
5. Model now selectable. He writes instructions, typing `You handle refunds for {` — the variable popover opens, he inserts `{order_id}`. The token renders signal-tinted.
6. **Climax:** He hits `Cmd+Enter`. The **test pane** springs to life — his message, then the agent turn with the pulsing running dot. 428 ms later it resolves to a **succeeded** dot with `1,284 tokens · $0.0041` in mono. The first colour Ravi has seen on the screen is the one that means *it worked*.
7. Config has been autosaving throughout; the section shows `Saved`. He returns to Agents; his agent sits there with an `idle` dot.

### Flow 2 — A run that needs him (review state)
1. From Agents, Ravi opens his refund agent and runs a test that trips a business rule.
2. The turn resolves not to succeeded but to **review** (`{colors.agent-review}`, caution): "Paused for review — the refund exceeds the $500 limit." with the cause and two verbs: *Approve* / *Adjust instructions*.
3. **Climax:** He reads the reason, edits the instructions to add a ceiling, re-runs, and watches it resolve **succeeded**. The review state did its job: it stopped, told him why, and handed him the recovery — no celebration, no drama.

## Responsive & Platform

Desktop-first. At ≥1024px the agent-definition surface is the two-pane split (`{spacing.editor-split}`). Below 1024px the test pane collapses to a `Test` toggle that overlays; the config editor goes single-column. Login and Settings are single-column and reflow cleanly. No dedicated mobile experience in v1. `[ASSUMPTION — confirm minimum width and whether operators/owners need a read-only mobile view later]`

## Inspiration & Anti-patterns

- **Inspiration:** Dify's agent/app builder (the config-left / preview-right split), Linear's keyboard-first density, Warm Ink's status-as-the-only-colour discipline.
- **Anti-patterns to avoid:** saturated brand colour on every button (Warm Ink's core warning); pill-shaped tool chips; a second status vocabulary for providers vs agents; modal-heavy config; celebratory success copy; placeholder-only form labels.

---

*Visual identity → `DESIGN.md` (inherits the Warm Ink baseline; wins on conflict). This spine owns behavior. Open `[ASSUMPTION]` tags above are the confirm-list for the next Update pass.*
