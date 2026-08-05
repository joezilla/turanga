# Deferred Work

## Deferred from: code review of 8-6-learning-visibility-and-human-oversight (Epic 8, stories 8.4–8.6) (2026-08-05)
- **Same-millisecond changelog ordering** — `ulid()` uses a `Math.random()` suffix (not monotonic), so `memory_events` written within the same ms in one reflect pass (superseded/learned/reinforced) sort arbitrarily under `desc(at), desc(id)`. Cosmetic; the log content is correct. Fix needs a monotonic ULID factory (shared infra) or a per-agent event sequence column.
- **No cross-builder ownership check on memory routes** — every `/memory/agents/:agentId/*` route reads `agentId` from the URL under only `requireSession`; any authenticated operator can read/curate another builder's memories including full `content`. Pre-existing + consistent with `/agents`, `/runs`, `/connections` (single-operator / all-trusted posture in pre-alpha). Folds into the platform multi-tenancy / resource-ownership epic (see the `GET /runs` ownership item above) — close them together.
- **Concurrent reflect runs = unguarded read-modify-write** — reflect's dedupe→insert→prune are separate awaited calls with no transaction/row-lock on Postgres; two near-simultaneous runs for one agent can both insert a near-duplicate or over-prune. Pre-existing (8.4). The in-memory repo (tests) is single-event-loop-safe. Fix = wrap reflect's store mutations in a transaction or per-agent advisory lock.
- **Supersede inspects only the single nearest neighbor** — `findSimilar` returns one row, and supersede fires only if that nearest neighbor shares the topic; a same-topic stale fact shadowed by a closer different-topic memory is never closed, so contradictory facts co-accumulate. Pre-existing 8.4 dedupe design; fix = query top-N within `SUPERSEDE_MAX_DISTANCE` and match on topic.

## Deferred from: code review of 2-4-discover-curate-provider-models (2026-08-03)
- openai/anthropic whose `/v1/models` returns empty/unparseable connect as "connected" but with an empty catalog → no models in the agent picker; the only recovery is a refresh (same parse). The providers page shows "No models — Refresh to fetch." so it degrades gracefully; unlikely in practice (OpenAI/Anthropic always return a list). Consider a "connected, awaiting models" surface if it ever bites.
- A provider `name` equal to another kind's prefix (e.g. a compatible provider named "openai") cross-contaminates the kind/name matching in `PATCH /agents` model validation and the `/dependents` route (union of enabled sets across the collision). Pre-existing — shared with 5.1 `modelProviderConnected` and 3.6 dependents. Tighten to kind-only matching (with an explicit compatible-name namespace) when multi-provider-per-kind is real.
- `PUT /connections/providers/:id/models` accepts an enabled set on a non-`connected` provider and silently drops ids not in the catalog without telling the caller which were ignored. Minor; add a note in the response if it matters.

## Deferred from: Story 2.4 (discover + curate provider models) (2026-08-03)
- The enabled-model set is a UI + set-time-validation filter, NOT LiteLLM-enforced. openai/anthropic stay wildcard (`openai/*`), so a disabled model would still resolve at the LiteLLM layer if an agent somehow referenced it (the PATCH validation + the dropdown prevent that). True enforcement = register discrete enabled models instead of wildcards and re-register on toggle. Revisit if per-model enforcement (or per-model pricing/routing) is needed.
- `PATCH /agents` model validation is kind-scoped: it enforces enabled-membership only when the model's provider KIND is connected (a model for an unconnected kind is allowed — set-now-connect-later; the 5.1 activation gate catches it at go-live). If a stricter "must always be a known enabled model" is ever wanted, it needs the e2e/test setup to connect a provider first.
- The connected-provider model UI (toggles, dropdown population, Refresh) has no deterministic e2e — a real provider connection needs a real API key (gated/manual, like the run happy-path + OAuth). Coverage is unit-based. A stubbed provider `/v1/models` server in the e2e stack would let this be exercised end-to-end.

## Deferred from: code review of 5-3-run-history-observability (2026-08-03)
- Memory vs drizzle `list`/`listSummary` ordering parity: drizzle sorts by `desc(createdAt), desc(id)` while the memory repo returns insertion order (`unshift`, no createdAt sort) — they agree only while `createdAt` is monotonic with insertion. Pre-existing (inherited from `list`); the 5.3 tests use monotonic timestamps. Make the memory repo sort by createdAt to truly match if it ever matters for a test.
- `GET /runs` with no `agentId` returns up to 100 summaries across ALL agents to any authenticated session. Pre-existing; the web always scopes by agentId. Folds into the deferred multi-tenancy / run-ownership work (see the `GET /runs` ownership item above) — close them together.

## Deferred from: Story 5.2 (operate active agents — live status + spend) (2026-08-03)
- The agents-list live meter refreshes by a 5s visibility-aware **poll**, not SSE — there is no per-agent live-cost stream (SSE is per-run in the test pane, E4-AD-7) and the runs-table sum only advances at run-terminal, so sub-second liveness buys nothing. If a live in-flight tick on the list is ever wanted, add a per-agent cost SSE (fan-out) or fold cost into the existing run SSE; until then the poll is intentional.
- The list meter counts only **terminal** run cost (`cost_micros` persists at run end); an in-flight run's spend appears on the list only after it resolves. Live in-flight spend is a detail/test-pane concern (the per-run SSE meter). Revisit with the SSE-for-list item above if needed.

## Deferred from: code review of Epic 4 batch 4.3–4.6 (2026-08-02)
- Per-run cost cap can't stop a single model call (LiteLLM admits a fresh per-run key's first call; the harness makes one call → only the daily/team cap bites). Enforced across calls once multi-turn lands; reserve-then-reconcile is the AD-6 deferred hardening.
- `ensureAgentTeam` calls `/team/update` on every reuse — verify LiteLLM doesn't reset `spend`/`budget_reset_at` on a budget update (would slide the daily window and bypass the per-day cap); guard the update (only when the cap changed) if confirmed.
- Missing/NaN `x-litellm-response-cost` header collapses per-call cost to 0 (silent). Verify LiteLLM emits it in prod; consider a per-run key-spend fallback for the persisted summary.
- The Guard→orchestrator callback resolves against an in-memory `controllers` map (+ the in-memory RunHub) — kill/metrics are lost on a multi-instance / load-balanced control-api. Route callbacks by runId (sticky) or via shared state (DB/pubsub) when multi-instance lands. Same class as the tenancy deferral.
- The daily cost meter (`sumTodayMicros`, UTC midnight) diverges from LiteLLM's enforced team window (`budget_duration:"1d"` from team creation). Source the daily meter from `teamSpendMicros` (currently unused) to match the enforced window.
- `budgetBreach` classifies on HTTP 400 + a `budget|exceeded` regex — fragile to a LiteLLM status/wording change (a miss → no kill / wrong run-vs-day scope). Broaden + prefer a structured error code.
- Gmail write ops (`gmailAdapter` `label`/`send`) forward unvalidated params (empty `messageId` → `/messages//modify`; verbatim `raw`). Validate required params; the write path is currently gated on OAuth + the no-op filter.
- `GET /agents/:id/cost` (and run listing) has no agent-ownership check — any authenticated user reads any agent's spend. Close with the deferred multi-tenancy work.


## Deferred from: code review of 4-2-test-pane-streaming (2026-08-02)
- Test-pane error strings in `apps/web/src/lib/runs.ts` ("The control plane returned an unexpected response.", "Couldn't start the run (${status}).", "Can't reach the control plane.") state a cause but no consequence/recovery (AC2 wants cause→consequence→recovery). Low-value copy polish, partly shared with `$lib/agents`. Revisit if the error states get a dedicated pass.

## Deferred from: code review of Epic 1 / story-1.4 (2026-07-31)
- SameSite=Lax will not carry the session cookie in a multi-domain deploy (web and control-api on different sites). Revisit when moving off single-machine: either same-origin (reverse proxy) or SameSite=None+Secure.
- WEB_ORIGIN is a single exact origin; multi-origin/deploy setups need this generalized.
- CSRF protection is SameSite=Lax only — acceptable while all mutating endpoints are JSON+POST; add an Origin/Referer check or CSRF token before adding state-changing GET/form-encoded routes.
- ULID suffix is non-monotonic within a millisecond (random suffix). Fine until something depends on id ordering; switch to a monotonic ULID/UUIDv7 then.

## Deferred from: code review of 3-1-create-agent (2026-08-01)
- Same-ms list order not creation-ordered; memory(seq) vs drizzle(id) tiebreak divergence + the newest-first unit test only covers the memory path (repo.ts). Cosmetic for MVP.
- `agents.state` has no DB CHECK constraint and is blind-cast to `LifecycleState`; `StatusDot` renders any non-`active` value as grey "draft". Harden when lifecycle transitions land (Story 5.1).
- AD-7 single-writer unit test is vacuous (asserts only that `create` is a function). Improve to assert the invariant meaningfully.

## Deferred from: code review of 3-2 + 3-3 (2026-08-01)
- Autosave indicator: return to idle, per-field status (not one shared field), avoid aria-live chatter on every debounced keystroke.
- Save-failure Retry affordance (currently inert "retry" copy; next keystroke re-saves).
- Domain vs repo/web nullability divergence (`model?`/`variables?` optional vs `string|null`/required) — reconcile the shared Agent type.
- ModelSelector cosmetics: split full `provider/model-id` (multi-slash), surface unknown provider kinds, disambiguate two same-kind connections.
- Auth hardening: the login brute-force limiter keys on client-controllable `x-forwarded-for` — revisit keying/So a spoofed IP can't bypass it.

## Deferred from: code review of 3-4 + 3-5 + 3-6 (2026-08-01)
- Provider dependents are matched by provider KIND, not connection id — two same-kind providers can't be distinguished; refine once an agent's model carries a connection id.
- Three sources of truth for the built-in skill ids (domain `BuiltinSkill`, web `SkillId`, control-api `BUILTIN_SKILLS`) — consolidate when the shared Agent type is reconciled.
- `costCap` PATCH is a whole-object replace (a partial writer nulls the omitted side) — document, or switch to per-side merge.
- Dependents confirm concatenates all agent names unbounded + full agent-list scan per arm — cap/paginate at scale.
- A `$0.00` cost cap is accepted and indistinguishable from unset — revisit when caps are enforced (Epic 4).

## Deferred from: code review of 4-1 (2026-08-02)
- egress-guard: add a reaper/TTL for orphaned per-run sockets + http.Servers (teardown can be missed on a guard/control-api crash mid-run).
- POST /runs has no ownership/tenancy check (single-user MVP) — revisit if multi-tenant.
- Secrets (litellm master key, guard admin token) default to well-known values — a production-refusal / required-secret pass across all services.
- runs.transcript jsonb has no growth cap — revisit when multi-turn agent loops land (4.4).

## Deferred from: code review of 6-5-tool-invocation-observability (2026-08-03)
- Only the first granted operation per tool is invoked/recorded (agent-harness/src/main.ts:198). The Phase-1b harness stub calls `tool.operations[0]` only, so the per-tool aggregate structurally can't reflect a tool's other granted operations. Pre-existing 6.4 limitation; resolves when a model-driven tool-use loop replaces the deterministic stub.
- `GET /agents/:id/tool-stats` (and its sibling `/agents/:id/cost`) has no agent-ownership/existence check — any authenticated session can read any agent's stats. Fine for the single-tenant MVP; an IDOR to close if turanga becomes multi-tenant. Address the whole `/agents/:id/*` surface together.

## Deferred from: code review of Epic 8 stories 8.1–8.3 (2026-08-05)
- Recalled memory folded raw as system context = cross-run prompt-injection / memory-poisoning surface — mitigate in 8.4 (safe distillation/delimiting) + 8.6 (quarantine/oversight) + Epic 10 (evals).
- HNSW table-global index + per-agent post-filter can under-return for sparse agents (pgvector ef_search) — revisit with partial indexes / iterative scans at scale.
- Retention (`retentionDays`) is stored but not enforced; the Settings copy over-promises — add the reaper in a later story; consider a copy caveat now.
- Embedding dimension mismatch silently yields no recall (fail-open swallows) — add a length guard + operator log.
- Robustness cluster (single-operator, low impact): `setGlobalConfig` non-atomic RMW; purge non-atomic N+1 + UI ignores Result; `getAgentMemoryConfig` blind jsonb cast.
