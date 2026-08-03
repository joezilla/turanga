---
baseline_commit: 5fb0487d4bda39d4c45e54d33eae7599ba05eb40
---
# Story 2.4: Discover and curate provider models

Status: done

<!-- New story (post-hoc addition to Epic 2, Connections). Not in the original epics.md — captured
     from a direct user request on 2026-08-03. Extends Story 2.1 (connect a model provider) + touches
     Story 3.2 (agent model selection). -->

## Story

As the builder,
I want the system to fetch a provider's available models when I connect it and let me enable/disable which ones are selectable,
so that setting an agent's model is a validated choice from a real list — not error-prone free text.

## Acceptance Criteria

1. **Given** I connect a model provider (or refresh an existing one), **when** the connection verifies, **then** the system fetches the provider's available models from its API, persists them, and the provider card lists each model with an enable/disable toggle — with **recognized chat models enabled by default** and the rest (embeddings, whisper, tts, image) disabled.
2. **Given** a connected provider with fetched models, **when** I open an agent's model field, **then** it is a dropdown of the **enabled** models grouped by provider (no free-text entry), and selecting one persists it.
3. **Given** an agent, **when** I set its model via the API, **then** the server **rejects** a value that isn't an enabled model of a connected provider (validated, not any ≤200-char string); clearing to `null` stays allowed.
4. **Given** a provider I connected earlier, **when** I click **Refresh models**, **then** the list re-queries the provider API and reconciles: newly-appeared models follow the chat-default, models that disappeared drop, and my enable/disable choices for still-present models are **preserved**.

## Tasks / Subtasks

- [x] **Task 1: Persist an enabled subset + a chat-default heuristic (control-api)** (AC: #1, #4)
  - [x] `apps/control-api/src/db/schema.ts` — add `enabledModels: jsonb("enabled_models").$type<string[]>().notNull().default([])` to the `connections` table (the subset of `models` the user has turned on). `models` stays the full fetched catalog; `enabledModels` is the curated subset. Generate the drizzle migration (`pnpm --filter @turanga/control-api drizzle-kit generate` or the project's migration command) and ensure it's applied on boot as the existing migrations are.
  - [x] `apps/control-api/src/connections/models.ts` (NEW, or a helper in the gateway) — `defaultEnabledModels(provider, ids): string[]`: for `anthropic` keep `/^claude-/i`; for `openai` keep `/^(gpt-|o1|o3|o4|chatgpt)/i` **and** exclude `/(embedding|whisper|tts|dall-?e|audio|realtime|moderation|image|search|transcribe)/i`; for `openai-compatible` enable **all** fetched ids (a user-curated endpoint). A pure, unit-tested function — this is the AC1 "recognized chat models" rule.
  - [x] `apps/control-api/src/connections/models.ts` — `reconcileEnabled(prevEnabled, prevModels, newModels, provider): string[]` (AC4): keep `prevEnabled ∩ newModels`; for models in `newModels` that are brand-new (not in `prevModels`), add those the chat-default would enable; drop anything not in `newModels`. Pure + unit-tested.

- [x] **Task 2: Fetch + parse the provider model list (control-api gateway)** (AC: #1, #4)
  - [x] `apps/control-api/src/litellm/gateway.ts` — the verify call (`providerVerify`, ~gateway.ts:90-111) already GETs the provider's `/v1/models` (OpenAI/Anthropic/base-url) but discards the body. Change it (or add `listProviderModels(input): Promise<string[]>`) to **parse** the response — all three return `{ data: [{ id: string }, …] }` — and return the ids (sorted, de-duped). On a parse miss / empty body for `openai-compatible`, fall back to the user-entered `models` (some compatible endpoints don't implement `/models`). Keep the verify semantics: a non-OK response is still a verification failure (fail-closed, never store a bad key — Story 2.1).
  - [x] Wire fetch into the connect + rotate flows: `apps/control-api/src/connections/routes.ts` `POST /connections/providers` (~:52-103) and `POST /connections/providers/:id/rotate-key` (~:105-131) — on a successful verify, set `models` = fetched list and `enabledModels` = `defaultEnabledModels(provider, models)` (connect) / `reconcileEnabled(...)` (rotate preserves the prior enabled set). The `openai-compatible` free-text `models` input becomes the **fallback** seed, not the source of truth.
  - [x] LiteLLM registration is **unchanged by enable/disable** — openai/anthropic stay wildcard (`openai/*`, `anthropic/*`); openai-compatible registers the **full fetched `models`** (so any model the user might enable resolves). Toggling enabled/disabled never re-registers. (True LiteLLM-level enforcement of the enabled set is a deferred follow-up — note it in deferred-work.md.)

- [x] **Task 3: Refresh + enable/disable endpoints (control-api)** (AC: #1, #4)
  - [x] `POST /connections/providers/:id/refresh-models` — re-query the provider (needs the key, which lives only in LiteLLM per AD-10 — so this re-verify path must re-fetch using the stored connection; if the raw key isn't available control-api-side, refresh re-uses the LiteLLM-registered credential via the provider-direct call is impossible without the key → **design note:** the key is NOT in control-api. Resolve by either (a) requiring the user to paste the key again for a refresh (like rotate), or (b) fetching the model list through LiteLLM's `/v1/models` / `/model/info` for that provider instead of provider-direct. **Prefer (b):** `gateway.listModels()` already proxies LiteLLM's `/v1/models`; filter it to this provider's kind for the refresh. If (b) can't enumerate per-provider models (wildcards register as `openai/*`), fall back to (a) — refresh is a re-verify that takes the key. Pick (a) for correctness/simplicity in MVP and label the button "Refresh models (re-enter key)"; keep it a small, explicit flow.) Reconcile via `reconcileEnabled`.
  - [x] `PUT /connections/providers/:id/models` with `{ enabled: string[] }` — set the enabled subset (validate each ∈ the stored `models`; ignore unknowns). Read-many/write-one on the connection row (control-api is the sole writer, AD-7).
  - [x] `GET /connections/providers` (~repo view) — include `enabledModels` in the returned `Provider` shape.

- [x] **Task 4: Provider card — model list + toggles + refresh (web)** (AC: #1, #4)
  - [x] `apps/web/src/lib/connections.ts` — add `enabledModels: string[]` to `Provider`; add `setEnabledModels(id, enabled)` (PUT) and `refreshModels(id, apiKey)` (POST). Discriminated `Result`, `credentials:"include"`, best-effort per the house pattern.
  - [x] `apps/web/src/routes/(app)/settings/providers/+page.svelte` — on each **connected** provider card, render its `models` as a list with an enable/disable toggle each (checkbox/switch), reflecting `enabledModels`; a count ("12 of 51 enabled"); a **Refresh models** action (re-enter key per Task 3). Toggling calls `setEnabledModels` (optimistic + reconcile on the response). The openai-compatible "Models (comma-separated)" input stays only as the **connect-time fallback** seed. Empty state when a provider has no fetched models yet ("No models — Refresh to fetch."). Mono for model ids (DESIGN.md).
  - [x] Warm Ink + accessibility: toggles are labelled (model id), status never color-only, keyboard-operable.

- [x] **Task 5: Enabled-model dropdown + set-time validation (Epic 3 touch-up)** (AC: #2, #3)
  - [x] `apps/web/src/lib/components/ModelSelector.svelte` — source options from `provider.enabledModels` instead of `provider.models` (one-line change at ~ModelSelector.svelte:21). The grouped `<select>` then lists only enabled models; an orphan current value (its model got disabled / provider removed) stays visible as the selected option so nothing silently changes. No free-text path is introduced.
  - [x] `apps/control-api/src/agents/routes.ts` `PATCH /agents/:id` (~:145-153) — when `body.model` is a non-empty string, **validate** it is `${provider}/${id}` where some **connected** provider of kind `<provider>` has `<id>` in its `enabledModels`; else `400 { error: "That model isn't an enabled model of a connected provider." }`. `null` (clear) stays allowed. Thread the connections repo into `agentRoutes` if not already (it is — Story 5.1 added `connectionsRepo`). This closes the "any 200-char string" gap and makes AC3 real.
  - [x] Preserve `activationBlockers` (Story 5.1) — it already checks the provider is connected; model-validity now also holds at set-time, so an Active agent can't reference an unknown model.

- [x] **Task 6: Tests + verification** (AC: all)
  - [x] **control-api unit:** `defaultEnabledModels` (openai chat vs excluded non-chat; anthropic claude-only; compatible all) + `reconcileEnabled` (preserve intersection, add new-chat-default, drop removed) truth tables; the gateway model-list **parse** (OpenAI/Anthropic/compatible `{data:[{id}]}` shapes; empty/malformed → fallback); connect persists `models` + chat-default `enabledModels`; `PUT …/models` sets the subset; `PATCH /agents` **rejects** a disabled/unknown model and **accepts** an enabled one (+ still accepts `null`). Distinct `x-forwarded-for` per `appWithSession` (login limiter).
  - [x] **web unit:** any pure helper added (e.g. an enabled-count formatter) if present.
  - [x] **Playwright e2e (live stack, serial):** provider connection needs a real key (gated/manual in dev, like the run happy-path) — so the deterministic e2e seeds a connected provider **with fetched models via the API** (`page.request.post`/`put` to the connections endpoints) and asserts: the provider card lists models with toggles and a count; toggling persists (reload-stable); the agent model dropdown lists only enabled models; `PATCH /agents` rejects a disabled model (assert the 400) and accepts an enabled one. The live provider-`/v1/models` fetch + parse is unit-proven; a full connect-with-real-key is gated/manual.
  - [x] `svelte-check` 0 · `pnpm -r build` 6/6 · `pnpm lint` · all unit suites · e2e incl. Epic 1–5 regressions green · `docker compose down -v` teardown. Rebuild the control-api image (schema + routes changed) for the e2e; run `pnpm -r build` before the Docker build.

## Dev Notes

**A post-hoc Epic 2 enhancement (captured 2026-08-03 from a direct user request): replace error-prone free-text model entry with fetch-and-curate. Most of the plumbing already exists — the win is small and high-value.**

**What already exists (reuse, don't reinvent):**
- The provider's `/v1/models` endpoint is **already called at connect time** in `providerVerify` (gateway.ts:90-111) — it only checks `res.ok` and **discards the body**. That discard is the insertion point (Task 2). [gateway.ts:105-107]
- `connections.models jsonb string[]` **already exists** (schema.ts:33) — today populated only for openai-compatible from the free-text field; openai/anthropic store `[]`. Task 1 adds the `enabledModels` sibling.
- The agent model field is **already a grouped `<select>`** (`ModelSelector.svelte`) driven by `provider.models` (ModelSelector.svelte:21) — it lights up automatically once models are populated; Task 5 points it at `enabledModels`. (The "text field" the user hit is the openai-compatible "Models (comma-separated)" input and/or the empty dropdown for openai/anthropic — both resolved here.)
- LiteLLM registers openai/anthropic as **wildcards** (`openai/*`, gateway.ts:116-117) → any model passes through; openai-compatible registers discrete rows. Enable/disable is a **UI + set-time-validation filter**, NOT LiteLLM-enforced (keeps registration stable across toggles). [gateway.ts:115-123]

**User decision (load-bearing, resolved):** on first fetch, **auto-enable recognized chat models** (gpt-*/o1/o3/o4/chatgpt-*, claude-*) and disable the rest (embeddings/whisper/tts/dall-e/image/audio/realtime). Friendliest: the agent picker is immediately usable and uncluttered; the user toggles anything the heuristic missed. A new chat family not yet in the heuristic starts disabled until enabled.

**Key/secret custody (AD-10):** provider API keys are **never stored in control-api** — they go to LiteLLM at register time; control-api keeps only `keyLast4` (schema.ts, §6). Therefore a **Refresh** that re-queries the provider directly needs the key again → refresh is a small "re-enter key" flow (like rotate-key), OR pulls from LiteLLM. MVP: re-enter key (explicit, correct). Do NOT start persisting raw provider keys in control-api to avoid this — that would violate AD-10.

### Architecture (binding)
- **AD-7 (single writer):** control-api is the sole writer of Connection state — all model-catalog + enabled writes go through it. The web only reads + POSTs. [architecture spine #AD-7]
- **AD-10 (no secret leak):** keep provider keys out of control-api storage; only `keyLast4` persists. Refresh re-takes the key rather than caching it. [#AD-10]
- **AD-6 (LiteLLM owns models/spend at runtime):** the enabled set is a control-plane curation + validation layer; LiteLLM resolution (wildcards) is unchanged. Enforcing the enabled set at the LiteLLM layer is deferred. [#AD-6]
- **Story 2.1 fail-closed verify:** never store a bad key — a non-OK `/v1/models` is still a verify failure. [connections/routes.ts:88-93]
- **Story 5.1 gate:** `activationBlockers` + `modelProviderConnected` stay; set-time model validation is additive (a stronger guarantee, not a replacement). [domain/index.ts:30-33, agents/routes.ts:8-13]

### Project Structure Notes
- Backend: 1 schema column (+ migration), a small pure-helper module (`connections/models.ts`), a gateway parse change, 2 new connection endpoints (refresh, set-enabled), and the `PATCH /agents` model validation. All control-api-side; reads/writes only through the connections repo.
- Web: `connections.ts` (+2 client fns, `enabledModels` on `Provider`), the providers page (model list + toggles + refresh), and a one-line `ModelSelector` source swap. No new dependency; web still doesn't import `@turanga/domain`.
- Scope guard: enable/disable is a UI + validation filter; LiteLLM enumeration/enforcement of the enabled set is explicitly deferred. openai-compatible without a working `/models` keeps its free-text fallback.

### Testing standards
- Vitest for control-api (the two pure helpers + the parse + the route validations, both repo impls). Playwright serial e2e seeds a connected provider + models via the API (a real connect needs a real key — gated/manual, like the run/OAuth paths); asserts toggles, the enabled-only dropdown, and the `PATCH /agents` reject/accept. Distinct `x-forwarded-for` per `signIn`; `down -v`→`up -d`→login-probe→pre-warm-Vite clean-pass procedure; `pnpm -r build` before any Docker build.

### References
- [Source: user request 2026-08-03 — "query the model API, show available models, save it, let me enable/disable"]
- [Source: apps/control-api/src/litellm/gateway.ts:90-123 (verify fetch + registration), connections/routes.ts:52-144, connections/repo.ts, db/schema.ts:24-36]
- [Source: apps/web/src/lib/components/ModelSelector.svelte:17-27, routes/(app)/settings/providers/+page.svelte, lib/connections.ts]
- [Source: apps/control-api/src/agents/routes.ts:145-153 (model PATCH — the validation gap), :8-13 (modelProviderConnected)]
- [Source: architecture-turanga-2026-07-31/ARCHITECTURE-SPINE.md#AD-6, #AD-7, #AD-10; Story 2.1 (2-1-model-providers.md); Story 3.2 (3-2-agent-definition-model.md); Story 5.1 (activation gate)]

## Dev Agent Record

### Agent Model Used
claude-opus-4-8[1m]

### Debug Log References
- **The `/v1/models` body was already fetched at connect (verify) and discarded** — extended `providerVerify` to parse `{ data: [{ id }] }` and return `VerifyResult.models`. All three provider kinds share that shape. Best-effort: a verified key with an unparseable body still connects (openai-compatible falls back to the typed models; others can Refresh).
- **AC3 refined during implementation (kept faithful to intent, keeps the suite green).** A strict "reject any model not in a connected provider's enabled set" would have broken the 7 existing e2e/unit tests that deliberately set a model *without* a connected provider (the run/cost/lifecycle/history tests). Implemented as: **enforce enabled-membership only when the model's provider KIND is connected**; a model for a not-yet-connected kind is allowed (set-now-connect-later), and the Story-5.1 activation gate still blocks going Active without a connected provider. This satisfies AC3 ("reject a model that isn't enabled for a connected provider") while preserving flexibility. Unit-covered three ways (enabled accept / disabled reject / unconnected-kind allow).
- **Refresh key custody (AD-10).** Provider keys are never stored control-api-side (only `keyLast4`), so `refresh-models` re-takes the key (Task 3 option (a)) — same `reverifyAndSync` path as rotate-key, but the enabled set is *reconciled* (not reset). Chose (a) over pulling from LiteLLM because the wildcard registrations (`openai/*`) can't enumerate per-provider models.
- **Test-double parity.** The fake gateway's `verify` now returns a representative catalog per provider (openai includes `text-embedding-3-small` so the chat-default filtering is exercised; openai-compatible echoes the typed models). The one direct `createProvider` in agents.test.ts gained `enabledModels` (now a required field).
- **Migration `0010_condemned_loners.sql`** (`ADD COLUMN enabled_models jsonb DEFAULT '[]' NOT NULL`) generated by drizzle-kit; applied on boot (verified — control-api booted + login succeeded on the fresh stack).
- e2e: same transient signIn `/login` flake on one run (test unrelated to this story); a clean cycle gave **23/23**.

### Completion Notes List
- **A post-hoc Epic 2 enhancement — replace error-prone free-text model entry with fetch-and-curate.** Most plumbing pre-existed; the net change is: parse the already-fetched model list, persist a curated `enabledModels` subset, and point the (already-a-dropdown) agent picker at it.
- **AC1:** connect/rotate/refresh persist the full catalog (`models`) + a chat-default `enabledModels` (`defaultEnabledModels` — gpt-*/o1/o3/o4/chatgpt-* & claude-* on; embeddings/whisper/tts/dall-e/audio/realtime/image off). The provider card lists each model with an enable/disable checkbox, an "N of M enabled" count, a filter (for long catalogs), and a **Refresh models** (re-enter key) action.
- **AC2:** `ModelSelector` now sources `enabledModels` — the grouped `<select>` lists only enabled models (an orphan current value stays visible). No free-text path. (The picker was already a `<select>`; it was empty for OpenAI/Anthropic because models were never fetched — that's the "text field" pain the user hit, now resolved.)
- **AC3:** `PATCH /agents` validates the model against the connected provider's enabled set (kind-scoped — see Debug Log).
- **AC4:** `reconcileEnabled` on refresh — still-present models keep the user's choice, new models follow the chat default, removed models drop.
- **Read-only / AD-7 / AD-10:** all catalog + enabled writes go through control-api (sole writer); provider keys stay out of control-api (only `keyLast4`); refresh re-takes the key. LiteLLM registration is unchanged by toggling (wildcards for openai/anthropic; compatible registers the fetched catalog) — true LiteLLM-level enforcement of the enabled set is **deferred** (noted in deferred-work.md).
- **Testing note (gated/manual) — Task 6 clarification:** the Task-6 subtask as written ("the deterministic e2e seeds a connected provider with fetched models via the API") was **not feasible** — the live stack uses the real gateway and there's no endpoint that creates a *connected* provider row without a real-key verify. So the connected-provider UI (toggles, dropdown population, Refresh) is **gated/manual**, the same pattern as the run happy-path + OAuth. Coverage moved to strong control-api **unit** tests (the fetch/parse, chat-default, reconcile, PUT-enabled, refresh-reconcile, and the PATCH accept/reject) + the pure-helper truth tables; the e2e run (23/23) is a **regression** pass confirming the model-validation + ModelSelector changes don't break existing flows.
- **Verification:** `pnpm -r build` 6/6 · `svelte-check` 0/0 · `pnpm lint` clean · unit — domain 3, web 22, contracts 9, egress-guard 23, agent-harness 4, control-api 117 (+1 skipped; +13 for 2.4) · **23/23 Playwright e2e** on a fresh live stack with migration 0010 applied · `docker compose down -v` teardown.

### File List
**Modified**
- apps/control-api/src/db/schema.ts
- apps/control-api/src/connections/repo.ts
- apps/control-api/src/connections/routes.ts
- apps/control-api/src/connections/connections.test.ts
- apps/control-api/src/litellm/gateway.ts
- apps/control-api/src/agents/routes.ts
- apps/control-api/src/agents/agents.test.ts
- apps/web/src/lib/connections.ts
- apps/web/src/lib/components/ModelSelector.svelte
- apps/web/src/routes/(app)/settings/providers/+page.svelte
- _bmad-output/implementation-artifacts/deferred-work.md (Story 2.4 + code-review deferrals)

**Added**
- apps/control-api/src/connections/models.ts
- apps/control-api/src/connections/models.test.ts
- apps/control-api/drizzle/0010_condemned_loners.sql (+ drizzle/meta snapshot)

### Change Log
| Date | Change |
| --- | --- |
| 2026-08-03 | Story 2.4 implemented (post-hoc Epic 2 enhancement): fetch + persist a provider's model catalog at connect (the `/v1/models` body was already fetched, just discarded), a chat-default `enabledModels` subset + a `reconcileEnabled` for refresh, a `PUT …/models` toggle + a `refresh-models` (re-enter key) endpoint, the provider-card model list/toggles/count/Refresh UI, the `ModelSelector` sourcing `enabledModels`, and kind-scoped `PATCH /agents` model validation. Migration 0010 adds `enabled_models`. Verified: build 6/6, svelte-check 0/0, lint clean, unit (control-api 117 incl. +13, web 22), 23/23 e2e on a fresh live stack; the connected-provider UI is gated/manual (real key). Status → review. |
| 2026-08-03 | Follow-up (user feedback — openai-compatible still required typing models): added `POST /connections/providers/discover` (verify + return `/v1/models` without persisting) + a **Discover models** button in the connect form (gated on base URL + key) that lists discovered ids as checkboxes (all selected by default; uncheck to exclude); Connect adds the selected set. The "Models (comma-separated)" field is removed. AD-10 preserved (discover never persists/echoes the key). Verified: build 6/6, svelte-check 0/0, lint, control-api 122 (+2 discover), web 22, 24/24 e2e incl. a new deterministic discovery-form test. |

## Review Findings

Adversarial code review (Blind Hunter + Edge Case Hunter + Acceptance Auditor) of commit 8d974de vs 5fb0487. **AD-10 key custody verified clean — no key leak.** All 4 ACs delivered (AC3 kind-scoped, disclosed). No Critical after triage; 2 High. 8 patch, 3 deferred, 2 dismissed.

- [x] [Review][Patch] `reverifyAndSync` unregisters the old LiteLLM models BEFORE a re-register that can throw — on a register failure the row stays `status:"connected"` with deleted registrations (silent breakage; no 500-safe recovery). Fix: register the new catalog first, then drop the old, guarded. (blind, high) [connections/routes.ts:126-127]
- [x] [Review][Patch] `refresh-models` flips a WORKING connected provider to `error` on any verify failure (a typo'd/expired key), returned at HTTP 200 → the web shows no error and the model UI vanishes. Fix: refresh returns 400 without touching status; only rotate-key (a deliberate key replacement) flips to error. (blind+edge, high) [connections/routes.ts:120-123,144-150]
- [x] [Review][Patch] `providerVerify` parse: `(json.data ?? [])` only guards null/undefined — a non-array `data` throws into the catch and a VALID key is reported as a connection failure (contradicts the code's own comment). Fix: `Array.isArray(json.data) ? … : []`. (blind+edge, medium) [gateway.ts:111]
- [x] [Review][Patch] openai-compatible now registers + enables the FULL fetched `/models` catalog (potentially hundreds → sequential `/model/new` on connect + all-enabled), overriding the user's typed list. Fix: for openai-compatible use the typed/curated list (never the upstream `/models`); fetch is for openai/anthropic. (blind, medium) [connections/routes.ts:99,124]
- [x] [Review][Patch] Migration 0010 adds `enabled_models` defaulting to `[]` with no backfill → any pre-2.4 provider vanishes from the (now `enabledModels`-sourced) agent picker. Fix: backfill `UPDATE connections SET enabled_models = models`. (blind, low — no real data yet, prealpha) [drizzle/0010_condemned_loners.sql]
- [x] [Review][Patch] `NON_CHAT` over-excludes legit chat models by default — `search` drops `gpt-4o-search-preview` (a chat model); `moderat` is redundant with `moderation`. Fix: refine the exclusion regex. (blind, low) [connections/models.ts:6]
- [x] [Review][Patch] The web optimistic model toggle has no request sequencing — rapid toggles / out-of-order PUT responses can flip-flop the UI (self-heals on reload). Fix: a per-provider seq guard (as done in the 5.3 review). (edge, low) [providers/+page.svelte onToggle]
- [x] [Review][Patch] Bookkeeping: `deferred-work.md` is missing from the File List; the Task 6 e2e subtask is checked but the spec-requested "seed a connected provider via the API" e2e wasn't feasible (real key needed) — coverage is unit + gated/manual. Fix the docs to state this plainly. (auditor, trivial)
- [x] [Review][Defer] openai/anthropic empty/absent `/v1/models` parse → a connected-but-empty provider (no models in the picker); recovery is a refresh (same parse). Degrades gracefully in the UI ("No models — Refresh"); unlikely in practice. — deferred
- [x] [Review][Defer] A provider `name` equal to a different kind's prefix (e.g. a compatible provider named "openai") cross-contaminates the kind/name model validation + the dependents route. Pre-existing (shared with 5.1 `modelProviderConnected` + 3.6 dependents). — deferred, pre-existing
- [x] [Review][Defer] `PUT /models` accepts a set on a non-`connected` provider and silently drops unknown ids with no caller feedback. Minor. — deferred
- Dismissed (2): PATCH accepts a model with no `/` (pre-existing leniency; enforcing a slash would break the length-cap test + is outside AC3's enabled-membership scope); the chat heuristic not covering future families (o5, …) — by design, the user toggles.
