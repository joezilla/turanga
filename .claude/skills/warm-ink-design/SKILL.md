---
name: warm-ink-design
description: The project's baseline design system ("Warm Ink" — an enterprise agentic-platform system). Use this skill for ALL ux/ui work — production interfaces, components, and throwaway prototypes/mocks. Contains the design rules, colors, type, spacing, shape, motion tokens, and the canonical DESIGN.md baseline that BMAD's UX agent inherits from.
user-invocable: true
---

Warm Ink is the **baseline design system for this repository**. Every UX/UI decision — production code or throwaway mock — starts here. It is wired into BMAD: the UX agent (Sally / `bmad-ux`) loads this as foundational context and anchors every `DESIGN.md` it produces on it.

## Read these first
- `DESIGN.md` — the canonical, machine-readable baseline (Google Labs design.md spec): frontmatter tokens + prose rules. This is the contract BMAD inherits.
- `readme.md` — the full design rationale: colour/type/space/shape/motion foundations, content voice, and caveats.
- `tokens/*.css` — the actual CSS custom properties. Import `styles.css` (which `@import`s all token files) into production code.
- `foundations/*.html` and `Foundations.dc.html` — reviewable specimen cards.
- `Agent Management.dc.html` — the canonical **layout** spec for the product surfaces (nav rail, list column, content header, tab bar, dirty bar, docked drawer, dialog). Read it before laying out a new screen; see DESIGN.md#Screens for the measurements.

## How to use it
- **Production code:** import `styles.css`, consume only the semantic tokens (`--bg-canvas`, `--text-primary`, `--action-primary-bg`, `--state-running`, …). They re-declare per theme, so components need no light/dark branches. Read `readme.md` to internalise the rules before designing.
- **Visual artifacts (slides, mocks, prototypes):** copy the token files out and produce self-contained static HTML the user can open.
- **The one rule that defines the system:** neutrals do the work, ink carries action, and saturated colour is reserved for what the system is *doing* (an agent running, a state changing, something needing a human). Buttons are ink, not colour.

If invoked without guidance, ask what the user wants to build, ask a few sharp questions, and act as an expert designer for this brand — outputting HTML artifacts or production code as the need dictates. Stay faithful to `DESIGN.md` and `readme.md`; both win on conflict with any mock or import.
