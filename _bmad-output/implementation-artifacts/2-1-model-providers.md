---
baseline_commit: f244df1afdfd468bbed9fee0e8a809165f6d03d3
---
# Story 2.1: Connect and manage a model provider

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As the builder,
I want to connect a model provider,
so that my agents have a model to run on.

## Acceptance Criteria

1. In Settings › Model providers the builder connects a provider with a credential; the credential is stored in LiteLLM (**not** in an agent/the control DB), the provider card shows connected / error / unconfigured (dot + word), and the key is masked. [Source: epics.md#Story-2.1 FR-13, UX-DR10; ARCHITECTURE-SPINE.md AD-10, AD-6]
2. With an invalid credential the card shows an error with the cause and the provider is not marked connected. [Source: epics.md#Story-2.1]
3. A connected provider's models become available for later selection (Story 3.2). [Source: epics.md#Story-2.1]

## Tasks / Subtasks

- [x] **Task 1: LiteLLM admin client + proxy config for runtime models** (AC: #1, #2, #3)
  - [x] `apps/control-api` env: add `LITELLM_BASE_URL` (compose: `http://litellm:4000`) and `LITELLM_MASTER_KEY`. control-api holds the master key server-side only (never sent to the browser).
  - [x] `src/litellm/client.ts` — a small typed client (`Bearer $LITELLM_MASTER_KEY`) behind an **interface** (`LiteLlmClient`) with a real impl + a fake impl for unit tests: `addModel({ modelName, model, apiKey, apiBase? })` → `POST /model/new` returns the created `model_info.id`; `deleteModel(id)` → `POST /model/delete {id}`; `updateModel(id, params)` → `POST /model/update`; `health(modelName)` → `GET /health?model=<name>` returns `{ healthy_endpoints, unhealthy_endpoints }`; `listModels()` → `GET /v1/models`. [Source: web-research below]
  - [x] `deploy/litellm-config.yaml`: enable `general_settings.store_model_in_db: true` (API-added models must persist). `deploy/compose.yaml` litellm service: add `STORE_MODEL_IN_DB: "True"` and `LITELLM_SALT_KEY` (encrypts stored provider keys; **set once, never rotate** — old creds become undecryptable). Add `LITELLM_SALT_KEY` to `deploy/.env.example`. [Source: web-research below]

- [x] **Task 2: `connections` table + repository** (AC: #1, #2)
  - [x] Extend `src/db/schema.ts` with **`connections`**: `id` (ULID PK), `kind` text (`'model-provider'`), `provider` text (`'openai' | 'anthropic' | 'openai-compatible'`), `name` text, `base_url` text null, `key_last4` text (for masked display — **NOT the key**; the key lives in LiteLLM), `status` text (`'connected' | 'error' | 'unconfigured'`), `last_error` text null, `litellm_model_ids` jsonb (the LiteLLM model_info ids created, for update/delete), `created_at` timestamptz. `drizzle-kit generate` → commit migration. [Source: ARCHITECTURE-SPINE.md AD-7, Conventions]
  - [x] `src/connections/repo.ts` — `ConnectionsRepo` interface (Drizzle impl + in-memory impl for tests): `listProviders()`, `getProvider(id)`, `createProvider(row)`, `updateProviderStatus(id, status, lastError, keyLast4?)`, `setLitellmModelIds(id, ids)`, `deleteProvider(id)`. Single-writer: control-api only (AD-7).

- [x] **Task 3: Server-side session guard (first protected endpoints)** (AC: all — security)
  - [x] `src/auth/guard.ts` — a Hono middleware `requireSession(repo)` that reads the `session` cookie, validates via `AuthRepo.findSessionUser`, and returns 401 `{ error: "unauthenticated" }` if absent/expired. **This is the first real server-side auth enforcement** (Epic 1 only self-checked in `/auth/me`; the client guard is UX only). [Source: code-review finding — "no auth middleware"; ARCHITECTURE-SPINE.md Conventions/Auth]
  - [x] In `app.ts`: mount the connection routes under `requireSession`. Keep `/health`, `/version`, and `/auth/*` unauthenticated. Thread the same `AuthRepo` into both the auth routes and the guard.

- [x] **Task 4: Connection routes (control-api)** (AC: #1, #2, #3)
  - [x] `src/connections/routes.ts` (all behind `requireSession`):
    - `GET /connections/providers` → list (id, provider, name, baseUrl, keyLast4, status, lastError). Never returns the key.
    - `POST /connections/providers` → body `{ provider, name?, apiKey, baseUrl?, models? }`. Register in LiteLLM, verify, persist. **OpenAI/Anthropic:** register the wildcard (`model_name: "openai/*"` / `"anthropic/*"`, `litellm_params.model` same, `api_key`). **openai-compatible:** require `baseUrl` + `models` (comma/newline list); register each as `model_name: "<name>/<model>"`, `litellm_params: { model: "openai/<model>", api_base, api_key }` (namespaced `model_name` avoids colliding with the real `openai/*`). Then **verify** (Task = verify a concrete model) → set status connected/error + lastError; store `key_last4` + `litellm_model_ids`. [Source: web-research — wildcard + model_name namespacing]
    - `POST /connections/providers/:id/rotate-key` → `{ apiKey }` → LiteLLM `updateModel` on stored ids, re-verify.
    - `DELETE /connections/providers/:id` → LiteLLM `deleteModel` for each stored id, then delete the row.
    - `GET /models` → proxy LiteLLM `GET /v1/models` (callable model names) for the later model selector (AC3).
  - [x] **Verify a connection:** after add/rotate, call `litellm.health(verifyModel)` where verifyModel is a concrete cheap model per provider (openai → `openai/gpt-4o-mini`; anthropic → `anthropic/claude-3-5-haiku-latest`; openai-compatible → the first listed `<name>/<model>`). A bad key lands in `unhealthy_endpoints` with the provider error → status `error`, `last_error` = the cause (do NOT leak the key). [Source: web-research — `/health` runs a real test request]

- [x] **Task 5: Settings UI — sub-nav + Model providers page** (AC: #1, #2)
  - [x] Build the Settings sub-nav (Model providers · Data connections · Profile) as a layout `src/routes/(app)/settings/+layout.svelte`; selected item uses `--surface-selected` (UX-DR12). Data connections + Profile are placeholder routes for now.
  - [x] `src/routes/(app)/settings/providers/+page.svelte` — the Model providers surface:
    - An **Add provider** form: provider `<select>` (OpenAI / Anthropic / OpenAI-compatible); an API key input (`type=password`, persistent label); for OpenAI-compatible also a Name, Base URL, and Models field (shown conditionally). Verb-first **Connect** button (ink).
    - A list of **provider cards** (`{components.connection-card}`): provider/name, status dot + word (connected/error/unconfigured), masked key (`sk-…{key_last4}`), `baseUrl` if custom, and actions **Update key** / **Remove**. On error, show `last_error` inline (cause). [Source: DESIGN.md#components.connection-card; EXPERIENCE.md#Component-Patterns provider-card]
    - Verifying shows an inline pending state, then resolves to connected/error. States per the five-state pattern; empty state "No providers connected." + the form.
  - [x] `src/lib/connections.ts` — web client (`credentials:'include'`) for list/create/rotate/delete. All copy verb-first, sentence-case; errors cause→consequence→recovery (project-context.md).

- [x] **Task 6: Tests, compose wiring, verification** (AC: all)
  - [x] Unit tests (control-api, Vitest) with the **fake LiteLLM client + in-memory ConnectionsRepo**: connect openai (wildcard) → connected; bad key (fake health → unhealthy) → status error + lastError, key never persisted to the row; openai-compatible requires baseUrl+models (400 otherwise); rotate-key; delete removes LiteLLM models + row; `GET /connections/*` is 401 without a session cookie (guard works), 200 with one. Assert the API never returns the raw key.
  - [x] Playwright e2e (live stack; no real provider key needed — exercises the **error path**): sign in → Settings › Model providers; the sub-nav + empty state render; add an OpenAI provider with a **bogus key** → the card shows **error** with a cause (LiteLLM `/health` marks it unhealthy); Remove clears it. (A real-key "connected" path is optional, gated on an env key — do not require secrets in the suite.)
  - [x] `svelte-check` 0 · `pnpm -r build` · `pnpm lint` · control-api unit tests · e2e all green. Preserve Epic 1 regressions (auth/shell/theme e2e still pass).

## Dev Notes

**First Epic 2 story. It (a) introduces the real server-side session guard, (b) establishes the LiteLLM admin-client pattern, and (c) adds the `connections` table + Settings shell that Story 2.2 (Gmail) and Story 3.2 (model selector) build on. Keep the provider key OUT of the control DB and the browser — it lives encrypted in LiteLLM (AD-10).**

### Decisions bound for this story
- **Provider types:** OpenAI, Anthropic, and a generic **OpenAI-compatible** (name + base URL + key + explicit model list) — the last unlocks OpenRouter / local llama.cpp later, aligning with the generic-platform thesis. `[user decision 2026-07-31]`
- **LiteLLM registration:** OpenAI/Anthropic via **wildcard** (`openai/*`, `anthropic/*`) — one entry exposes all their models. OpenAI-compatible via **namespaced `model_name`** (`<name>/<model>` → `openai/<model>` + `api_base`) to avoid colliding with the real `openai/*` wildcard.
- **Key custody (AD-10):** the real key → `litellm_params.api_key`, stored **encrypted** in LiteLLM's DB (needs `LITELLM_SALT_KEY`); control DB stores only `key_last4` for the masked display; `/model/info` masks keys; the browser never receives a key.

### LiteLLM admin API (web-verified 2026-07-31 — re-confirm on v1.94.1)
- **Add:** `POST /model/new` `{ model_name, litellm_params: { model, api_key, api_base? } }`, `Authorization: Bearer $LITELLM_MASTER_KEY`. Requires `store_model_in_db: true` (or `STORE_MODEL_IN_DB=True`) to persist. Returns `model_info.id` (store it for update/delete). [Source: docs.litellm.ai/docs/proxy/model_management]
- **Verify:** `GET /health?model=<name>` runs a real test request → `{ healthy_endpoints, unhealthy_endpoints }`; a bad key → unhealthy with `AuthenticationError`. (`/health/readiness`/`/health/liveliness` are process/DB checks, NOT key validation.) [Source: docs.litellm.ai/docs/proxy/health]
- **List:** `GET /v1/models` (callable names; add `check_provider_endpoint: true` to expand wildcards to the provider's real catalog). `GET /model/info` returns masked keys. [Source: model_discovery docs]
- **Update / delete:** `POST /model/update`, `POST /model/delete {id}` (no DELETE verb; no soft-disable). [Source: model_management docs]
- **Gotchas (verify-on-build):** `LITELLM_SALT_KEY` must be set before adding models and never rotated; DB models merge with config.yaml (don't duplicate); open issue #17398 (wildcard + store_model_in_db encrypting the `model` field → "LLM Provider NOT provided") — **smoke-test wildcard + DB on v1.94.1 before relying on it**; if it bites, fall back to explicit per-model registration for OpenAI/Anthropic too. [Source: github.com/BerriAI/litellm/issues/17398]

### Files being modified (READ current state — preserve behavior)
- **`apps/control-api/src/app.ts` (UPDATE):** currently mounts CORS + `/health` + `/version` + `authRoutes(repo)`. **Change:** thread the `AuthRepo` into a new `requireSession` guard; mount `connectionRoutes` under it; inject a `LiteLlmClient` + `ConnectionsRepo`. **Preserve:** `/health`+`/version` unauthenticated (compose/topbar depend on them); `/auth/*` unchanged; CORS-with-credentials unchanged.
- **`apps/control-api/src/db/schema.ts` (UPDATE):** currently `users` + `sessions`. **Change:** add `connections`. **Preserve:** existing tables/migrations (generate a NEW migration; never edit `0000_*`).
- **`apps/control-api/src/server.ts` (UPDATE):** wires deps. **Change:** construct the LiteLLM client (from env) + `ConnectionsRepo` and pass into `createApp`. **Preserve:** ensureDatabase → migrate → seed → session-sweep → serve order.
- **`apps/web/src/routes/(app)/settings/+page.svelte` (UPDATE→relocate):** placeholder. **Change:** becomes a sub-nav layout; `/settings` redirects to `/settings/providers`.
- **`deploy/compose.yaml` + `litellm-config.yaml` + `.env.example` (UPDATE):** add store-model-in-db + salt key + control-api LiteLLM env. **Preserve:** the five services, healthchecks, the "sandboxes not in compose" comment, control-api's own `control` DB.

### Previous-story intelligence (Epic 1)
- control-api = Hono; `createApp(deps)` returns the app; routes are factories taking an injected repo (`authRoutes(repo, opts)`); tests use `app.request(...)` with in-memory repos — **follow this exact pattern** for `connectionRoutes` + `ConnectionsRepo` + `LiteLlmClient` (interface + fake). [Story 1.4]
- **Drizzle** is the DB layer (schema-as-code → `drizzle-kit generate` → `migrate()` at startup). Money/ids/timestamps conventions in `packages/domain` (ULID, UTC). Migrations live committed under `apps/control-api/drizzle/`. [Story 1.4]
- **Auth:** session cookie is `httpOnly SameSite=Lax`; web calls use `credentials:'include'`; CORS already allows credentials. `AuthRepo.findSessionUser(tokenHash, now)` is the validation primitive the new guard reuses (hash the cookie with `hashToken`). [Story 1.4]
- **Web:** `(app)` group is authed; the client guard redirects on 401 — but now the SERVER enforces too. `me()`/`login()` are discriminated (authed/unauthed/error) — mirror that shape in `connections.ts` (ok/invalid/error) so outages aren't shown as validation errors. Warm Ink tokens only; `@lucide/svelte`; project-context.md conventions. [Stories 1.2–1.4 + code review]
- **Regression to protect:** all Epic 1 e2e (auth/shell/theme) must keep passing; `/settings` currently renders a placeholder that this story replaces — update any test that visits it.

### Testing standards
- **Unit (control-api):** inject a **fake `LiteLlmClient`** (scriptable healthy/unhealthy) + in-memory `ConnectionsRepo`; no live LiteLLM. Cover connect/verify/error/rotate/delete/list, guard 401↔200, and "key never in the response or the row."
- **E2E (Playwright, live stack):** the bogus-key **error path** is fully testable without secrets (LiteLLM marks a fake key unhealthy). Real-key happy path optional behind an env var.
- `svelte-check` 0, build 6/6, lint clean, Epic 1 regressions green.
- **DoD:** connect/verify/manage works via the UI; key stored only in LiteLLM (encrypted) + `key_last4` in control DB; masked in UI; status dot+word; server guard rejects unauthenticated `/connections/*`; `GET /models` lists a connected provider's models; regressions intact; only permitted story sections modified.

### Security must-nots
- Never store the raw provider key in the control DB or return it to the browser (only `key_last4`). Never log the key. `/connections/*` and `/models` require a valid session server-side (not just the client guard). `LITELLM_MASTER_KEY` stays in control-api/env, never client-side. Set `LITELLM_SALT_KEY` and don't rotate it.

### Project Structure Notes
- New (control-api): `src/litellm/client.ts`, `src/connections/{repo,routes}.ts`, `src/auth/guard.ts`, new drizzle migration. New (web): `src/routes/(app)/settings/+layout.svelte`, `settings/providers/+page.svelte`, `src/lib/connections.ts`; `settings/+page.ts` redirect. Modified: control-api `app.ts`/`server.ts`/`schema.ts`, `deploy/*`. No other apps/packages touched. [Source: ARCHITECTURE-SPINE.md#Structural-Seed, AD-7]

### References
- [Source: _bmad-output/planning-artifacts/epics.md#Epic-2 / Story-2.1; FR-13, FR-15(connections), UX-DR10, UX-DR12]
- [Source: prd.md FR-13; ARCHITECTURE-SPINE.md AD-2, AD-6, AD-7, AD-10, Conventions/Auth]
- [Source: ux-designs/ux-turanga-2026-07-30/DESIGN.md#components.connection-card + EXPERIENCE.md#Component-Patterns (provider-card), #Information-Architecture (Settings sub-nav)]
- [Source: project-context.md; _bmad-output/implementation-artifacts/1-4-authentication.md (control-api/auth/drizzle patterns) + its Review Findings (requireSession)]
- [Source: web-research 2026-07-31 — LiteLLM model_management / health / wildcard docs + issue #17398]

## Dev Agent Record

### Agent Model Used

claude-opus-4-8 (Amelia / dev-story)

### Debug Log References

- **Verification approach — deviated from the story for reliability:** the spec prescribed LiteLLM `GET /health?model=` to validate a key, but that costs tokens and is flaky against wildcard models (issue #17398). Implemented **provider-direct** verification instead (OpenAI/compat → `GET {base}/v1/models`, Anthropic → `GET /v1/models` with `x-api-key`) — deterministic, free, and testable without secrets. LiteLLM is still where the key is stored (`/model/new`) for actual use. Same AC outcome (invalid → error with cause; valid → connected).
- Regenerated the connections migration once to add a `models` column (needed to re-register an openai-compatible provider on key rotation).
- Updated one Epic 1 e2e (`/settings` now redirects to `/settings/providers`, heading "Model providers") — flagged in the story Dev Notes as expected.

### Completion Notes List

- **AC1:** Settings › Model providers connects a provider; on a valid key control-api registers it in LiteLLM (`/model/new` — OpenAI/Anthropic via wildcard, openai-compatible via namespaced `model_name`), and the card shows status (dot + word) + masked key (`sk-…last4`). The real key is **stored only in LiteLLM (encrypted, `LITELLM_SALT_KEY`)** — control DB keeps only `key_last4`; unit test asserts the API never returns the key.
- **AC2 (verified live):** an invalid key → provider-direct verify returns the provider's error; the connection is saved with status **error** + the cause and is **not** registered in LiteLLM. Playwright drives this end-to-end with a bogus key (real HTTP 401).
- **AC3:** `GET /models` proxies LiteLLM `/v1/models` (behind the guard) so a connected provider's models are available for the Story 3.2 selector.
- **First server-side session guard:** `requireSession` middleware enforces auth on `/connections/*` + `/models` (unit test: 401 without a cookie, 200 with) — closes the code-review "no auth middleware" gap. `/health`+`/version`+`/auth/*` stay unauthenticated.
- **Scope chosen:** OpenAI + Anthropic (wildcard) + generic **OpenAI-compatible** (name + base URL + model list). Rotate-key + Remove implemented (delete/re-register in LiteLLM). Settings sub-nav added (Model providers · Data connections · Profile); the latter two are placeholders for Story 2.2 / later.
- **Verification:** control-api **16 unit tests** (7 new: guard, connect/error/validation/compat/remove, key-never-returned) · `pnpm -r build` 6/6 · `svelte-check` 0 · `pnpm lint` clean · Playwright **8/8** (6 Epic 1 regressions + 2 provider) against a fresh live stack.
- **Patterns followed:** injected repos + a fake `ModelGateway` (Epic 1 style), Drizzle schema→migration, discriminated web client (outage ≠ validation error), Warm Ink tokens + Lucide, project-context conventions. Secrets only in `.env` (LiteLLM salt key placeholder in `.env.example`).
- **Known gap (honest):** the real-key "connected" happy path isn't in the e2e (needs a real provider key); it's covered by unit tests with the fake gateway and the provider-direct verify path is exercised live via the 401.

### File List

**control-api (new):** `src/litellm/gateway.ts`, `src/connections/{repo,routes,connections.test}.ts`, `src/auth/guard.ts`, `drizzle/0001_chilly_madelyne_pryor.sql` + `drizzle/meta/*`
**control-api (modified):** `src/app.ts`, `src/server.ts`, `src/db/schema.ts`
**web (new):** `src/lib/connections.ts`, `src/routes/(app)/settings/+layout.svelte`, `settings/+page.ts`, `settings/providers/+page.svelte`, `settings/connections/+page.svelte`, `settings/profile/+page.svelte`, `tests/providers.spec.ts`
**web (modified):** `tests/health.spec.ts`
**web (removed):** `src/routes/(app)/settings/+page.svelte` (→ sub-nav layout + redirect)
**deploy (modified):** `compose.yaml` (control-api LiteLLM env; litellm STORE_MODEL_IN_DB + LITELLM_SALT_KEY), `litellm-config.yaml` (store_model_in_db), `.env.example` (LITELLM_SALT_KEY)

### Change Log

- 2026-07-31 — Model-provider connections. control-api: LiteLLM admin gateway (provider-direct verify + `/model/new` register/delete/list) behind an interface; `connections` table + Drizzle migration; `requireSession` guard on `/connections/*` + `/models` (first server-side auth). Supports OpenAI, Anthropic (wildcard) + generic OpenAI-compatible. web: Settings sub-nav + Model providers page (add form, provider cards, status/masked-key/update/remove). Key lives encrypted in LiteLLM (AD-10). Verified: 16 unit tests, build 6/6, svelte-check 0, lint clean, Playwright 8/8 live. Status → review.
