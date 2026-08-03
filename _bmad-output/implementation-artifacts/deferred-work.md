# Deferred Work

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
