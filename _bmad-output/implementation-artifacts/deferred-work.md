# Deferred Work

## Deferred from: code review of Epic 1 / story-1.4 (2026-07-31)
- SameSite=Lax will not carry the session cookie in a multi-domain deploy (web and control-api on different sites). Revisit when moving off single-machine: either same-origin (reverse proxy) or SameSite=None+Secure.
- WEB_ORIGIN is a single exact origin; multi-origin/deploy setups need this generalized.
- CSRF protection is SameSite=Lax only — acceptable while all mutating endpoints are JSON+POST; add an Origin/Referer check or CSRF token before adding state-changing GET/form-encoded routes.
- ULID suffix is non-monotonic within a millisecond (random suffix). Fine until something depends on id ordering; switch to a monotonic ULID/UUIDv7 then.
