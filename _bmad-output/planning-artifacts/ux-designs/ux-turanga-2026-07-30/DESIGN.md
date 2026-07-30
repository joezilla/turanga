---
name: turanga
description: Visual identity for turanga — an agentic platform (Dify/Hermes-like) where builders define, configure, and operate LLM agents. This DESIGN.md inherits the Warm Ink baseline design system wholesale and specifies only the product-layer deltas (agent-builder components, provider status, login). Warm Ink wins on conflict.
status: draft
updated: 2026-07-30
sources:
  # Inherits the repository baseline. All unlisted tokens (ink ramp, signal,
  # semantic, typography, spacing, shape, motion) come from Warm Ink unchanged.
  - file:{project-root}/.claude/skills/warm-ink-design/DESIGN.md
colors:
  # No new brand colours. turanga leans hard on Warm Ink's core rule:
  # saturated colour is reserved for what the system is doing. The agent
  # lifecycle vocabulary IS that colour budget — mapped here by role.
  agent-idle: '{colors.ink-400}'        # --state-idle
  agent-running: '{colors.signal-500}'  # --state-running (the pulsing dot)
  agent-succeeded: '{colors.positive-500}'
  agent-review: '{colors.caution-500}'  # paused / needs a human
  agent-failed: '{colors.critical-500}'
  # Model-provider connection status reuses the semantic band — no new hues.
  provider-connected: '{colors.positive-500}'
  provider-error: '{colors.critical-500}'
  provider-unconfigured: '{colors.ink-400}'
typography:
  # Inherits Warm Ink. The delta is *where* mono is mandatory in this product:
  # model IDs, token counts, cost, latency, request IDs, variable names.
  code-block:
    fontFamily: 'IBM Plex Mono'
    fontSize: 13px
    lineHeight: 20px
    note: 'System-prompt editor and test I/O render in mono. tabular-nums on all metrics.'
rounded: {}   # inherit Warm Ink (4px default control corner)
spacing:
  # Inherit Warm Ink. Product-layer layout constants for the builder:
  editor-split: '60/40'   # agent-config pane / test pane default split
  provider-card-min: 280px
components:
  login-card:
    background: '{colors.surface-card}'
    border: '1px solid var(--border-subtle)'
    radius: '{rounded.lg}'
    shadow: 'var(--shadow-sm)'
    width: 400px
    note: 'Centered on --bg-canvas. Product name in Instrument Sans Medium (no logo exists). Email + password fields; SSO button slot reserved below a hairline for later.'
  agent-editor-pane:
    background: '{colors.surface-card}'
    note: 'Left pane of the agent-definition split. Vertical stack of collapsible config sections: Model, Instructions, Tools, Knowledge, Variables. Section labels are 11px tracked micro-caps.'
  test-pane:
    background: '{colors.bg-canvas}'
    border-left: '1px solid var(--border-subtle)'
    note: 'Right pane. Chat-style run transcript. Each turn shows role + mono metrics (latency ms, tokens, cost). Running turn shows the pulsing --state-running dot — the only looping motion on screen.'
  model-selector:
    radius: '{rounded.md}'
    height: '{spacing.control-h-md}'
    note: 'Select control. Renders provider + model id in mono (e.g. openai / gpt-4o). Provider status dot to the left.'
  tool-chip:
    radius: '{rounded.md}'    # NOT pill — pill is reserved for live status only
    border: '1px solid var(--border-strong)'
    note: 'Added tool shows name + a remove affordance. Rectangular, 4px corner. Adding opens a picker popover (--shadow-md).'
  variable-token:
    fontFamily: 'IBM Plex Mono'
    background: '{colors.signal-100}'
    foreground: '{colors.text-primary}'
    radius: '{rounded.sm}'
    note: 'Inline {variable} reference inside the instructions editor. Signal-tinted because it is a live binding the system resolves.'
  knowledge-item:
    radius: '{rounded.md}'
    note: 'A row: filename in body text, size + indexed-status in mono/micro-cap. No coloured left border.'
  provider-card:
    background: '{colors.surface-card}'
    border: '1px solid var(--border-subtle)'
    radius: '{rounded.lg}'
    min-width: '{spacing.provider-card-min}'
    note: 'Settings > Model providers. Provider name, connection status dot + word, masked API key, verb-first action (Connect / Update key / Remove).'
  settings-nav:
    note: 'Left sub-nav within Settings: Model providers · Profile · Workspace · Billing. Selected item uses --surface-selected, not a coloured indicator.'
  agent-status-dot:
    shape: '6–7px dot + a word'
    note: 'idle | running | succeeded | review | failed. running pulses 1600ms. Appears in the agents list and the test pane. Never a coloured pill badge.'
---

## Brand & Style

turanga inherits the **Warm Ink** baseline in full — warm-ink neutrals, ink primary actions, a single cold-teal signal, geometric sans + mono, 4px corners, light and dark as equals. Read `.claude/skills/warm-ink-design/DESIGN.md` and `readme.md` for the foundation; this file records only what turanga *adds*.

The product premise sharpens Warm Ink's one rule to a point: turanga is a tool for building things that *do work on their own*. So the entire saturated-colour budget goes to **agent state and connection status** — an agent running, a run that succeeded, a step paused for review, a provider that failed to connect. Chrome is ink and neutral; the only colour on a resting screen is a status dot. When a builder's eye catches colour, it always means *something is happening or needs you*.

## Colors

No new brand hues — that is the point. turanga maps Warm Ink's existing tokens to two product vocabularies:

- **Agent lifecycle** (`{colors.agent-idle}` … `{colors.agent-failed}`) — the 6–7px dot + word from Warm Ink, used in the agents list and the test pane. `{colors.agent-running}` (signal teal) is the only element that pulses.
- **Provider connection status** — reuses the semantic band (`{colors.provider-connected}` / `{colors.provider-error}` / `{colors.provider-unconfigured}`). A provider is a small status dot + word on its card, identical in grammar to agent status.

Everything else — surfaces, text, borders, buttons — is Warm Ink's semantic aliases untouched. Primary actions (Save, Deploy, Connect) are **ink, not teal**.

## Typography

Warm Ink's ramp, unchanged. The product delta is *mandatory mono zones*: model IDs, token counts, cost, latency, request/run IDs, and `{variable}` names always render in IBM Plex Mono with `tabular-nums`. The **instructions (system-prompt) editor** and the **test I/O transcript** are mono surfaces — they're machine text a human is authoring or reading. Human chrome (labels, buttons, nav) stays Instrument Sans.

## Layout & Spacing

Warm Ink's app-shell constants: 248px sidebar, 48px topbar, 1240px content max, 56px page margins. Product-specific:

- **Agent-definition** is a two-pane split — config editor left, live test pane right — default `{spacing.editor-split}` (60/40), draggable divider. On narrower viewports the test pane collapses to a toggle. `[ASSUMPTION — split ratio; confirm in first mock]`
- **Settings** is a left sub-nav (`{components.settings-nav}`) + content, inside the standard shell.
- **Login** is the only surface outside the app shell: a single `{components.login-card}` centered on `--bg-canvas`.

## Elevation & Depth

Inherited from Warm Ink verbatim. In this product, `--shadow-md` appears only on the tool-picker popover, model-selector dropdown, and any confirm dialog. The two builder panes are separated by a hairline (`--border-subtle`), never by shadow.

## Shapes

Warm Ink radii, unchanged; 4px default. Product reminder made explicit because agent-builder UIs drift toward pills: **tool chips, variable tokens, and provider cards are rectangular (4px)**. `--radius-full` (pill) is reserved exclusively for the live agent-status chip.

## Components

Product-layer components are defined in the frontmatter `components` block. In prose, the ones that carry the most brand weight:

- **Test pane** — the emotional center of the builder. A chat-style transcript where each agent turn carries mono metrics (`428 ms`, `1,284 tokens`, `$0.0041`) and the in-flight turn shows the pulsing `{colors.agent-running}` dot. This is where Warm Ink's "colour means something is happening" rule earns its keep.
- **Variable token** — inline `{customer_id}`-style bindings in the instructions editor, signal-tinted because they're live references the system resolves at run time.
- **Provider card** — connection status expressed in the same dot+word grammar as agent status, so a builder learns one status language for the whole product.
- **Model selector** — always shows `provider / model-id` in mono with a leading provider-status dot.

Everything not listed (Button, Input, Select, Card, Dialog, Tabs, Toast, Table, sidebar, topbar) is Warm Ink as-is. Customizing those is against the discipline.

Icons: Lucide, `currentColor`, per Warm Ink. No emoji.

## Do's and Don'ts

| Do | Don't |
|---|---|
| Spend the colour budget on agent + provider status only | Colour primary buttons (Save/Deploy/Connect are ink) |
| Render model IDs, tokens, cost, latency, `{vars}` in mono tabular | Put metrics in proportional sans |
| Use the dot + word for both agent state and provider status | Introduce a second status grammar or coloured pill badges |
| Keep tool chips / variable tokens / provider cards at 4px | Reach for pills (reserved for the live agent-status chip) |
| Separate the two builder panes with a hairline | Use shadow or a coloured divider between panes |
| Reserve the pulse for the running agent turn | Animate anything else in the builder |
| Inherit Warm Ink for all base components | Restate or re-skin baseline tokens in this file |

---

*Inherits `.claude/skills/warm-ink-design/DESIGN.md` (the repository baseline). This file is the product-layer delta only; the baseline wins on conflict. Exact token values live in `.claude/skills/warm-ink-design/tokens/*.css`.*
