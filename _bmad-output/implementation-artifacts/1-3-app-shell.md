---
baseline_commit: 138c61327a01b443235b94340f44b44b4a3c6dbe
---
# Story 1.3: App shell — sidebar, topbar, content, theme toggle

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As the builder,
I want a consistent shell to navigate turanga,
so that I can move between Agents and Settings from anywhere.

## Acceptance Criteria

1. The authenticated app renders a shell: a **248px left sidebar** (nav: Agents, Settings; the active item uses `--surface-selected`; collapsible), a **48px topbar** (workspace name left; theme toggle + account menu right), and a **max-1240px content area**. [Source: epics.md#Story-1.3 UX-DR2; EXPERIENCE.md#Information-Architecture; DESIGN.md#Layout-Spacing]
2. The theme toggle (now in the topbar) **persists across reloads**. [Source: epics.md#Story-1.3 UX-DR17]
3. The Agents and Settings routes resolve (placeholder content is fine) and every interactive element (nav links, toggle, account button) shows the visible Warm Ink **focus ring**. [Source: epics.md#Story-1.3 UX-DR15; project-context.md]

## Tasks / Subtasks

- [x] **Task 1: Build the app-shell layout** (AC: #1)
  - [x] Create a route group layout `src/routes/(app)/+layout.svelte` = the shell. Route groups don't affect the URL; the root `+layout.svelte` (global tokens/fonts/base CSS from Story 1.2) still wraps it — do NOT re-import global CSS here. Render children with `{@render children()}`.
  - [x] **Sidebar** (`--sidebar-w` = 248px): nav items **Agents** and **Settings** as `<a href>` (not clickable divs — a11y), each with a Lucide icon (`currentColor`) + label. Active item detected via `import { page } from '$app/state'` (NOT `$app/stores` — deprecated) → `page.url.pathname`; mark active with `aria-current="page"` and background `--surface-selected` (no coloured indicator). Include a **collapse toggle** that narrows the sidebar to icons-only (persist collapsed state in `localStorage`, same pattern as theme). [Source: web-research below; DESIGN.md#components.settings-nav grammar]
  - [x] **Topbar** (`--topbar-h` = 48px): workspace name "turanga" (Instrument Sans Medium) on the left; on the right the control-plane status indicator (Task 4), the theme toggle (Task 3), and an **account-menu button** placeholder (Lucide user icon `<button>`, no dropdown behavior yet — auth/profile is Story 1.4). Separate topbar from content with a `--border-subtle` hairline.
  - [x] **Content area**: `max-width: var(--content-max)` (1240px), centered, padded; sits to the right of the sidebar and below the topbar. Use tokens for all spacing/surfaces/borders — semantic tokens only, no raw hex.

- [x] **Task 2: Routes + index redirect** (AC: #1, #3)
  - [x] Create `src/routes/(app)/agents/+page.svelte` — placeholder Agents surface: an `<h1>` "Agents" and the empty-state copy "No agents yet." (the *Create agent* action + real list are Story 3.1 — do NOT wire them here). [Source: EXPERIENCE.md#Voice — empty state = fact + action]
  - [x] Create `src/routes/(app)/settings/+page.svelte` — placeholder Settings surface: an `<h1>` "Settings" (the sub-nav + real sections are Epic 2 — placeholder only).
  - [x] Redirect the index: create `src/routes/+page.ts` with `import { redirect } from '@sveltejs/kit'; export function load() { redirect(307, '/agents'); }` (SvelteKit 2 — **call** `redirect`, don't `throw`). **Delete the old `src/routes/+page.svelte`** (its landing content + temporary theme toggle + control-plane readout move into the shell). [Source: web-research below]
  - [x] Confirm `/`, `/agents`, `/settings` all resolve and the correct sidebar item highlights on each.

- [x] **Task 3: Theme toggle graduates to the topbar with persistence** (AC: #2)
  - [x] Move the theme toggle into the topbar (Sun/Moon Lucide `currentColor`, `aria-label`), driven by the existing `src/lib/theme.ts` (`toggleTheme`/`getTheme`). Remove the temporary fixed-position toggle from Story 1.2.
  - [x] Persistence already exists (`theme.ts` writes `localStorage`, `app.html` inline script reads it before paint). Verify: set dark, reload → still dark (no flash). Do not add a second persistence mechanism.

- [x] **Task 4: Preserve control-plane connectivity + tests** (AC: #1, #3, regression)
  - [x] Move the control-plane connectivity readout into the topbar as a small **status dot + word** (`data-testid="control-status"`, text "control plane: {status}", mono/tabular). Keep the `fetch(control-api /health)` behavior from Stories 1.1–1.2 so the connectivity check and its test survive. Status is never colour-only (dot + word). [Source: project-context.md; Story 1.1/1.2]
  - [x] Update the Playwright e2e (`apps/web/tests/health.spec.ts`): navigate to `/` (redirects to `/agents`); assert the shell renders (sidebar has Agents + Settings links, topbar present); the active nav item highlights on `/agents`; clicking **Settings** navigates to `/settings` and moves the active state; the **control-plane status** still reads "connected" (regression); the **theme toggle persists across reload** (toggle to dark → `page.reload()` → `html[data-theme]` still `dark`). Keep the existing theme-changes-background assertion.
  - [x] `svelte-check` clean (mind Svelte 5 a11y warnings — `<a>` for nav, `<button>` for actions), `pnpm -r build` + `pnpm lint` clean.

## Dev Notes

**Scope: the navigation shell only. Real Agents/Settings content is later stories (3.x, Epic 2) — placeholders here. Keep it token-pure and minimal. This shell will wrap the authenticated app; Login (Story 1.4) lives OUTSIDE it, so putting the shell in a `(app)` route group now makes room for that split.**

### Architecture / design constraints
- **App-shell layout** (EXPERIENCE.md#Information-Architecture): left sidebar 248px (nav Agents, Settings; collapsible; selected uses `--surface-selected`, no coloured indicator), topbar 48px (workspace name left; theme toggle + account menu right), content max 1240px. Layout constants are already tokens: `--sidebar-w`, `--topbar-h`, `--content-max` (in `warm-ink/spacing.css`). [Source: DESIGN.md#Layout-Spacing; warm-ink/spacing.css]
- **Conventions (project-context.md, auto-loaded):** semantic tokens only; light+dark via `data-theme` (no per-surface branch); Lucide `currentColor` icons, no emoji; mono/tabular numbers; visible focus ring on every interactive element; status never colour-only; verb-first, sentence-case copy.
- **No feature logic:** the account menu is a placeholder button (Story 1.4 wires auth/profile); the Settings sub-nav and Agents list are later. Don't build them.
- **Single authenticated surface** (ARCHITECTURE-SPINE Conventions/Auth): the `(app)` group is where authenticated routes live; a later story adds the auth guard. For now the shell renders unauthenticated (no guard yet) — that's expected at this point in Epic 1.

### Previous-story intelligence (Stories 1.1–1.2 — verified patterns)
- **Root `src/routes/+layout.svelte`** already loads fonts + the five Warm Ink token files + `app.css` (base layer, focus-ring rule, `.mono-num`). The `(app)` layout **nests under it** — global CSS applies automatically; do not re-import. Keep the root layout's `{@render children()}` intact or the group won't render.
- **`src/lib/theme.ts`** = `getTheme()/setTheme()/toggleTheme()` (localStorage-backed); **`app.html`** has the FOUC inline script. Reuse both for the permanent topbar toggle — no new theme machinery.
- **`src/routes/+page.svelte`** currently holds the landing (control-plane readout + temporary theme toggle). Story 1.3 **replaces** it: `/` becomes a redirect (`+page.ts`), and the readout + toggle move into the shell topbar. Update the e2e accordingly (it currently visits `/`).
- **Regression to protect:** the control-plane connectivity check (`fetch` to control-api `/health`, `data-testid="control-status"`) and the theme-toggle-changes-background assertion. Both must keep passing — carried into the topbar.
- **Icons:** `@lucide/svelte` (1.28.x) already installed. Suggested icons: `Bot`/`LayoutGrid` (Agents), `Settings` (Settings), `PanelLeft` (collapse), `Sun`/`Moon` (theme), `User` (account), `Circle` (status dot).
- **Verified green harness:** `svelte-check`, `pnpm -r build`, `pnpm lint`, Playwright on dev :5173 vs compose control-api :8080. pnpm+Vite hoist handled in `.npmrc`.

### Verified toolchain (web-checked 2026-07-31)
- **Active route:** `import { page } from '$app/state'` (rune; **no `$` prefix**) → `page.url.pathname`. `$app/stores` is **deprecated** (removal in SvelteKit 3) — do not use it. Highlight active link with `aria-current="page"` + a `--surface-selected` style. Derive with `$derived(page.url.pathname)` if needed (never legacy `$:`). [Source: svelte.dev/docs/kit/$app-state]
- **Route groups + nested layout:** `src/routes/(app)/+layout.svelte` wraps children without changing the URL; render via `{@render children()}` (Svelte 5 snippet). [Source: SvelteKit routing docs]
- **Index redirect:** `src/routes/+page.ts` → `import { redirect } from '@sveltejs/kit'; export function load(){ redirect(307, '/agents'); }` — **call**, don't throw (307 temporary). [Source: svelte.dev/tutorial/kit/redirects]
- **a11y lint (Svelte 5):** use `<a href>` for navigation and `<button>` for actions (keyboard-accessible for free); Svelte 5 event syntax is `onclick` (not `on:click`). Avoid `<div onclick>` (triggers `a11y_no_static_element_interactions`). [Source: svelte.dev/docs/accessibility-warnings]

### Testing standards
- **Playwright** (extend `apps/web/tests/health.spec.ts`): shell renders (sidebar Agents+Settings, topbar); active-nav highlight on `/agents`; navigate to Settings updates active state + URL; control-plane status "connected" (regression); theme persists across `page.reload()`; theme toggle still changes body background. Requires compose stack (control-api :8080) + dev server :5173.
- `svelte-check` 0 errors/0 a11y warnings; `pnpm -r build` 6/6; `pnpm lint` clean; existing unit tests untouched/green.
- **DoD:** shell matches the 248/48/1240 spec on tokens; active nav via `--surface-selected`; theme persists; routes resolve; focus ring visible; regression intact; only permitted story sections modified.

### Project Structure Notes
- New: `src/routes/(app)/+layout.svelte`, `src/routes/(app)/agents/+page.svelte`, `src/routes/(app)/settings/+page.svelte`, `src/routes/+page.ts`; likely small shell subcomponents in `src/lib/components/` (e.g. `Sidebar.svelte`, `Topbar.svelte`, `NavItem.svelte`) — optional but clean. Removed: `src/routes/+page.svelte`. No changes to other apps/packages or the architecture. [Source: ARCHITECTURE-SPINE.md#Structural-Seed — web owns the UI layer]
- The `(app)` route group is deliberate: it isolates the authenticated shell so Story 1.4's Login can sit outside it and a later auth guard can attach to the group.

### References
- [Source: _bmad-output/planning-artifacts/epics.md#Epic-1 / Story-1.3; UX-DR2, UX-DR15, UX-DR17]
- [Source: _bmad-output/planning-artifacts/ux-designs/ux-turanga-2026-07-30/EXPERIENCE.md (#Information-Architecture) + DESIGN.md (#Layout-Spacing, components.settings-nav)]
- [Source: project-context.md — UI/a11y/voice conventions]
- [Source: _bmad-output/implementation-artifacts/1-2-warm-ink-tokens.md + 1-1-scaffold-monorepo.md — layout/theme/regression patterns]
- [Source: _bmad-output/planning-artifacts/architecture/architecture-turanga-2026-07-31/ARCHITECTURE-SPINE.md — Stack (SvelteKit), Conventions/Auth]

## Dev Agent Record

### Agent Model Used

claude-opus-4-8 (Amelia / dev-story)

### Debug Log References

- One flaky e2e on first run: the theme-toggle test clicked before SvelteKit finished hydrating the heavier shell, so the handler didn't fire. Fixed by waiting for a hydration signal (the control-status fetch resolving to "connected") before interacting — deterministic, no arbitrary sleep. All 3 e2e then passed.
- Used the verified current idioms: `$app/state` `page` (not deprecated `$app/stores`), `redirect(307, …)` called (not thrown), `<a>`/`<button>` for a11y → svelte-check reported 0 warnings.

### Completion Notes List

- **AC1 met:** app shell built as a `(app)` route-group layout — 248px `Sidebar` (Agents/Settings nav as `<a>`, Lucide icons, collapsible with persisted state), 48px `Topbar` (workspace name left; control-plane status + theme toggle + account-placeholder right), content area `max-width: var(--content-max)` (1240px) centered. All on semantic tokens (`--sidebar-w`, `--topbar-h`, `--content-max`, surfaces/borders); no raw hex. Nests under the root layout (global CSS not re-imported).
- **AC2 met (verified live):** theme toggle graduated to the topbar (driven by existing `theme.ts`); Playwright confirms it changes the token-driven background AND survives `page.reload()` (still `dark`, no flash — `app.html` FOUC script).
- **AC3 met:** `/`, `/agents`, `/settings` all resolve (`/` redirects to `/agents`); active nav highlights via `$app/state` `page.url.pathname` → `aria-current="page"` + `--surface-selected`; every interactive element inherits the global visible focus ring; `svelte-check` reports 0 a11y warnings.
- **Regression protected:** the control-plane connectivity readout + `fetch` moved into the topbar (`data-testid="control-status"`), still reports connected; the theme-changes-background assertion retained.
- **Verification:** `svelte-check` 0 errors/0 warnings · `pnpm -r build` 6/6 · `pnpm lint` clean · Playwright **3/3** against the live compose stack.
- **Scope held:** placeholders for Agents/Settings content (Story 3.1 / Epic 2); account menu is a non-functional button (auth = Story 1.4); no auth guard on the `(app)` group yet (expected at this point). The `(app)` group deliberately isolates the authenticated shell so Login can sit outside it in 1.4.

### File List

**apps/web (new):** `src/lib/components/Sidebar.svelte`, `src/lib/components/Topbar.svelte`, `src/routes/(app)/+layout.svelte`, `src/routes/(app)/agents/+page.svelte`, `src/routes/(app)/settings/+page.svelte`, `src/routes/+page.ts`
**apps/web (modified):** `tests/health.spec.ts`
**apps/web (removed):** `src/routes/+page.svelte` (landing content + temp toggle + status moved into the shell)

### Change Log

- 2026-07-31 — Built the app shell: `(app)` route-group layout with a 248px collapsible sidebar (Agents/Settings, active-nav via `$app/state`) and a 48px topbar (workspace name, control-plane status, permanent theme toggle, account placeholder), content capped at 1240px — all on Warm Ink tokens. `/` redirects to `/agents`; placeholder Agents/Settings routes. Theme toggle moved from the temporary 1.2 position into the topbar with reload-persistence. Verified via svelte-check (0 a11y warnings), build, lint, and 3 Playwright e2e (shell+regression, active-nav+navigation, theme persistence). Status → review.
