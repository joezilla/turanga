# Warm Ink — enterprise design system for an agentic platform

A foundation-first design system for a SaaS platform where users **define agents, run
operations, build workflows, host agentic apps, and supervise self-learning behaviour**.
Audience spans engineers, analysts, ops, finance/risk, admins, and execs — one product
read by six different tolerances for density.

**Sources:** none provided. No codebase, Figma file, brand assets, or logo were attached;
this system was authored from a written brief. Direction chosen with the user:
warm-ink neutrals, near-black (`#2B2B2B`) primary, geometric sans, 4px corners, light and
dark treated as equals, balanced density.

Scope of this pass: **tokens and primitives only** (colour, type, space, shape, elevation,
motion) plus foundation specimen cards and one applied surface as proof. No React
components or UI kits yet — see *Open questions* at the bottom.

---

## The idea in one line

Neutrals do the work, ink carries action, and colour is reserved for what the system is
doing. On any screen the only saturated pixels mean an agent is running, learned
something, or needs a human.

That single rule is what separates this from default-template design: generated apps put a
saturated brand colour on every primary button, then have nothing left to say when
something is actually happening.

---

## VISUAL FOUNDATIONS

### Colour
- **Neutrals (`--ink-*`, 15 steps)** — every step carries 0.004–0.010 chroma at hue 50–80.
  Warm, not beige: canvas reads as paper stock, dark mode reads as warm charcoal. Chroma
  tapers at both ends so extremes never muddy. **Never use pure `#000` or a hue-less grey.**
- **Primary action = `--ink-900`** (light) / `--ink-25` (dark). Buttons are ink, not colour.
- **Signal (`--signal-*`, 7 steps, hue 195)** — one cold teal, deliberately opposite the warm
  neutrals. Focus rings, links, running agents, selection. Never a full button surface.
- **Semantic** — positive 152°, caution 72°, critical 27°, info 245°. All share a lightness and
  chroma band; hue is the only variable, so no state out-shouts another. `-500` for dots and
  icons, `-100` for row tints. Text on a tint is always ink, never the hue.
- **Agent lifecycle** — `--state-idle | running | succeeded | review | failed`. Rendered as a
  6–7px dot plus a word. No coloured pill badges.
- **Data viz (`--viz-1..6`)** — one lightness, one chroma, six hues; order-independent.
- Backgrounds: **flat colour only.** No gradients, no mesh, no imagery behind UI. Depth comes
  from surface lightness steps (`canvas → card → raised`) and hairlines.

### Typography
- **Instrument Sans** for everything human; **IBM Plex Mono** for everything machine — IDs,
  latency, cost, token spend, timestamps, diffs, config. Mono is always `tabular-nums` so
  table columns never dance. *(Both are substitutions — see Caveats.)*
- Scale is 11 → 48px with paired line-heights. 14px base UI, 13px for dense tables,
  11px tracked micro-caps (0.075em, uppercase) for every column and section label.
- Tracking tightens as size grows: -0.022em display, -0.012em headings, 0 body.
- Three weights only: 400 / 500 / 600. **No 700 anywhere.** Emphasis comes from 500 + colour.
- Measure caps near 62ch for prose; italics essentially unused.

### Space + density
4px grid with 2px/6px half-steps. 8px inside controls, 12–16px inside cards, 24–32px between
regions, 56px page margins. Control heights 26/32/38px; table rows 40px. Sidebar 248px,
top bar 48px, content max 1240px.

### Shape, borders, elevation
- Radii 2/3/4/6/8/12px. **4px is the default control corner.** Pill (`--radius-full`) is reserved
  for live status chips so it keeps meaning.
- Separation is **hairlines first**: `--border-hairline` 10% alpha (tables, rows),
  `--border-subtle` 14% (cards), `--border-strong` 26% (inputs, secondary buttons). Alpha-based,
  so borders sit correctly on any surface in either theme.
- Shadows are warm-tinted (ink hue, not black) and near-invisible: `xs/sm` for cards,
  `md/lg` **only** for things that genuinely float — popovers, dialogs, command palette.
- Cards: 1px subtle border + `--shadow-sm` + 6px radius. Never a coloured left border.
- Transparency/blur: used only for scrim (`ink-1000` at 40%) and sticky-header protection.
  No frosted glass as decoration.

### Motion + interaction
- 90ms hover/press, 140ms tooltips and chips, 200ms panels, 320ms drawers. Easing is
  near-linear (`cubic-bezier(0.2,0,0,1)`). **Nothing bounces, nothing overshoots, nothing scales in.**
- The only looping animation in the product is agent activity: a 1600ms opacity pulse on the
  running dot. That scarcity is what makes it legible.
- Hover = one surface step up (`--surface-hover`), never an opacity fade. Press = one more step
  down, no transform. Focus = 2px canvas gap + 4px teal ring at 55% (`--focus-ring`), always visible.
- Disabled = `--text-disabled` + no border change. Never 50% opacity on a whole control.

### Imagery + iconography
No assets were provided, so **no logo exists in this system** — render the product name in
Instrument Sans Medium wherever a mark would go. Do not commission one here.

For icons, use **Lucide** (1.5px stroke, 16px/20px, `currentColor`) via CDN — it matches the
geometric-sans, small-radius, hairline character. No emoji, ever. No unicode glyphs as icons.
No hand-drawn illustration. Where product imagery is needed, use flat monochrome diagrams in
ink with a single signal accent — no photography, no 3D renders.

---

## CONTENT FUNDAMENTALS

- **Sentence case everywhere.** Titles, buttons, menu items, column labels. The only uppercase
  is the 11px tracked micro-cap label.
- **Second person for the user, third for the agent.** "You approved this rule." /
  "The agent escalated 3 tickets." Never "we", never "let's", never "Oops!".
- **Verb-first buttons:** Deploy, Roll back, Approve rule, View log. Not "Submit", not "OK",
  not "Get started".
- **Numbers are specific and unrounded** — "1,284,905 steps", "428 ms", "$0.0413". Precision is
  the tone. Never "lots of" or "~1.3M".
- **Empty states state a fact and one action:** "No runs in the last 24 hours." + *Trigger a run*.
  No illustrations, no encouragement.
- **Errors name the cause and the consequence**, then the recovery: "Refund exceeds the $500
  policy limit, so the step is paused. Approve manually or raise the limit."
- **Self-learning copy is always reviewable, never celebratory:** "Learned a new escalation rule
  from 42 resolved tickets." + *Review*. Never "🎉 Your agent got smarter!".
- No exclamation marks, no em-dash drama in UI strings, no emoji, no product-personality voice.

---

## Index

| Path | What |
| --- | --- |
| `styles.css` | Global entry point — `@import` list only |
| `tokens/fonts.css` | Webfont loading (Google Fonts CDN — substitution) |
| `tokens/colors.css` | Ink ramp, signal, semantic, viz + light/dark semantic aliases |
| `tokens/typography.css` | Families, size/line-height pairs, weights, tracking |
| `tokens/spacing.css` | Space scale, control heights, layout constants |
| `tokens/shape.css` | Radii, border widths, shadow system (per theme) |
| `tokens/motion.css` | Durations, easings, control transition |
| `Foundations.dc.html` | The reviewable foundations page (light/dark, hue + radius tweaks) |
| `foundations/*.html` | 17 specimen cards — Colors, Type, Spacing, Shape, Motion |
| `Agent Management.dc.html` | The product-screen layout spec — nav rail, list column, tabbed editor, dirty bar, drawer, dialog |
| `SKILL.md` | Agent Skills wrapper for use in Claude Code |

### Theming
Light is the default on `:root`. Dark is `:root[data-theme="dark"]` — semantic aliases,
semantic hue lightness, viz ramp and shadows are all re-declared, so components read only
semantic tokens and need no theme branches.

---

## Caveats + open questions

1. **Fonts are substitutions.** No brand files were provided. Instrument Sans (geometric,
   slightly warm) and IBM Plex Mono are stand-ins loaded from the Google Fonts CDN. Send real
   files and `tokens/fonts.css` becomes local `@font-face` rules with no other change.
2. **No logo or brand assets.** Nothing was drawn or invented.
3. **No components or UI kit yet** — this pass is tokens by request. The natural next set for
   this product: Button, IconButton, Input, Select, Checkbox, Switch, Card, Badge/StatusDot,
   Table, Tabs, Dialog, Popover, Toast, CodeBlock, plus an agent run-log surface.
4. **Signal hue is a live decision.** The Foundations page exposes it as a tweak (150–300°).
   195° teal is the recommendation; 245° reads more conventional-enterprise, 285° more product-y.
