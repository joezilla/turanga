---
baseline_commit: 4a8caff9551187a93061a45ea5ced21cded3e5bd
---
# Story 2.2: Connect a Gmail data connection via OAuth

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As the builder,
I want to connect my Gmail via OAuth,
so that an agent can work with my mail without ever holding my credential.

## Acceptance Criteria

1. In Settings › Data connections the builder connects Gmail; a scoped OAuth flow completes and the refresh token is stored in the egress-guard's custody (**encrypted at rest**), never exposed to an agent or the browser. [Source: epics.md#Story-2.2 FR-14; ARCHITECTURE-SPINE.md AD-5, AD-10]
2. A connected Gmail shows status (dot + word) and its declared destinations, and offers **Revoke**. [Source: epics.md#Story-2.2; DESIGN.md#components.connection-card]
3. The generic Connection abstraction is honored — the Gmail connection is consumed only through the generic Connection interface; no email-specific logic leaks into the Agent-definition / Lifecycle / Sandbox / Cost code paths (genericity — SM-4). [Source: epics.md#Story-2.2; prd.md FR-14, SM-4]

## Tasks / Subtasks

- [x] **Task 1: At-rest encryption + config surface** (AC: #1)
  - [x] `apps/control-api` env: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI` (default `http://localhost:8080/oauth/google/callback`), `TOKEN_ENC_KEY` (32-byte key, base64/hex). Add all to `deploy/compose.yaml` (empty defaults) + `deploy/.env.example` with a comment pointing to the Google setup steps (see Dev Notes). [Source: web-research]
  - [x] `src/secrets/crypto.ts` — `encryptSecret(plaintext): string` / `decryptSecret(blob): string` using **AES-256-GCM** with `TOKEN_ENC_KEY`; the stored blob packs iv + auth tag + ciphertext (base64). Never log plaintext. Fail closed if `TOKEN_ENC_KEY` is missing. [Source: web-research — encrypt refresh token at rest]
  - [x] `GET /connections/config` (authenticated) → `{ googleConfigured: boolean }` (client id + secret + redirect present) so the UI can show Connect vs a "not configured" message.

- [x] **Task 2: `data_connections` table + repository** (AC: #1, #2)
  - [x] Extend `src/db/schema.ts` with **`data_connections`**: `id` (ULID PK), `provider` text (`'gmail'`), `name` text, `account_email` text null, `scopes` jsonb, `destinations` jsonb (declared allowlist hosts), `status` text (`'connected' | 'error' | 'unconfigured'`), `last_error` text null, `enc_refresh_token` text null (AES-GCM blob — **the token, encrypted; never returned**), `created_at` timestamptz. `drizzle-kit generate` → commit migration. [Source: ARCHITECTURE-SPINE.md AD-7, AD-10]
  - [x] `src/connections/dataRepo.ts` — `DataConnectionsRepo` interface (Drizzle + in-memory impls, mirroring the Story 2.1 pattern): `list()`, `get(id)`, `upsertGmail(row)` (single Gmail connection — one per account), `setStatus(id, status, lastError)`, `delete(id)`. The public `view()` NEVER includes `enc_refresh_token`.

- [x] **Task 3: Google OAuth client (interface + fake)** (AC: #1)
  - [x] Add `google-auth-library` (11.x). `src/oauth/google.ts` — a `GoogleOAuth` interface (real impl over `OAuth2Client` + a fake for tests): `authUrl(state): string` (`access_type=offline`, `prompt=consent`, scopes `gmail.modify` + `openid email`), `exchange(code): Promise<{ refreshToken: string; email: string; scopes: string[] }>` (uses `getToken` + reads the account email from the id_token/userinfo), `revoke(refreshToken): Promise<void>`. `isConfigured(): boolean`. [Source: web-research — google-auth-library OAuth2Client]
  - [x] Least-privilege scopes: `https://www.googleapis.com/auth/gmail.modify` (read + label + draft, no auto-send) + `openid email`. Declared destinations for the connection: `gmail.googleapis.com`, `oauth2.googleapis.com`. [Source: web-research — gmail.modify covers read/label/draft]

- [x] **Task 4: OAuth routes (control-api)** (AC: #1, #2)
  - [x] `src/oauth/routes.ts`:
    - `GET /oauth/google/start` (session-guarded) → if not configured, 503 `{ error }`. Else generate a random `state`, set it in an `httpOnly` cookie (`oauth_state`, SameSite=Lax, short maxAge), and **302 redirect** to `authUrl(state)`. (Browser navigates here directly; the session + state cookies ride along same-site.) [Source: web-research — CSRF state]
    - `GET /oauth/google/callback` (session-guarded) → verify the `state` cookie matches the query `state` (else 400); on Google `error` param, redirect to the web with an error; else `exchange(code)` → encrypt the refresh token → `upsertGmail({ status: 'connected', accountEmail, scopes, destinations, encRefreshToken })` → clear the state cookie → **302 redirect to `${WEB_ORIGIN}/settings/connections`**. On exchange failure, upsert status `error` + a cause, redirect back. [Source: web-research — token exchange]
    - `GET /connections/data` (session-guarded) → list (view: id, provider, name, accountEmail, status, destinations, lastError). Never the token.
    - `DELETE /connections/data/:id` (session-guarded) → decrypt + `revoke()` at Google (best-effort), then delete the row.
  - [x] Mount the new routes: `/connections/data*` under `requireSession`; `/oauth/google/*` under `requireSession` too (the flow is for the logged-in builder). Keep `/health`, `/version`, `/auth/*`, and Story 2.1's `/connections/providers` untouched.

- [x] **Task 5: Data connections UI** (AC: #1, #2)
  - [x] Replace `src/routes/(app)/settings/connections/+page.svelte` (fix the stray "Uconnections" heading → "Data connections"). States:
    - **Not configured** (`googleConfigured=false`): a neutral notice "Google OAuth isn't configured." + a short pointer to the setup steps (README/.env.example). No connect button.
    - **Configured, not connected**: a **Connect with Google** button → `window.location = ${controlApiBase}/oauth/google/start` (top-level nav so cookies flow).
    - **Connected**: a connection card — Gmail account email, status dot + word, the declared destinations (small mono list), and a **Revoke** action (confirm → DELETE). On error, show `last_error`.
  - [x] `src/lib/dataConnections.ts` — client (`credentials:'include'`, discriminated results) for `config()`, `list()`, `remove(id)`. Verb-first, sentence-case copy; errors cause→consequence→recovery (project-context.md).

- [x] **Task 6: Tests, compose wiring, docs, verification** (AC: all)
  - [x] Unit (control-api, Vitest): `crypto.ts` encrypt→decrypt round-trip + tamper → throws; OAuth callback with a **fake `GoogleOAuth`** + in-memory `DataConnectionsRepo`: state mismatch → 400; happy exchange → connection `connected`, `accountEmail` set, and the token is **encrypted in the row and absent from the API view**; `/connections/data` 401 without a session, 200 with; delete calls `revoke` + removes the row; `/connections/config` reflects env. Assert the raw refresh token never appears in any response body.
  - [x] Playwright e2e (live stack; **no real Google needed**): sign in → Settings › Data connections; heading is "Data connections"; with Google **not configured** (no client env in the default stack) the "not configured" notice shows and there's no Connect button. (A configured-state test that asserts the Connect button links to `accounts.google.com` is optional, gated on dummy client env — do not complete a real consent.)
  - [x] `deploy/`: add the four env vars (empty defaults). **Document the Google Cloud setup** in `README.md` (create project → OAuth consent screen in Testing + add yourself as a test user → OAuth 2.0 Web client → authorized redirect URI `http://localhost:8080/oauth/google/callback` → put client id/secret + a `TOKEN_ENC_KEY` in `deploy/.env`).
  - [x] `svelte-check` 0 · `pnpm -r build` · `pnpm lint` · control-api unit tests · e2e (incl. Epic 1 + 2.1 regressions) all green.

## Dev Notes

**Second connector story. Reuses the Story 2.1 connections + guard foundation. The whole point (FR-14, SM-4) is that Gmail is just an *implementation* behind a generic Connection — keep every email-specific detail inside `src/oauth/*` + `src/connections/dataRepo`, never in agent/lifecycle/sandbox code. The credential-injection USE of the token is Epic 4; this story only connects + stores it encrypted + revokes.**

### Decisions bound for this story
- **Prerequisite handling:** implement the full OAuth flow with a **graceful "not configured" state**; a real Gmail connection needs the user's own Google Cloud OAuth client (documented). The story is complete + tested without one. `[user decision 2026-08-01]`
- **Token custody (AD-10 realization):** control-api runs the flow and stores the refresh token **encrypted at rest** (AES-256-GCM, `TOKEN_ENC_KEY`) in `data_connections.enc_refresh_token`. The egress-guard reads + decrypts it for injection in **Epic 4** — that's when AD-10's "guard holds it" is realized at the injection path. The token never enters a sandbox and is never sent to the browser. `[user decision 2026-08-01; logged in architecture memlog]`
- **Scopes (least privilege):** `gmail.modify` + `openid email` — covers read/search, label/flag, and draft *without* auto-send (`gmail.compose`/`gmail.send` NOT requested). Note: `gmail.modify` is a **restricted** scope — fine for personal/testing use with the builder added as a test user; production would need Google verification (out of scope). [Source: web-research]

### Google OAuth (web-verified 2026-08-01)
- **Library:** `google-auth-library` **11.x** `OAuth2Client` (`generateAuthUrl` / `getToken` / `revokeToken`) — the lightweight auth core; do NOT pull the full `googleapis` yet. [Source: npmjs.com/package/google-auth-library]
- **Flow:** authorization-code, confidential client. Auth `https://accounts.google.com/o/oauth2/v2/auth` with `access_type=offline` + `prompt=consent` (refresh token only comes back reliably with `prompt=consent`). Token exchange `https://oauth2.googleapis.com/token`. Revoke `https://oauth2.googleapis.com/revoke`. [Source: developers.google.com/identity/protocols/oauth2/web-server]
- **Callback owner = control-api (:8080)** (holds the client secret + writes the encrypted token). Redirect URI `http://localhost:8080/oauth/google/callback` — Google permits http on localhost. The web only *initiates* (top-level nav to `/oauth/google/start`). [Source: web-research]
- **Account email:** from the `id_token` `email` claim (requested via `openid email`) or `https://www.googleapis.com/oauth2/v3/userinfo`.
- **Gotchas (bake into UX/docs):** CSRF `state` is required (signed/httpOnly cookie, verified on callback). Testing-status consent screen → "unverified app" warning + must add test users, and **refresh tokens expire in 7 days** until the app is published — document this so a stale connection reads as `error` and the user reconnects. Handle `invalid_grant` (revoked/expired) → status error + reconnect. [Source: web-research]

### Files being modified (READ current state — preserve behavior)
- **`apps/control-api/src/app.ts` (UPDATE):** mounts CORS, health/version, auth, and (Story 2.1) `/connections/providers` + `/models` behind `requireSession`, injecting `AuthRepo`, `ConnectionsRepo`, `ModelGateway`. **Change:** also inject `DataConnectionsRepo` + `GoogleOAuth`; mount `/connections/data*` and `/oauth/google/*` behind `requireSession`. **Preserve:** everything from 1.4 + 2.1 (health/version open; provider routes unchanged; the CORS-with-credentials pattern).
- **`apps/control-api/src/db/schema.ts` (UPDATE):** has `users`, `sessions`, `connections`. **Change:** add `data_connections`. **Preserve:** existing tables + the two committed migrations (generate a NEW `0002`).
- **`apps/control-api/src/server.ts` (UPDATE):** constructs deps from env. **Change:** build `DataConnectionsRepo` + the real `GoogleOAuth` (+ crypto) and pass into `createApp`. **Preserve:** ensureDatabase→migrate→seed→sweep order + the LiteLLM gateway wiring.
- **`apps/web/src/routes/(app)/settings/connections/+page.svelte` (UPDATE):** currently a broken placeholder ("Uconnections"). **Change:** the real Data connections surface. **Preserve:** the Settings sub-nav layout (Story 2.1) that wraps it.
- **`deploy/compose.yaml` + `.env.example` + `README.md` (UPDATE):** add the OAuth/enc env + setup docs. **Preserve:** all services + Story 2.1's LiteLLM env.

### Previous-story intelligence (Epic 1 + 2.1)
- **Pattern:** control-api routes are factories taking injected repos/clients; interface + fake for anything external (`AuthRepo`, `ModelGateway`); tests use `app.request(...)` with a real session obtained by `POST /auth/login`. Mirror this for `GoogleOAuth` + `DataConnectionsRepo`. [Story 2.1]
- **`requireSession` guard** already exists (`src/auth/guard.ts`) — reuse it for the new routes. The session cookie is `httpOnly SameSite=Lax`; it rides on the top-level nav to `/oauth/google/start` AND on Google's redirect back to `/callback` (both same-site to :8080). [Story 2.1]
- **Drizzle** schema→`drizzle-kit generate`→committed migration→`migrate()` at startup; control-api owns its `control` DB. Money/id/time conventions in `packages/domain` (ULID). [Story 1.4]
- **Web:** discriminated client results (ok/error) so an outage isn't a validation error; Warm Ink tokens + Lucide; the Settings sub-nav layout is in place; `connection-card` visual spec in DESIGN.md. [Story 2.1]
- **Regression to protect:** all Epic 1 + 2.1 e2e (auth/shell/theme/providers) must keep passing; `/settings/connections` currently renders the placeholder these tests may touch — the sub-nav link is exercised by 2.1's test (it checks the "Data connections" link is visible).

### Testing standards
- **Unit (control-api):** crypto round-trip + tamper-detect; callback logic with a fake `GoogleOAuth` (state mismatch, happy path, exchange failure); guard 401↔200; "token encrypted in row, never in any response." No real Google.
- **E2E (Playwright, live stack):** Data connections page + the not-configured state (default, no client env). Real OAuth consent is a manual verification with the user's Google client (documented) — do NOT attempt a real consent in the suite.
- `svelte-check` 0, build 6/6, lint clean, Epic 1 + 2.1 regressions green.
- **DoD:** OAuth flow implemented end-to-end (start→callback→store); token encrypted at rest + never returned/logged; status + destinations + Revoke in the UI; graceful not-configured; generic Connection abstraction (no email-specifics outside `oauth/`+`dataRepo`); regressions intact; only permitted story sections modified.

### Security must-nots
- Never store the refresh token unencrypted or return/log it (only `accountEmail` + status + destinations leave control-api). `TOKEN_ENC_KEY` + `GOOGLE_OAUTH_CLIENT_SECRET` stay server-side only. Verify the CSRF `state` on the callback. `state`/`session` cookies `httpOnly`. Revoke at Google on delete. Do not request `gmail.send`/`gmail.compose`/`https://mail.google.com/`.

### Project Structure Notes
- New (control-api): `src/secrets/crypto.ts`, `src/oauth/{google,routes}.ts`, `src/connections/dataRepo.ts`, new `0002` migration. New (web): `src/lib/dataConnections.ts`. Modified: control-api `app.ts`/`server.ts`/`schema.ts`, web `settings/connections/+page.svelte`, `deploy/*`, `README.md`. No other apps/packages touched. [Source: ARCHITECTURE-SPINE.md#Structural-Seed, AD-7]

### References
- [Source: _bmad-output/planning-artifacts/epics.md#Epic-2 / Story-2.2; FR-14, SM-4, UX-DR21]
- [Source: prd.md FR-14, NFR-5; ARCHITECTURE-SPINE.md AD-5, AD-7, AD-10, Conventions/Auth + memlog AD-10 realization 2026-08-01]
- [Source: ux-designs/ux-turanga-2026-07-30/DESIGN.md#components.connection-card + EXPERIENCE.md#Component-Patterns (data connection = Gmail OAuth), #Information-Architecture (Settings sub-nav)]
- [Source: project-context.md; _bmad-output/implementation-artifacts/2-1-model-providers.md (connections/guard/settings patterns) + 1-4-authentication.md (drizzle/crypto/session)]
- [Source: web-research 2026-08-01 — Google OAuth 2.0 web-server flow, scopes, google-auth-library]

## Dev Agent Record

### Agent Model Used

claude-opus-4-8 (Amelia / dev-story)

### Debug Log References

- **e2e flake fixed:** two sign-in tests intermittently timed out under Playwright's 2 parallel workers — contention on control-api's intentionally-slow argon2 login (the suite does ~8 logins). Set `workers: 1` (serial) — deterministic 9/9, and it removes a latent flake from the Epic 1/2.1 tests too.

### Completion Notes List

- **AC1:** full Google authorization-code OAuth flow — `/oauth/google/start` (state cookie + redirect) → `/oauth/google/callback` (state check → `google-auth-library` token exchange → refresh token **AES-256-GCM encrypted** and stored in `data_connections.enc_refresh_token`). The token is never returned or logged (unit test asserts it's absent from every response body); `TOKEN_ENC_KEY` derives the 32-byte key.
- **AC1 (graceful):** with no Google client configured, `/connections/config` reports `googleConfigured:false` and the UI shows a "not configured" notice + README pointer — **verified live in the e2e** (no secrets needed).
- **AC2:** the Data connections card shows account email + status (dot + word) + declared destinations (`gmail.googleapis.com`, `oauth2.googleapis.com`) + **Revoke** (confirm → DELETE → revoke at Google + delete row). Unit-tested; the `Uconnections` typo from 2.1 fixed to "Data connections".
- **AC3 (genericity, SM-4):** all Gmail/OAuth specifics live in `src/oauth/*`, `src/secrets/crypto.ts`, `src/connections/dataRepo.ts` — nothing email-specific touches agent/lifecycle/sandbox/cost code.
- **Scope + security:** least-privilege scopes `gmail.modify` + `openid email` (no auto-send). CSRF `state` verified on callback; state/session cookies httpOnly. New routes behind `requireSession`. Token custody per the AD-10 realization (control-api encrypts at rest; egress-guard consumes in Epic 4). README documents the Google Cloud setup + the testing-mode 7-day refresh-token expiry.
- **Verification:** control-api **22 unit tests** (6 new: crypto round-trip/tamper, config, full callback flow, state-mismatch 400, revoke-on-delete, token-never-returned) · `pnpm -r build` 6/6 · `svelte-check` 0 · `pnpm lint` clean · Playwright **9/9** live (Epic 1 + 2.1 + new Data-connections not-configured).
- **Known (by design):** a real Gmail connect needs the user's Google Cloud OAuth client — documented; the flow is exercised end-to-end via unit tests with a fake `GoogleOAuth`; the live e2e covers the not-configured path.

### File List

**control-api (new):** `src/secrets/crypto.ts`, `src/oauth/{google,routes,oauth.test}.ts`, `src/connections/dataRepo.ts`, `drizzle/0002_harsh_gateway.sql` + `drizzle/meta/*`
**control-api (modified):** `src/app.ts`, `src/server.ts`, `src/db/schema.ts`, `package.json`
**web (new):** `src/lib/dataConnections.ts`
**web (modified):** `src/routes/(app)/settings/connections/+page.svelte` (real page; fixes typo), `playwright.config.ts` (workers:1), `tests/providers.spec.ts` (+ data-connections test)
**deploy (modified):** `compose.yaml` (control-api OAuth/enc env), `.env.example` (TOKEN_ENC_KEY + Google OAuth), `README.md` (Gmail setup)

### Change Log

- 2026-08-01 — Gmail data connection via OAuth. control-api: AES-256-GCM secret crypto; `data_connections` table + Drizzle migration; `GoogleOAuth` client (google-auth-library, interface + fake) with least-privilege `gmail.modify`+`openid email`; `/oauth/google/start|callback` (CSRF state) + `/connections/config|data` behind `requireSession`; refresh token encrypted at rest, revoked on delete (AD-10 realization). web: Data connections page (not-configured / connect / connected+revoke). README documents the Google Cloud setup. Verified: 22 unit tests, build 6/6, svelte-check 0, lint clean, Playwright 9/9 live. Status → review.
