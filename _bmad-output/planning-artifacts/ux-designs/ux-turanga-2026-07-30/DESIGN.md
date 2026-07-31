---
name: turanga
description: Visual identity for turanga — a generic, isolation-first agent platform where builders define, secure, and operate LLM agents. This DESIGN.md inherits the Warm Ink baseline design system wholesale and specifies only the product-layer deltas (agent-builder components, provider/connection status, cost caps, allowlist, login). Warm Ink wins on conflict. Reconciled against the final PRD + Architecture spine.
status: final
updated: 2026-07-31
sources:
  # Inherits the repository baseline. All unlisted tokens (ink ramp, signal,
  # semantic, typography, spacing, shape, motion) come from Warm Ink unchanged.
  - file:{project-root}/.claude/skills/warm-ink-design/DESIGN.md
  - file:{project-root}/_bmad-output/planning-artifacts/prds/prd-turanga-2026-07-31/prd.md
  - file:{project-root}/_bmad-output/planning-artifacts/architecture/architecture-turanga-2026-07-31/ARCHITECTURE-SPINE.md
colors:
  # No new brand colours. turanga leans hard on Warm Ink's core rule:
  # saturated colour is reserved for what the system is doing. The agent
  # lifecycle vocabulary IS that colour budget — mapped here by role.
  # MVP run outcomes: idle | running | succeeded | failed | killed. ("review" = roadmap.)
  agent-idle: '{colors.ink-400}'          # --state-idle
  agent-running: '{colors.signal-500}'    # --state-running (the pulsing dot)
  agent-succeeded: '{colors.positive-500}'
  agent-failed: '{colors.critical-500}'   # errored
  agent-killed: '{colors.caution-500}'    # stopped by a guardrail (cap breach / blocked egress)
  # agent-review: roadmap — mid-run human-in-the-loop is deferred (Architecture AD-8).
  # Connection status (model providers AND data connections) reuses the semantic band — no new hues.
  conn-connected: '{colors.positive-500}'
  conn-error: '{colors.critical-500}'
  conn-unconfigured: '{colors.ink-400}'
typography:
  # Inherits Warm Ink. The delta is *where* mono is mandatory in this product:
  # model IDs, token counts, cost, latency, request IDs, variable names, cap amounts.
  code-block:
    fontFamily: 'IBM Plex Mono'
    fontSize: 13px
    lineHeight: 20px
    note: 'Instructions editor and test I/O render in mono. tabular-nums on all metrics and cost caps.'
rounded: {}   # inherit Warm Ink (4px default control corner)
spacing:
  # Inherit Warm Ink. Product-layer layout constants for the builder:
  editor-split: '60/40'   # agent-config pane / test pane default split (draggable)
  card-min: 280px
components:
  login-card:
    background: '{colors.surface-card}'
    border: '1px solid var(--border-subtle)'
    radius: '{rounded.lg}'
    shadow: 'var(--shadow-sm)'
    width: 400px
    note: 'Centered on --bg-canvas. Product name in Instrument Sans Medium (no logo exists). Email + password fields with persistent labels; SSO slot reserved below a hairline for later.'
  agent-editor-pane:
    background: '{colors.surface-card}'
    note: 'Left pane of the agent-definition split. Vertical stack of collapsible config sections: Model, Instructions, Skills, Variables, Cost caps, Allowlist. Section labels are 11px tracked micro-caps.'
  test-pane:
    background: '{colors.bg-canvas}'
    border-left: '1px solid var(--border-subtle)'
    note: 'Right pane. Chat-style run transcript against live Data Connection data (read-only in Test). Each turn shows role + mono metrics (latency ms, tokens, cost). Running turn shows the pulsing --state-running dot — the only looping motion on screen. Blocked egress / permission refusals surface inline as a refusal row.'
  model-selector:
    radius: '{rounded.md}'
    height: '{spacing.control-h-md}'
    note: 'Select control, grouped by provider. Renders provider + model id in mono (e.g. openai / gpt-4o). Provider-status dot to the left; an unconfigured provider is disabled with an inline "Connect in Settings" link.'
  skill-chip:
    radius: '{rounded.md}'    # NOT pill — pill is reserved for live status only
    border: '1px solid var(--border-strong)'
    note: 'An attached built-in Skill (read/search, draft reply, flag/label, summarize) shows name + a remove affordance. Rectangular, 4px corner. Adding opens a searchable picker popover (--shadow-md). A per-skill permission scope is set inline; an outbound (send) permission is a distinct, off-by-default grant.'
  variable-token:
    fontFamily: 'IBM Plex Mono'
    background: '{colors.signal-100}'
    foreground: '{colors.text-primary}'
    radius: '{rounded.sm}'
    note: 'Inline {variable} reference inside the instructions editor. Signal-tinted because it is a live binding the system resolves.'
  cost-caps-control:
    note: 'In the agent-definition Cost caps section: two money inputs (per-run cap, per-day cap) in mono/tabular. Both required before Activate. Paired with a live cost meter showing current-run spend vs per-run cap and today spend vs per-day cap.'
  cost-meter:
    note: 'Live meter (mono/tabular) shown in agent-definition and per Active agent in the agents list: "today $0.0413 / $5.00". Neutral until near a cap; the killed state uses --state (agent-killed) when a cap stops a run.'
  connection-card:
    background: '{colors.surface-card}'
    border: '1px solid var(--border-subtle)'
    radius: '{rounded.lg}'
    min-width: '{spacing.card-min}'
    note: 'Settings. Two kinds. Model provider: name, status dot + word, masked key, verb-first action (Connect / Update key / Remove). Data connection (Gmail): name, status dot + word, OAuth "Connect with Google" then declared destinations + Revoke — no raw token ever shown.'
  allowlist-view:
    note: 'Per-agent egress allowlist. Rows = Connection-derived destinations (read-only) + explicit additions (editable). Default-deny stated plainly. Blocked-egress refusals from runs surface here and in the test pane: destination attempted + reason.'
  settings-nav:
    note: 'Left sub-nav within Settings: Model providers · Data connections · Profile. Selected item uses --surface-selected, not a coloured indicator. (Workspace · Billing are roadmap.)'
  agent-status-dot:
    shape: '6–7px dot + a word'
    note: 'MVP: idle | running | succeeded | failed | killed. running pulses 1600ms. Appears in the agents list and the test pane. Never a coloured pill badge. ("review" is roadmap.)'
---

## Brand & Style

turanga inherits the **Warm Ink** baseline in full — warm-ink neutrals, ink primary actions, a single cold-teal signal, geometric sans + mono, 4px corners, light and dark as equals. Read `.claude/skills/warm-ink-design/DESIGN.md` and `readme.md` for the foundation; this file records only what turanga *adds*.

The product premise sharpens Warm Ink's one rule to a point: turanga is a tool for building things that *do work on their own*, safely. So the entire saturated-colour budget goes to **agent state and connection status** — an agent running, a run that succeeded, a run a guardrail *killed*, a connection that failed. Chrome is ink and neutral; the only colour on a resting screen is a status dot. When a builder's eye catches colour, it always means *something is happening or needs you*.

## Colors

No new brand hues — that is the point. turanga maps Warm Ink's existing tokens to two product vocabularies:

- **Agent lifecycle** (`{colors.agent-idle}` … `{colors.agent-killed}`) — the 6–7px dot + word from Warm Ink, used in the agents list and the test pane. MVP states are `idle | running | succeeded | failed | killed`; `{colors.agent-running}` (signal teal) is the only element that pulses. `killed` (a guardrail stopped the run — cap breach or blocked egress) reads caution, distinct from an errored `failed`.
- **Connection status** — model providers *and* data connections reuse the semantic band (`{colors.conn-connected}` / `{colors.conn-error}` / `{colors.conn-unconfigured}`) as a small dot + word, identical in grammar to agent status.

Everything else — surfaces, text, borders, buttons — is Warm Ink's semantic aliases untouched. Primary actions (Save, **Activate**, Connect) are **ink, not teal**.

## Typography

Warm Ink's ramp, unchanged. The product delta is *mandatory mono zones*: model IDs, token counts, cost, latency, request/run IDs, `{variable}` names, and **cost-cap amounts** always render in IBM Plex Mono with `tabular-nums`. The **instructions editor** and the **test I/O transcript** are mono surfaces — machine text a human is authoring or reading. Human chrome (labels, buttons, nav) stays Instrument Sans.

## Layout & Spacing

Warm Ink's app-shell constants: 248px sidebar, 48px topbar, 1240px content max, 56px page margins. Product-specific:

- **Agent-definition** is a two-pane split — config editor left, live test pane right — default `{spacing.editor-split}` (60/40), draggable divider. Below 1024px the test pane collapses to a `Test` toggle and the config goes single-column.
- **Settings** is a left sub-nav (`{components.settings-nav}`) + content, inside the standard shell.
- **Login** is the only surface outside the app shell: a single `{components.login-card}` centered on `--bg-canvas`.

## Elevation & Depth

Inherited from Warm Ink verbatim. In this product, `--shadow-md` appears only on the skill-picker popover, model-selector dropdown, and any confirm dialog. The two builder panes are separated by a hairline (`--border-subtle`), never by shadow.

## Shapes

Warm Ink radii, unchanged; 4px default. Product reminder made explicit because agent-builder UIs drift toward pills: **skill chips, variable tokens, and connection cards are rectangular (4px)**. `--radius-full` (pill) is reserved exclusively for the live agent-status chip.

## Components

Product-layer components are defined in the frontmatter `components` block. In prose, the ones that carry the most brand weight:

- **Test pane** — the emotional center of the builder. A chat-style transcript (live read-only data in Test) where each agent turn carries mono metrics (`428 ms`, `1,284 tokens`, `$0.0041`) and the in-flight turn shows the pulsing `{colors.agent-running}` dot. Blocked egress and permission refusals appear inline as refusal rows — this is where "colour means something is happening" *and* "the guard is visible" both earn their keep.
- **Cost-caps control + meter** — two mono money inputs (per-run, per-day), both required before Activate, paired with a live meter. The meter is the character the product turns on: a leash you can watch tick.
- **Connection card** — model-provider (masked key) and data-connection (Gmail OAuth → declared destinations + Revoke) share one status grammar; a builder learns one status language for the whole product.
- **Allowlist view** — per-agent, Connection-derived + explicit additions, default-deny, with run refusals surfaced. The moat, made legible.
- **Model selector / variable token / skill chip** — as specced in the frontmatter.

Everything not listed (Button, Input, Select, Card, Dialog, Tabs, Toast, Table, sidebar, topbar) is Warm Ink as-is. Customizing those is against the discipline.

Icons: Lucide, `currentColor`, per Warm Ink. No emoji.

## Do's and Don'ts

| Do | Don't |
|---|---|
| Spend the colour budget on agent + connection status only | Colour primary buttons (Save/Activate/Connect are ink) |
| Render model IDs, tokens, cost, latency, `{vars}`, cap amounts in mono tabular | Put metrics or caps in proportional sans |
| Use the dot + word for agent state and connection status alike | Introduce a second status grammar or coloured pill badges |
| Keep skill chips / variable tokens / connection cards at 4px | Reach for pills (reserved for the live agent-status chip) |
| Surface blocked egress + refusals inline (make the guard visible) | Hide what the guard stopped |
| Separate the two builder panes with a hairline | Use shadow or a coloured divider between panes |
| Reserve the pulse for the running agent turn | Animate anything else in the builder |
| Inherit Warm Ink for all base components | Restate or re-skin baseline tokens in this file |

---

*Inherits `.claude/skills/warm-ink-design/DESIGN.md` (the repository baseline). This file is the product-layer delta only; the baseline wins on conflict. Reconciled 2026-07-31 against the final PRD and Architecture spine. Exact token values live in `.claude/skills/warm-ink-design/tokens/*.css`.*
