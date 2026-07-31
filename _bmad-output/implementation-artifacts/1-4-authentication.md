---
baseline_commit: 0948b66c5093fdd2ae97a47107d264511c9802a6
---
# Story 1.4: Single-user email + password authentication

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As the builder,
I want to sign in with email and password,
so that only I can reach my agents.

## Acceptance Criteria

1. The login surface renders a centered 400px login-card with email + password fields (**persistent labels**, not placeholder-only), the product name in Instrument Sans Medium (no logo), and a reserved-but-inactive SSO slot below a hairline. [Source: epics.md#Story-1.4 FR-16, UX-DR3; DESIGN.md#components.login-card]
2. With valid credentials the builder signs in, a session is established, and the app shell loads; **passwords are stored hashed** (argon2id), never plaintext. [Source: prd.md FR-16]
3. With no valid session, any non-Login surface is refused and the user is sent to Login. [Source: prd.md FR-16; ARCHITECTURE-SPINE.md Conventions/Auth]
4. Wrong credentials show an inline error that states the cause **without leaking which field was wrong**. [Source: prd.md FR-16]

## Tasks / Subtasks

- [x] **Task 1: Establish the control-api DB layer (Drizzle) — the house data pattern** (AC: #2)
  - [x] Add to `apps/control-api`: `drizzle-orm`, `pg`; dev: `drizzle-kit`, `@types/pg`. Create `src/db/client.ts` (a `pg` `Pool` from `DATABASE_URL` + `drizzle(pool)`), `src/db/schema.ts`, and `drizzle.config.ts` (dialect postgres, schema path, out `./drizzle`). This binds Drizzle as the control-api DB pattern (AD-7 refinement). [Source: web-research below]
  - [x] Schema (`schema.ts`): **`users`** (`id` text PK = ULID from `@turanga/domain`, `email` text unique not null, `password_hash` text not null, `created_at` timestamptz default now); **`sessions`** (`id` text PK, `token_hash` text unique not null, `user_id` text not null → users.id, `expires_at` timestamptz not null, `created_at` timestamptz default now). Use Glossary-consistent naming.
  - [x] Generate the initial migration with `drizzle-kit generate` (commit the SQL under `apps/control-api/drizzle/`). Add a `src/db/migrate.ts` that runs pending migrations programmatically (`migrate(db, { migrationsFolder })`).
  - [x] Wire `control-api` to a `DATABASE_URL` env (its own DB creds). Run migrations on server startup (before serving) so the container is self-migrating.

- [x] **Task 2: Auth logic, session store, and routes (control-api)** (AC: #2, #3, #4)
  - [x] Add `@node-rs/argon2` (argon2id, prebuilt — works on `node:22-slim`, no node-gyp). `src/auth/password.ts`: `hash(pw)` / `verify(hash, pw)` using OWASP baseline params (memory 19 MiB, iterations 2, parallelism 1). [Source: web-research below]
  - [x] `src/auth/sessions.ts`: create a session (opaque token = `crypto.randomBytes(32)` hex; store **sha256(token)** + `expires_at` in `sessions`), validate by token→hash lookup (reject expired), delete on logout. Return the raw token only to the caller (never store raw).
  - [x] Put user/session persistence behind a small **repository interface** (`AuthRepo`) with a Drizzle-backed impl AND an in-memory impl — so route logic is unit-testable without a live DB. Inject the repo into the auth router / `createApp`.
  - [x] Routes (Hono, `hono/cookie`): **`POST /auth/login`** (JSON `{email,password}`; look up user; `verify` hash; on success create session + `setCookie('session', token, { httpOnly:true, sameSite:'Lax', secure:<prod>, path:'/', maxAge })` and return `{ email }`; on failure return **401 with a generic message** — same response for unknown email and bad password, AC4). **`GET /auth/me`** (read cookie → valid session → `{ email }`, else 401). **`POST /auth/logout`** (delete session + `deleteCookie`).
  - [x] Add a session-reading middleware; **CORS must allow credentials**: change `cors({ origin: webOrigin })` → `cors({ origin: webOrigin, credentials: true })` (exact origin, never `*`). [Source: apps/control-api/src/app.ts — see UPDATE notes]
  - [x] **Seed the single user** on startup: if `users` is empty and `INITIAL_ADMIN_EMAIL` + `INITIAL_ADMIN_PASSWORD` are set, create the user (hashed). Log that a user was seeded (never log the password).

- [x] **Task 3: Login surface (web) — outside the (app) group** (AC: #1, #4)
  - [x] Create `src/routes/login/+page.svelte` (NOT under `(app)` — Login lives outside the shell). Render the login-card per DESIGN: 400px, `--surface-card`, `--border-subtle`, `--shadow-sm`, centered on `--bg-canvas`; product name "turanga" in Instrument Sans Medium; **email + password inputs with persistent `<label>`s**; a reserved SSO slot below a `--border-hairline` (inactive, e.g. a disabled/`aria-disabled` "Continue with SSO" placeholder or a commented slot — do NOT implement SSO). Primary **Sign in** button is ink (`--action-primary-bg`), verb-first.
  - [x] On submit: `POST` to control-api `/auth/login` with `credentials: 'include'`. On 200 → `goto('/agents')`. On 401 → inline error "Email or password is incorrect." (generic, AC4). Associate the error with the form for screen readers (accessibility floor).

- [x] **Task 4: Route guard + logout in the account menu (web)** (AC: #2, #3)
  - [x] Guard the `(app)` group: in `src/routes/(app)/+layout.svelte`, on mount call control-api `/auth/me` with `credentials:'include'`; if 401 → `goto('/login')` (client-side guard — the API enforces auth server-side regardless). Avoid rendering protected content before the check resolves (a brief neutral loading state is fine). [Source: web-research below]
  - [x] Wire the **account menu** (the placeholder button from Story 1.3) to show the signed-in email and a **Logout** action → `POST /auth/logout` (credentials include) → `goto('/login')`. Keep it minimal (a small menu or inline).
  - [x] Confirm: visiting `/agents` or `/settings` unauthenticated redirects to `/login`; after login they load; after logout they redirect again.

- [x] **Task 5: Compose wiring, tests, and verification** (AC: all)
  - [x] `deploy/compose.yaml`: give `control-api` a `DATABASE_URL` (postgres service) and `INITIAL_ADMIN_EMAIL` / `INITIAL_ADMIN_PASSWORD` (from `.env`); add both to `deploy/.env.example` (placeholder values only — real secrets never committed, AD-10). control-api `depends_on` postgres healthy (already true).
  - [x] Unit tests (Vitest): `password.ts` hash≠plaintext and verify round-trip; auth routes via `app.request` with the **in-memory repo** — login wrong password → 401 (generic), login correct → 200 + `Set-Cookie`, `/auth/me` without cookie → 401 and with cookie → 200, `/auth/logout` clears. No live DB needed for these.
  - [x] Playwright e2e (against the live stack, seeded user from `.env`): unauthenticated `/agents` → redirected to `/login`; sign in with the seeded creds → lands on `/agents` (shell + control-plane status visible); wrong password → inline error, still on `/login`; Logout → back to `/login`. Preserve the Story 1.3 shell/nav/theme tests (they now need an authenticated session — sign in first in those tests, or seed a session).
  - [x] `svelte-check` 0 errors/warnings · `pnpm -r build` · `pnpm lint` · unit tests green · e2e green.

## Dev Notes

**This is the first DB-backed story and it's security-sensitive. Get the auth primitives right; keep scope to single-user email+password + session + guard. No SSO, no password reset, no multi-user/roles (all Non-Goals). The account menu gets *just* email + Logout — no profile editing (that's later).**

### Decisions bound for this story (web-verified 2026-07-31)
- **DB layer = Drizzle ORM** (+ drizzle-kit migrations) over `pg`. Schema-as-code in `schema.ts`; `drizzle-kit generate` produces SQL migrations (commit them); `migrate()` runs them at startup. This is now the control-api house pattern (recorded in ARCHITECTURE-SPINE Stack + memlog). [Source: web-research]
- **Password hashing = `@node-rs/argon2`** (argon2id, Rust prebuilt binaries — **no node-gyp**, so `node:22-slim` builds cleanly; the plain `argon2` npm needs `python3/make/g++`). OWASP argon2id baseline: memory 19 MiB, iterations 2, parallelism 1 (~tune to ~150–200 ms/hash). [Source: web-research — OWASP/Ory]
- **Sessions = DB-backed opaque token** (random 32 bytes; store `sha256` hash + expiry; revocable) in an **httpOnly `SameSite=Lax` cookie**, `path=/`, `secure` **only in prod** (Safari rejects `Secure` on `http://localhost`; Chrome/Firefox allow it). Roll a ~20-line middleware — the maintained `@hono/session` is encrypted-JWT, not opaque-revocable. Use `hono/cookie` (`setCookie`/`getCookie`/`deleteCookie`). [Source: web-research — Hono cookie helper, MDN]
- **Cross-origin cookie reality:** web `:5173` and control-api `:8080` are cross-**origin** but same-**site** (ports aren't part of a site), so a `SameSite=Lax` cookie set by `:8080` **is sent** on `fetch(..., { credentials:'include' })` from `:5173`. Requires CORS `Access-Control-Allow-Credentials: true` + exact origin (not `*`) — already using an exact origin; add `credentials:true`. [Source: web-research — MDN]
- **Guard = client-side** `/auth/me` check in the `(app)` layout (redirect to `/login` on 401). Rationale: the session cookie lives on the `:8080` origin, invisible to SvelteKit's SSR server; and the control-api enforces auth on every endpoint, so the guard is UX, not security. Server-proxy hardening is a later option if SSR flash annoys. [Source: web-research]

### Files being modified (READ current state — preserve behavior)
- **`apps/control-api/src/app.ts` (UPDATE):** currently `createApp()` mounts `cors({ origin: webOrigin })` + `GET /health` + `GET /version`. **Change:** add `credentials: true` to CORS; mount the auth routes + session middleware; inject the `AuthRepo`. **Preserve:** `/health` and `/version` behavior EXACTLY — they are used by compose healthchecks and the web topbar/e2e regression. Health must stay unauthenticated.
- **`apps/control-api/src/server.ts` (UPDATE):** currently serves `createApp().fetch` on `PORT`. **Change:** run DB migrations + user seed BEFORE `serve(...)`. **Preserve:** the listen/port behavior.
- **`apps/web/src/routes/(app)/+layout.svelte` (UPDATE):** the shell from Story 1.3. **Change:** add the on-mount auth guard. **Preserve:** the sidebar/topbar/content structure, theme, and the control-plane status readout.
- **`apps/web/src/lib/components/Topbar.svelte` (UPDATE):** **Change:** wire the account-menu button to email + Logout. **Preserve:** workspace name, control-plane status (`data-testid="control-status"`), theme toggle.
- **`deploy/compose.yaml` (UPDATE):** add `DATABASE_URL` + `INITIAL_ADMIN_*` to `control-api`. **Preserve:** all five services + healthchecks; the "sandboxes not in compose" comment.

### Previous-story intelligence (Stories 1.1–1.3)
- control-api is **Hono** (`createApp()` returns the app; tested via `app.request(...)` — keep that testable shape; inject the repo so auth routes unit-test without Postgres). Node service Dockerfile builds via corepack+pnpm; `@node-rs/argon2` prebuilt keeps it building.
- Postgres/Redis are already in compose (Story 1.1); LiteLLM already uses Postgres. control-api gets its own `DATABASE_URL` now.
- Web: SvelteKit 5 runes; `(app)` route group is the shell (Story 1.3) and was **deliberately structured so Login sits outside it** — put `login/+page.svelte` at `src/routes/login/`. `theme.ts`, tokens, and conventions (`project-context.md`) already exist — reuse. Use `@lucide/svelte`, semantic tokens only, verb-first sentence-case copy, visible focus ring, persistent labels (all in `project-context.md`).
- Regression surface: control-plane status readout + its e2e; theme tests; shell nav tests. After this story those app pages require auth — update the shell/nav/theme e2e to sign in first (seeded creds) or they'll redirect to `/login`.
- `goto` from `$app/navigation`; `page`/nav idioms from `$app/state` (not deprecated `$app/stores`).

### Testing standards
- **Unit (Vitest, in control-api):** password hash/verify; auth routes with the in-memory `AuthRepo` (login 401 generic / 200 + cookie, `/auth/me` 401↔200, logout clears). Fast, no DB.
- **E2E (Playwright, live stack + seeded user):** guard redirect, successful login → shell, wrong-password inline error, logout. Update the Story 1.3 shell/nav/theme specs to authenticate first.
- `svelte-check` 0 warnings; `pnpm -r build` 6/6; `pnpm lint` clean.
- **DoD:** login-card per spec; hashed passwords (argon2id); session cookie httpOnly SameSite=Lax; unauth (app) routes redirect to /login; generic error on bad creds; `/health` still unauthenticated; regressions updated + green; secrets only in `.env` (gitignored). Only permitted story sections modified.

### Security must-nots
- Never store or log plaintext passwords or raw session tokens (store sha256 of the token). Generic 401 for both unknown-email and bad-password (AC4 — no user enumeration). Keep `/health` + `/version` unauthenticated (compose depends on them). `secure` cookie in prod; do not commit `INITIAL_ADMIN_PASSWORD`.

### Project Structure Notes
- New (control-api): `src/db/{client,schema,migrate}.ts`, `drizzle.config.ts`, `drizzle/*` (generated), `src/auth/{password,sessions,routes,repo}.ts`. New (web): `src/routes/login/+page.svelte`. Modified: control-api `app.ts`/`server.ts`/`package.json`/`Dockerfile`(if build tooling needed — likely not with @node-rs/argon2), web `(app)/+layout.svelte` + `Topbar.svelte` + tests, `deploy/compose.yaml` + `.env.example`. No other apps/packages touched. [Source: ARCHITECTURE-SPINE.md#Structural-Seed, AD-7]

### References
- [Source: _bmad-output/planning-artifacts/epics.md#Epic-1 / Story-1.4; FR-16, UX-DR3]
- [Source: _bmad-output/planning-artifacts/prds/prd-turanga-2026-07-31/prd.md FR-16; NFR-5]
- [Source: _bmad-output/planning-artifacts/ux-designs/ux-turanga-2026-07-30/DESIGN.md#components.login-card; EXPERIENCE.md#Voice (generic errors), #Accessibility-Floor]
- [Source: _bmad-output/planning-artifacts/architecture/architecture-turanga-2026-07-31/ARCHITECTURE-SPINE.md — AD-3, AD-7, Conventions/Auth, Stack (Drizzle/@node-rs/argon2)]
- [Source: project-context.md — UI/a11y/voice conventions]
- [Source: _bmad-output/implementation-artifacts/1-3-app-shell.md, 1-1-scaffold-monorepo.md — shell, control-api shape, compose]

## Dev Agent Record

### Agent Model Used

claude-opus-4-8 (Amelia / dev-story)

### Debug Log References

- **argon2 + verbatimModuleSyntax:** `Algorithm` is an ambient const enum → blocked by `verbatimModuleSyntax`. Dropped the enum import (argon2id is `@node-rs/argon2`'s default variant); kept OWASP params (19 MiB / t=2 / p=1). `@node-rs/argon2` prebuilt binaries built cleanly on `node:22-slim` (no node-gyp).
- **🔴 Real bug found + fixed (architecture):** e2e login returned 500 `relation "users" does not exist` even though startup seeded a user and curl login worked *first*. Root cause: control-api and LiteLLM shared the `turanga` Postgres DB, and LiteLLM's Prisma startup migration wiped control-api's tables (a race). Fix: control-api gets its **own `control` database** (created via a postgres `docker-entrypoint-initdb.d` script), enforcing AD-7 (single owner per state) at the DB boundary. Logged as an AD-7 realization in the architecture memlog.
- **Playwright flake avoided:** sign-in helper waits for the `/agents` URL; theme test waits for the control-status hydration signal before interacting (carried from Story 1.3).

### Completion Notes List

- **AC1 met (verified):** `login/+page.svelte` (outside the `(app)` group) renders the 400px login-card per DESIGN — product name in Instrument Sans Medium, email + password with **persistent `<label>`s**, ink **Sign in** button, reserved SSO slot below a hairline.
- **AC2 met (verified live):** valid creds → control-api verifies the argon2id hash, creates a DB-backed session, sets an `httpOnly; SameSite=Lax; Path=/` cookie; the `(app)` guard then loads the shell. Passwords stored as argon2id hashes (unit test asserts `$argon2id$` prefix + no plaintext).
- **AC3 met (verified):** the `(app)` layout guard calls `/auth/me` on mount and redirects to `/login` on 401; e2e confirms unauthenticated `/agents` → `/login`, and post-logout the same.
- **AC4 met (verified):** wrong password AND unknown email both return the same generic 401 "Email or password is incorrect." (unit test asserts no user-enumeration); the login page shows it inline via `role="alert"`.
- **DB layer (Drizzle) established** as the control-api house pattern: `schema.ts` (users, sessions) → `drizzle-kit generate` → committed migration → `migrate()` at startup (self-migrating container). Repo behind an `AuthRepo` interface (Drizzle impl + in-memory impl for fast unit tests).
- **Regressions preserved:** `/health` + `/version` stay unauthenticated (compose healthchecks); control-plane status readout + theme + shell nav tests updated to sign in first, all green.
- **Verification:** control-api unit tests 8/8 (argon2 + auth routes via in-memory repo) · `pnpm -r build` 6/6 · `pnpm lint` clean · Playwright **6/6** against the live seeded stack (redirect, bad-creds error, sign-in→shell, nav, theme, logout).
- **Security:** sha256(token) stored (never the raw token); generic 401 (no enumeration); `secure` cookie in prod only (Safari rejects Secure on http://localhost); seed creds only in `.env` (gitignored) with compose defaults for dev; never logs passwords/tokens.
- **Scope held:** single-user only; no SSO/reset/multi-user; account menu is just email + Log out (no profile editing).

### File List

**control-api (new):** `src/db/{client,schema,migrate}.ts`, `drizzle.config.ts`, `drizzle/0000_steady_bucky.sql` + `drizzle/meta/*`, `src/auth/{password,sessions,repo,routes,auth.test}.ts`
**control-api (modified):** `src/app.ts` (mount auth + credentials CORS), `src/server.ts` (migrate + seed + serve), `package.json`
**web (new):** `src/lib/auth.ts`, `src/routes/login/+page.svelte`
**web (modified):** `src/routes/(app)/+layout.svelte` (guard), `src/lib/components/Topbar.svelte` (account menu + logout), `tests/health.spec.ts`
**deploy (new):** `postgres-init/01-create-control-db.sql`
**deploy (modified):** `compose.yaml` (control-api DATABASE_URL→`control` + seed env; postgres init mount), `.env.example`
**root (modified):** `pnpm-lock.yaml`

### Change Log

- 2026-07-31 — Single-user email+password auth. control-api: Drizzle DB layer (users/sessions) + migrations, argon2id hashing (`@node-rs/argon2`), DB-backed opaque session cookie (`httpOnly; SameSite=Lax`), `/auth/login|me|logout`, credentialed CORS, env-seeded initial user; own `control` database (AD-7, separated from LiteLLM). web: login-card (outside the shell), `(app)` client-side guard → `/login` on 401, account-menu Log out. Verified via 8 control-api unit tests + 6 Playwright e2e against the live stack. Status → review.

## Review Findings (Epic 1 code review — 2026-07-31)

Adversarial review (Blind Hunter + Edge Case Hunter + Acceptance Auditor). No AC violations found; all four stories' ACs verified. Severities set for the current consumer (single-user, single-machine tool); several deploy-hardening items rise in severity once turanga is networked/multi-user.

### Decision needed
- [x] [Review][Decision→Patch, applied] Auth hardening scope for MVP — added per-IP rate limit + body/input-size caps on /auth/login. — no rate-limit/lockout on `/auth/login` (online brute-force) AND an unauthenticated argon2 memory/CPU DoS (each attempt allocates 19 MiB). [apps/control-api/src/auth/routes.ts]

### Patch (unambiguous fixes)
- [x] [Review][Patch][med] Login timing side-channel: no argon2 verify on unknown email defeats the no-enumeration guarantee (auth.test asserts it) — add a constant dummy-hash verify when user is null [apps/control-api/src/auth/routes.ts:21]
- [x] [Review][Patch][med] `pg` Pool has no `'error'` handler → an idle-connection drop (Postgres restart) crashes control-api — add `pool.on('error', …)` [apps/control-api/src/db/client.ts]
- [x] [Review][Patch][med] Transient outage handling: `me()` maps outage→null so a blip logs the user out; `login()` has no try/catch so an outage shows "incorrect password" + unhandled rejection — distinguish network/5xx from 401 [apps/web/src/lib/auth.ts, src/routes/(app)/+layout.svelte, src/routes/login/+page.svelte]
- [x] [Review][Patch][med] `(app)` guard reads `localStorage.getItem` unguarded before `me()` → storage-blocked browsers get a permanently blank app — try/catch it like theme.ts [apps/web/src/routes/(app)/+layout.svelte:17]
- [x] [Review][Patch][med] Email not normalized (case/trim) on seed + lookup; case-sensitive unique → legit login can fail — trim+lowercase on create and lookup [apps/control-api/src/auth/routes.ts, src/server.ts]
- [x] [Review][Patch][med] `Secure` cookie unreachable (NODE_ENV never set in compose) → session token in cleartext once deployed over TLS — drive off explicit COOKIE_SECURE/WEB_ORIGIN scheme [apps/control-api/src/server.ts, deploy/compose.yaml]
- [x] [Review][Patch][med] Default admin password `changeme-dev` baked into compose + auto-seeded → known creds if exposed — remove the default; warn/refuse to seed when unset [deploy/compose.yaml, apps/control-api/src/server.ts]
- [x] [Review][Patch][med] Pre-existing `pgdata` volume never gets the `control` DB (init is first-boot-only) → crash-loop on upgrade — control-api should ensure the DB exists (or fail clearly) [apps/control-api/src/server.ts, deploy/postgres-init]
- [x] [Review][Patch][low] Misleading comment "control-api enforces auth on every endpoint" — no such middleware exists yet; fix comment and/or add a requireSession stub for Epic 2 [apps/web/src/routes/(app)/+layout.svelte]
- [x] [Review][Patch][low] `seedInitialUser` check-then-insert not atomic → duplicate seed crashes on unique violation — `INSERT … ON CONFLICT (email) DO NOTHING` [apps/control-api/src/server.ts]
- [x] [Review][Patch][low] Partial `INITIAL_ADMIN_*` boots with no user and no diagnostic — warn when one is set without the other [apps/control-api/src/server.ts]
- [x] [Review][Patch][low] ULID `rand()===1.0` → index 32 → `undefined` in id — clamp the index [packages/domain/src/index.ts]
- [x] [Review][Patch][low] `egress-guard` missing `depends_on` datastores (Story 1.1 Task 2 literal) [deploy/compose.yaml]
- [x] [Review][Patch][low] Login SSO slot `aria-hidden` hides the reserved slot from assistive tech — use a real disabled/aria-disabled control [apps/web/src/routes/login/+page.svelte]
- [x] [Review][Patch][low] Expired sessions never reaped → `sessions` grows unbounded — periodic `DELETE … WHERE expires_at <= now()` [apps/control-api/src/auth/repo.ts, src/server.ts]

### Deferred (real; roadmap / deploy-config)
- [x] [Review][Defer] SameSite=Lax breaks a future multi-domain deploy (web+api different sites) — deferred, arch is single-machine now
- [x] [Review][Defer] WEB_ORIGIN single exact origin — deferred, deploy-config concern
- [x] [Review][Defer] CSRF relies on SameSite=Lax alone — deferred, fine while endpoints are JSON+POST; revisit for state-changing GET/form routes
- [x] [Review][Defer] ULID non-monotonic within a millisecond — deferred, no ordering dependency yet

### Dismissed (noise / scope-correct)
- Login error uses `--critical-500` (no error alias exists in tokens) · raw px 56/200 (no token exists) · five vs six token files (local-first fonts intent met) · Agents empty-state fact-only (action deferred to Story 3.1)
