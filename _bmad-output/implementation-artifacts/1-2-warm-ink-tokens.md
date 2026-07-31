---
baseline_commit: 7308136292fc54e6aa712d21f0c928eb734cad41
---
# Story 1.2: Adopt the Warm Ink design system as the foundation layer

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As the builder,
I want turanga's UI built on the Warm Ink tokens from day one,
so that every surface is consistent and themable without rework.

## Acceptance Criteria

1. The Warm Ink token CSS is loaded app-wide and components consume **semantic tokens only** — colours (ink ramp, signal, semantic, agent-state), typography (Instrument Sans + IBM Plex Mono, the 11–48px scale, weights 400/500/600), spacing (4px grid + control heights + layout constants), shape (radii/borders/shadows), and motion (durations/easings). [Source: epics.md#Story-1.2 UX-DR1; DESIGN.md; warm-ink-design/tokens/*.css]
2. Switching the theme via `data-theme` on `:root` renders light **and** dark correctly, with **no per-surface theme branch** (components read semantic tokens, which re-declare under `[data-theme="dark"]`). [Source: epics.md#Story-1.2 UX-DR17; DESIGN.md#Theming]
3. Project conventions are established and documented: icons are **Lucide** via `currentColor` (UX-DR19); numbers render **mono/tabular**; the **accessibility floor** (UX-DR15) and **voice/microcopy** (UX-DR16) baselines are captured as written project conventions future stories inherit. [Source: epics.md#Story-1.2; EXPERIENCE.md#Accessibility-Floor, #Voice-and-Tone]

## Tasks / Subtasks

- [x] **Task 1: Vendor the Warm Ink tokens into the web app and load them globally** (AC: #1)
  - [x] Copy the six token files from `.claude/skills/warm-ink-design/tokens/` (`colors.css`, `typography.css`, `spacing.css`, `shape.css`, `motion.css`, and a `fonts.css` replacement — see next subtask) into `apps/web/src/lib/design/warm-ink/`. Add a header comment in each: "Vendored from the Warm Ink design system (baseline wins on conflict); re-sync from `.claude/skills/warm-ink-design/tokens/` if the baseline changes." [Source: warm-ink-design/SKILL.md — "copy assets out"]
  - [x] Replace the CDN `@import` in `fonts.css` with **local self-hosted fonts** (NFR-5 local-first): add deps `@fontsource/instrument-sans` and `@fontsource/ibm-plex-mono` (5.3.x) to `apps/web`, and import the needed weights (400/500/600) as CSS side-effect imports in `src/routes/+layout.svelte`. Keep `--font-sans`/`--font-mono` in `typography.css` unchanged (they already reference the family names). [Source: web-research below]
  - [x] Load the tokens app-wide: create `src/routes/+layout.svelte` and import each token file **explicitly** there (colors → typography → spacing → shape → motion) — NOT via a chain of CSS `@import`s (Vite `@import`-ordering gotcha; see Dev Notes). Add a minimal base layer in a small `src/app.css` (or `+layout.svelte`): CSS reset-lite, `body { background: var(--bg-canvas); color: var(--text-primary); font-family: var(--font-sans); font-size: var(--text-base); line-height: var(--lh-base); }`.
  - [x] Confirm no raw hex or ad-hoc colours are introduced anywhere — semantic tokens only (AC1). No Tailwind (deliberately — Warm Ink is the design layer).

- [x] **Task 2: Theme switching via `data-theme` with no flash-of-wrong-theme** (AC: #2)
  - [x] Add an inline script in `src/app.html` (before stylesheets) that sets `document.documentElement.dataset.theme` from `localStorage.theme` or `prefers-color-scheme` — runs before first paint to avoid FOUC. [Source: web-research below]
  - [x] Add a tiny theme module in `src/lib/theme.ts` (or a Svelte 5 rune-based helper): `toggleTheme()` / `setTheme(t)` that writes `document.documentElement.dataset.theme` + persists to `localStorage`. (Full per-user persistence is a Profile setting in a later story; localStorage is the MVP mechanism here — note it.)
  - [x] Provide a **temporary** visible theme toggle so both themes are demonstrably reachable (the permanent toggle moves to the topbar in Story 1.3 — mark it clearly as temporary).
  - [x] Verify a sample surface renders correctly in BOTH themes reading only semantic tokens (surfaces, text, borders re-declare — no component-level light/dark branch). [Source: DESIGN.md#Theming — semantic aliases + semantic hue lightness re-declared under `[data-theme="dark"]`]

- [x] **Task 3: Establish and document the UI conventions** (AC: #3)
  - [x] Add `@lucide/svelte` (1.28.x — NOTE: `lucide-svelte` is deprecated) to `apps/web`; render at least one icon using `currentColor` so it inherits the token colour (UX-DR19). No emoji, no unicode glyphs as icons.
  - [x] Establish the mono/tabular numeral convention: metrics/IDs/costs use `--font-mono` with `font-variant-numeric: tabular-nums` (a small `.mono-num` utility or documented pattern). Apply it to the control-status/version readout on the landing page.
  - [x] **Create `project-context.md`** at the repo root (or `docs/`) capturing the durable UI conventions so EVERY future story inherits them (this file is auto-loaded via the workflows' `persistent_facts` glob `**/project-context.md`). Include: consume semantic tokens only; light+dark via `data-theme` (no branches); Lucide `currentColor` icons, no emoji; mono/tabular numbers; the **Accessibility floor** (keyboard-reachable + always-visible focus ring, status never colour-only, WCAG AA body text, persistent form labels + associated errors, mono metric ≥12px — UX-DR15); the **Voice/microcopy** rules (sentence case, verb-first buttons — Activate/Run test/Connect, second person for user/third for agent, unrounded numbers, errors cause→consequence→recovery, no exclamation/emoji, state stated-not-celebrated — UX-DR16). [Source: EXPERIENCE.md#Accessibility-Floor, #Voice-and-Tone; DESIGN.md]

- [x] **Task 4: Re-skin the landing page on tokens + verify (no regressions)** (AC: #1, #2, #3)
  - [x] Update `src/routes/+page.svelte` to render on Warm Ink tokens — a canvas background, the product name in Instrument Sans Medium (no logo, per DESIGN.md), the control-plane connectivity readout in mono/tabular, a Lucide status icon, and the temporary theme toggle. Keep it minimal — this is NOT the app shell (Story 1.3) or any feature UI.
  - [x] **Preserve the Story 1.1 behavior:** the page must still fetch control-api `/health` and show connected/unreachable (do not break the existing control-plane connectivity or its Playwright test).
  - [x] Tests: extend the Playwright e2e — assert (a) the page renders and still reports control-plane status (regression), (b) toggling the theme flips `document.documentElement[data-theme]` and the computed `body` background-color **changes** between light and dark (proves tokens + theme wiring), (c) a Lucide `<svg>` icon is present. `svelte-check` clean, `pnpm -r build` + `pnpm lint` clean.

## Dev Notes

**Scope: the design *foundation* only. Load tokens, wire theming, set conventions, re-skin the one landing page as proof. Do NOT build the app shell (sidebar/topbar — Story 1.3), auth (1.4), or any feature surface. Keep it minimal and token-pure.**

### Architecture / design-system constraints
- **NFR-6 (visual identity):** all UI conforms to Warm Ink; status never colour-only; numbers mono/tabular. This story lays the substrate that makes NFR-6 automatic downstream. [Source: prd.md NFR-6; ARCHITECTURE-SPINE.md Conventions]
- **The one rule:** neutrals do the work, ink carries action, saturated colour is reserved for agent/connection *state*. Primary actions are **ink, not colour** (`--action-primary-bg`). Consume semantic aliases (`--bg-canvas`, `--surface-card`, `--text-primary`, `--action-primary-bg`, `--state-running`, …) — never raw ramp steps or hex. [Source: DESIGN.md#Brand-Style, #Colors; warm-ink-design/readme.md]
- **Theming contract:** light is default on `:root`; dark is `:root[data-theme="dark"]` and re-declares semantic aliases + semantic hue lightness + viz + shadows, so components read only semantic tokens and need **no theme branches**. This is why AC2's "no per-surface branch" is achievable. [Source: DESIGN.md#Theming; warm-ink-design/tokens/colors.css]
- **Token inventory** (already authored — copy, don't reinvent): `colors.css` (ink 0–1000, signal, semantic, agent-state aliases, viz, light+dark), `typography.css` (families, `--text-2xs…5xl` + line-heights, weights 400/500/600, tracking, `--numeric-tabular`), `spacing.css` (4px grid, control heights, sidebar/topbar/content constants), `shape.css` (radii, border widths, shadows per theme), `motion.css` (durations, easings, `--transition-control`). [Source: warm-ink-design/tokens/*.css]

### Previous-story intelligence (Story 1.1 — verified patterns)
- Web app is **SvelteKit 2.69 / Svelte 5 runes** (`$state`, `$effect`), `adapter-node`. `src/routes/+page.svelte` exists and fetches control-api `/health`; **there is no `+layout.svelte` yet** — this story adds it (the global-style entry point). `src/app.html` is minimal.
- **pnpm + Vite hoisting** was handled via root `.npmrc` `public-hoist-pattern[]=*vite*/*svelte*`. New deps (`@lucide/svelte`, `@fontsource/*`) go in `apps/web/package.json`; if a resolution error appears, extend the hoist patterns (don't fight it globally).
- **eslint** ignores `dist/build/.svelte-kit/.claude/node_modules/_bmad*`. Root `package.json` is `type: module`.
- **No Tailwind** was installed on purpose in 1.1 — Warm Ink is the design layer, and it lands *here*.
- **Regression to protect:** the control-plane connectivity readout and its Playwright test (`apps/web/tests/health.spec.ts`) must keep passing. The e2e runs a dev server on `:5173` (the control-api CORS-allowed origin) against a running compose stack.
- Story 1.1 seeded conventions in `packages/domain` (ULID, `Money` as minor units); reuse those, don't duplicate.

### Verified toolchain (web-checked 2026-07-31 — re-verify before bumping)
- **Icons:** `@lucide/svelte` **1.28.x** (peer `svelte ^5`, runes-compatible). `lucide-svelte` is **deprecated** — do not use it. Usage: `import { Menu } from '@lucide/svelte'` → `<Menu size={20} color="currentColor" />`. [Source: npmjs.com/package/@lucide/svelte; lucide.dev/guide/installation]
- **Fonts:** `@fontsource/instrument-sans` + `@fontsource/ibm-plex-mono` **5.3.x** (self-hosted, no runtime CDN). Import weight CSS as side effects in `src/routes/+layout.svelte` (a `.svelte` file, NOT `+layout.ts`): `import '@fontsource/instrument-sans/400.css'` (+ `/500.css`, `/600.css`) and the same for `ibm-plex-mono`. [Source: fontsource.org/docs/guides/svelte]
- **Global CSS gotcha:** plain CSS `@import` must precede all other rules or Vite drops it, and nested `@import` ordering can surprise. **Prefer importing each token `.css` explicitly in `+layout.svelte`** over a single file that `@import`s the others. `@import` inside a Svelte `<style>` block is unreliable — keep tokens in real `.css` files. [Source: Fontsource/SvelteKit docs; Vite CSS handling]
- **Theme FOUC:** SvelteKit has no built-in theme primitive; the going 2026 pattern is an **inline script in `app.html`** (before stylesheets) that sets `document.documentElement.dataset.theme` from `localStorage`/`prefers-color-scheme`. (A cookie + `hooks.server.ts` `transformPageChunk` gives zero-flicker SSR — note as a later hardening, not required now.) [Source: scottspence.com, scriptraccoon.dev]

### Testing standards
- **svelte-check** clean; `pnpm -r build` + `pnpm lint` clean.
- **Playwright** (extends `apps/web/tests/health.spec.ts` or a new spec): control-plane readout still works (regression); theme toggle flips `data-theme` and changes the computed `body` background between light/dark; a Lucide `<svg>` renders. The e2e needs the compose stack up (control-api :8080) and the dev server on :5173.
- Keep unit tests green across the workspace (no changes expected to `packages/*` or the other apps).
- **DoD:** tokens loaded app-wide + consumed semantically; both themes render with no per-surface branch; Lucide/mono/a11y/voice conventions in place and `project-context.md` written; landing page re-skinned; no regressions; only permitted story sections modified.

### Project Structure Notes
- New files land under `apps/web/` (`src/lib/design/warm-ink/*.css`, `src/routes/+layout.svelte`, `src/lib/theme.ts`, maybe `src/app.css`) plus the root `project-context.md`. No changes to the other apps/packages or the architecture. This matches the spine (web owns the UI layer). [Source: ARCHITECTURE-SPINE.md#Structural-Seed]
- The Warm Ink tokens are **vendored** (copied) into the web app rather than imported across the `.claude/` boundary — deliberate, per the design-system's own "copy assets out" guidance, and it keeps the app self-contained. If the baseline changes, re-sync.

### References
- [Source: _bmad-output/planning-artifacts/epics.md#Epic-1 / Story-1.2; UX-DR1, UX-DR15, UX-DR16, UX-DR17, UX-DR19]
- [Source: _bmad-output/planning-artifacts/ux-designs/ux-turanga-2026-07-30/DESIGN.md (#Brand-Style, #Colors, #Typography, #Theming, Do's-and-Don'ts) + EXPERIENCE.md (#Accessibility-Floor, #Voice-and-Tone, #Interaction-Primitives)]
- [Source: .claude/skills/warm-ink-design/ — tokens/*.css, styles.css, readme.md, SKILL.md]
- [Source: _bmad-output/planning-artifacts/architecture/architecture-turanga-2026-07-31/ARCHITECTURE-SPINE.md — Stack (SvelteKit), Consistency-Conventions, NFR-6]
- [Source: _bmad-output/implementation-artifacts/1-1-scaffold-monorepo.md — previous-story patterns, regression surface]

## Dev Agent Record

### Agent Model Used

claude-opus-4-8 (Amelia / dev-story)

### Debug Log References

- None blocking. Followed the create-story guidance to avoid the known traps: used `@lucide/svelte` (not the deprecated `lucide-svelte`), self-hosted fonts via `@fontsource/*`, and imported token CSS explicitly in `+layout.svelte` rather than via chained `@import` (Vite ordering).

### Completion Notes List

- **AC1 met:** the five Warm Ink token files (colors, typography, spacing, shape, motion) vendored into `apps/web/src/lib/design/warm-ink/` (with re-sync header) and loaded app-wide via explicit imports in a new `src/routes/+layout.svelte`. Fonts self-hosted with `@fontsource/instrument-sans` + `@fontsource/ibm-plex-mono` (400/500/600) — no CDN (NFR-5). Base layer (`src/app.css`) puts `body` on `--bg-canvas`/`--text-primary`/`--font-sans`. All styling consumes semantic tokens only; no raw hex, no Tailwind.
- **AC2 met (verified live):** FOUC-safe inline theme script in `app.html` sets `data-theme` before paint; `src/lib/theme.ts` toggles + persists to localStorage. Playwright proves toggling flips `html[data-theme]` and **changes the computed body background** light↔dark — with zero per-surface theme branches (semantic aliases re-declare under `[data-theme="dark"]`).
- **AC3 met:** `@lucide/svelte` icons render via `currentColor` (Circle status dot + Sun/Moon toggle); mono/tabular numerals via `.mono-num` / `--font-mono` on the status readout; **`project-context.md`** written at repo root capturing tokens/theme/icon/number conventions + the accessibility floor + voice rules — auto-loaded by future dev/story runs via `persistent_facts`.
- **Regression protected:** the landing page still fetches control-api `/health` and reports connectivity; the Story 1.1 e2e was extended (not replaced) and passes.
- **Verification:** `svelte-check` 0 errors · `pnpm -r build` 6/6 · `pnpm -r test` (unit) green · `pnpm lint` clean · Playwright 2/2 passed against the live compose stack.
- **Scope held:** no app shell (Story 1.3), no auth (1.4). The theme toggle is temporary (fixed top-right) and explicitly moves to the topbar in 1.3.

### File List

**apps/web (new):** `src/routes/+layout.svelte`, `src/app.css`, `src/lib/theme.ts`, `src/lib/design/warm-ink/{colors,typography,spacing,shape,motion}.css`
**apps/web (modified):** `src/app.html`, `src/routes/+page.svelte`, `tests/health.spec.ts`, `package.json`
**Root (new):** `project-context.md`
**Root (modified):** `pnpm-lock.yaml`

### Change Log

- 2026-07-31 — Adopted the Warm Ink design system as the web app's foundation: vendored token CSS + self-hosted fonts loaded via `+layout.svelte`, FOUC-safe `data-theme` theming (`theme.ts` + `app.html` script), Lucide/`currentColor` icons + mono/tabular numerals, and a root `project-context.md` capturing the durable UI/a11y/voice conventions. Landing page re-skinned on tokens; Story 1.1 connectivity preserved. Verified via svelte-check, build, lint, and 2 Playwright e2e (regression + theme). Status → review.
