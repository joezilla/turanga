---
name: Warm Ink
description: Baseline design system for this repository — an enterprise, foundation-first system for an agentic SaaS platform where users define agents, run operations, build workflows, and supervise self-learning behaviour. Neutrals do the work; ink carries action; saturated colour is reserved for what the system is doing.
status: final
# Source of truth for exact values is tokens/colors.css (oklch-native). The hex
# below are sRGB approximations of those oklch tokens for tooling that needs hex.
# Consume the CSS custom properties (semantic aliases) in code, not these literals.
colors:
  # Warm-ink neutral ramp — 15 steps, hue 50–80, chroma 0.004–0.010. Never #000, never a hue-less grey.
  ink-0: '#FFFFFF'
  ink-25: '#FDFCF9'
  ink-50: '#F9F7F4'
  ink-100: '#F3F1EE'
  ink-150: '#EDEAE6'
  ink-200: '#E5E2DF'
  ink-300: '#D5D1CD'
  ink-400: '#AFAAA6'
  ink-500: '#8B8681'
  ink-600: '#6B6561'
  ink-700: '#4F4A46'
  ink-800: '#36312E'
  ink-900: '#231F1C'
  ink-950: '#15110F'
  ink-1000: '#0B0807'
  # Signal — the single chromatic brand hue (cold teal, 195°). The only colour that means "the system is doing something."
  signal-100: '#E3F4F4'
  signal-300: '#91C6C5'
  signal-500: '#207070'
  signal-600: '#0C5859'
  # Semantic — matched L/C bands; hue is the only variable so no state out-shouts another. -500 for dots/icons, -100 for row tints.
  positive-500: '#39784D'
  caution-500: '#C48C3F'
  critical-500: '#B0423B'
  info-500: '#3B6E97'
  # Data viz — one lightness, one chroma, six hues; order-independent.
  viz-1: '#138282'
  viz-2: '#4077A3'
  viz-3: '#6F69A3'
  viz-4: '#A05C57'
  viz-5: '#A17740'
  viz-6: '#468157'
  # --- Light semantic aliases (what components actually consume) ---
  bg-canvas: '#F9F7F4'        # {colors.ink-50}
  surface-card: '#FFFFFF'     # {colors.ink-0}
  text-primary: '#231F1C'     # {colors.ink-900}
  text-secondary: '#4F4A46'   # {colors.ink-700}
  text-tertiary: '#8B8681'    # {colors.ink-500}
  text-link: '#0C5859'        # {colors.signal-600}
  action-primary-bg: '#231F1C'   # {colors.ink-900} — buttons are ink, not colour
  action-primary-fg: '#FDFCF9'   # {colors.ink-25}
  # --- Dark-mode counterparts (kebab -dark; the CSS re-declares these under [data-theme=dark]) ---
  bg-canvas-dark: '#0E0C0A'
  surface-card-dark: '#161311'
  surface-raised-dark: '#1C1916'
  text-primary-dark: '#F1F0ED'
  text-secondary-dark: '#C0BDBA'
  text-link-dark: '#91C6C5'      # {colors.signal-300}
  action-primary-bg-dark: '#FDFCF9'  # ink is inverted in dark: near-white surface, ink text
  action-primary-fg-dark: '#15110F'
typography:
  # Instrument Sans for everything human; IBM Plex Mono for everything machine (IDs, latency, cost, timestamps, diffs).
  # Both are substitutions loaded from Google Fonts — swap for local @font-face when real brand files arrive.
  display:
    fontFamily: 'Instrument Sans'
    fontSize: 48px
    fontWeight: '600'
    lineHeight: 54px
    letterSpacing: -0.022em
  heading:
    fontFamily: 'Instrument Sans'
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
    letterSpacing: -0.012em
  body:
    fontFamily: 'Instrument Sans'
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 22px
    letterSpacing: 0em
  body-dense:
    fontFamily: 'Instrument Sans'
    fontSize: 13px
    fontWeight: '400'
    lineHeight: 20px
  label-micro:
    fontFamily: 'Instrument Sans'
    fontSize: 11px
    fontWeight: '500'
    lineHeight: 16px
    letterSpacing: 0.075em   # uppercase, tracked micro-caps — the only uppercase in the system
  mono:
    fontFamily: 'IBM Plex Mono'
    fontSize: 13px
    fontWeight: '400'
    lineHeight: 20px
    note: 'Always tabular-nums so table columns never dance. Used for every number, ID, latency, cost, timestamp, diff, config.'
rounded:
  # Small, near-mechanical radii. 4px is the default control corner.
  xs: 2px
  sm: 3px
  md: 4px
  lg: 6px
  xl: 8px
  '2xl': 12px
  full: 9999px   # reserved for live status chips only — so the pill keeps meaning
  DEFAULT: 4px
spacing:
  # 4px grid with 2px/6px half-steps.
  '0-5': 2px
  '1': 4px
  '1-5': 6px
  '2': 8px
  '3': 12px
  '4': 16px
  '5': 20px
  '6': 24px
  '8': 32px
  '10': 40px
  '12': 48px
  '16': 64px
  control-h-sm: 26px
  control-h-md: 32px
  control-h-lg: 38px
  row-h: 40px
  sidebar-w: 248px
  topbar-h: 48px
  content-max: 1240px
  page-margin: 56px
components:
  button-primary:
    background: '{colors.action-primary-bg}'
    foreground: '{colors.action-primary-fg}'
    radius: '{rounded.md}'
    height: '{spacing.control-h-md}'
    note: 'Ink, not colour. Hover = one surface step darker. No transform, no scale.'
  button-secondary:
    background: '{colors.surface-card}'
    foreground: '{colors.text-primary}'
    border: '1px solid var(--border-strong)'
    radius: '{rounded.md}'
  status-dot:
    shape: '6–7px dot + a word (idle | running | succeeded | review | failed)'
    running: 'var(--state-running) with a 1600ms opacity pulse — the ONLY looping animation in the product'
    note: 'No coloured pill badges. The dot + word is the entire status vocabulary.'
  card:
    background: '{colors.surface-card}'
    border: '1px solid var(--border-subtle)'
    radius: '{rounded.lg}'
    shadow: 'var(--shadow-sm)'
    note: 'Never a coloured left border.'
  table-row:
    height: '{spacing.row-h}'
    separator: 'var(--border-hairline)'
    numerals: '{typography.mono}'
  focus-ring:
    value: 'var(--focus-ring) — 2px canvas gap + 4px teal ring at 55%. Always visible; never removed.'
---

## Brand & Style

Warm Ink is a foundation-first design system for an enterprise agentic platform — a product where engineers, analysts, ops, finance/risk, admins, and execs all read the same screens with six different tolerances for density. The aesthetic posture is **restraint as a feature**: warm-ink neutrals that read like paper stock and warm charcoal, a near-black ink primary, geometric sans, small mechanical corners, and light and dark treated as equals.

The idea in one line: **neutrals do the work, ink carries action, and colour is reserved for what the system is doing.** On any screen the only saturated pixels mean an agent is running, learned something, or needs a human. That single rule is what separates this from default-template design — generated apps put a saturated brand colour on every primary button, then have nothing left to say when something is actually happening.

## Colors

- **Neutrals (`{colors.ink-0}` … `{colors.ink-1000}`, 15 steps)** carry a whisper of warm chroma (hue 50–80, chroma 0.004–0.010), tapering at both ends so extremes never muddy. Canvas reads as paper; dark mode reads as warm charcoal. **Never use pure `#000` or a hue-less grey.**
- **Primary action = `{colors.ink-900}`** (light) / `{colors.ink-25}` (dark). Buttons, active nav, key affordances are ink, not colour.
- **Signal teal (`{colors.signal-500}`, hue 195°)** is the single chromatic brand hue, deliberately cold against the warm neutrals. Reserved for focus rings, links, running agents, and selection. **Never a full button surface.**
- **Semantic** — positive 152°, caution 72°, critical 27°, info 245°. All share a lightness/chroma band; hue is the only variable, so no state out-shouts another. Use `-500` for dots and icons, `-100` for row tints. **Text on a tint is always ink, never the hue.**
- **Agent lifecycle** — `idle | running | succeeded | review | failed`, rendered as a 6–7px dot plus a word. No coloured pill badges.
- **Data viz (`{colors.viz-1}` … `{colors.viz-6}`)** — one lightness, one chroma, six hues; order-independent.
- **Backgrounds are flat colour only.** No gradients, no mesh, no imagery behind UI. Depth comes from surface lightness steps (canvas → card → raised) and hairlines.

Consume the **semantic aliases** (`--bg-canvas`, `--surface-card`, `--text-primary`, `--action-primary-bg`, `--state-running`, …) rather than raw ramp steps — they re-declare per theme, so components need no light/dark branches.

## Typography

- **Instrument Sans** for everything human; **IBM Plex Mono** for everything machine — IDs, latency, cost, token spend, timestamps, diffs, config. Mono is always `tabular-nums` so table columns never dance. *(Both are substitutions — send real brand files and only `tokens/fonts.css` changes.)*
- Scale runs 11 → 48px with paired line-heights. **14px base UI**, 13px for dense tables, **11px tracked micro-caps (0.075em, uppercase)** for every column and section label.
- Tracking tightens as size grows: -0.022em display, -0.012em headings, 0 body.
- **Three weights only: 400 / 500 / 600. No 700 anywhere.** Emphasis comes from 500 + colour.
- Prose measure caps near 62ch; italics are essentially unused.

## Layout & Spacing

4px grid with 2px/6px half-steps: 8px inside controls, 12–16px inside cards, 24–32px between regions, 56px page margins. Control heights 26/32/38px; table rows 40px. Sidebar 248px, top bar 48px, content max 1240px.

## Screens

`Agent Management.dc.html` is the canonical **layout** reference for the product surfaces — the foundations files
cover tokens and components; this file covers how they assemble. Read it before laying out a new screen. Its
inline `style=` attributes are a spec, not code to paste: translate them into scoped styles that consume the same
token names.

The workspace chrome it fixes:

| Region | Spec |
|---|---|
| Nav rail | 52px, `--bg-sunken`, `--border-hairline` right edge. 26px wordmark tile, 30px icon buttons, spacer, theme toggle, avatar. |
| List column | 264px, `--bg-sunken`. 48px header (title + one action), search below it, scrolling rows, micro-caps footer count. |
| Content header | 48px on `--surface-card`, `--border-hairline` bottom. Title, mono id, status pill, mono version, then actions right-aligned. |
| Tab bar | Directly under the header on `--surface-card`; per-tab mono count, `--caution-500` 4px dot for unsaved change. |
| Content pane | `24px 28px` padding, `max-width: 720px` for forms / `860px` for list-and-detail, 96px bottom gutter to clear the dirty bar. |
| Dirty bar | Sticky bottom, `--surface-raised` + `--shadow-lg`, caution dot + label left, Discard/Save right. |
| Docked drawer | 420px, `--bg-sunken`, `--border-subtle` left edge, `--shadow-lg`. |
| Dialog | 480px, `--surface-card`, `{rounded.xl}`, `--shadow-lg`, scrim `--ink-1000` at 55%. |

Micro-caps section labels (`--font-mono`, 10px, `--tracking-micro`, uppercase, `--text-tertiary`) separate regions
inside a pane — they replace headings below the pane title.

## Elevation & Depth

Separation is **hairlines first**: `--border-hairline` (10% alpha, tables/rows), `--border-subtle` (14%, cards), `--border-strong` (26%, inputs/secondary buttons). Alpha-based, so borders sit correctly on any surface in either theme. Shadows are **warm-tinted** (ink hue, not black) and near-invisible: `xs/sm` for cards; `md/lg` **only** for things that genuinely float — popovers, dialogs, command palette. Transparency/blur is used only for scrim (`ink-1000` at 40%) and sticky-header protection — never frosted glass as decoration.

## Shapes

Radii `{rounded.xs}` 2 / `{rounded.sm}` 3 / `{rounded.md}` 4 / `{rounded.lg}` 6 / `{rounded.xl}` 8 / `{rounded.2xl}` 12px. **4px is the default control corner.** Pill (`{rounded.full}`) is reserved for live status chips so it keeps meaning. Cards: 1px subtle border + `--shadow-sm` + 6px radius, never a coloured left border.

## Components

- **Button (primary)** — ink fill (`{colors.action-primary-bg}`), `{colors.action-primary-fg}` text, `{rounded.md}` corner, `{spacing.control-h-md}` height. Hover = one surface step darker; press = one more; no transform, no scale-in.
- **Button (secondary / ghost)** — surface fill with `--border-strong` (secondary) or borderless ink text (ghost).
- **Status dot** — 6–7px dot + a word for agent lifecycle. `running` pulses opacity over 1600ms; that scarcity is what makes it legible. No coloured pills.
- **Card** — `{colors.surface-card}` on `--border-subtle`, `{rounded.lg}`, `--shadow-sm`.
- **Table** — 40px rows, `--border-hairline` separators, all numerals in `{typography.mono}` tabular.
- **Focus ring** — 2px canvas gap + 4px teal ring at 55%, always visible. Never removed; disabled uses `--text-disabled`, never 50% opacity on a whole control.

Icons: **Lucide** (1.5px stroke, 16/20px, `currentColor`). No emoji, ever. No unicode glyphs as icons. **No logo exists in this system** — render the product name in Instrument Sans Medium wherever a mark would go.

### Content voice (applies to all UI copy)
Sentence case everywhere; second person for the user, third for the agent; verb-first buttons (Deploy, Roll back, Approve rule — not "Submit"/"OK"). Numbers are specific and unrounded ("428 ms", "$0.0413"). Empty states state a fact + one action. Errors name cause, consequence, then recovery. Self-learning copy is reviewable, never celebratory. No exclamation marks, no emoji, no product-personality voice.

## Do's and Don'ts

| Do | Don't |
|---|---|
| Consume semantic tokens (`--bg-canvas`, `--state-running`, …) | Hardcode ramp steps or hex; skip light/dark branching — tokens handle it |
| Make primary actions ink (`{colors.ink-900}` / `{colors.ink-25}`) | Put a saturated brand colour on primary buttons |
| Reserve signal teal for focus, links, running, selection | Use signal as a full button surface or decoration |
| Use colour only for agent state / semantic meaning | Let two states out-shout each other; use coloured pill badges |
| Flat backgrounds; depth via surface steps + hairlines | Gradients, mesh, imagery behind UI, frosted glass |
| 4px default corner; pill only for live status chips | Large or inconsistent radii; pills for generic chrome |
| Weights 400/500/600; emphasis via 500 + colour | Any 700 weight; uppercase outside 11px micro-caps |
| Mono + tabular for every number | Proportional numerals in tables |
| Lucide icons, `currentColor` | Emoji or unicode glyphs as icons |

---

*Exact token values live in `tokens/colors.css` (oklch-native) and the sibling `tokens/*.css`; import `styles.css` to load them all. The hex in this file's frontmatter are sRGB approximations for tooling. This DESIGN.md is the repository's canonical UX baseline — BMAD's UX agent (`bmad-ux`) inherits from it, and it wins on conflict with any mock or import.*
