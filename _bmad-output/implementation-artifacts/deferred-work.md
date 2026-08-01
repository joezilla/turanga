# Deferred Work

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
