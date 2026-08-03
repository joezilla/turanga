---
baseline_commit: f8d28d91280a84fe19bc6bedd9b6d27d91121bbd
---
# Story 4.6: Filter hook seam

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As the builder,
I want an inspection seam in the Guard,
so that content scanning can be added later without rework.

## Acceptance Criteria

1. **Given** no registered filter, **when** traffic passes the Guard, **then** the Filter Hook is a **no-op and does not alter behavior**. [Source: epics.md#Story-4.6 AC1, FR-10; E4-AD-6]
2. **Given** a trivial test filter that blocks a sentinel string, **when** a matching payload passes, **then** it is **demonstrably blocked and recorded** — proving the seam works end to end. [Source: epics.md#Story-4.6 AC2, FR-10; E4-AD-6]

## Tasks / Subtasks

- [x] **Task 1: Formalize the Filter Hook interface + wire both inspection points** (AC: #1, #2)
  - [x] `apps/egress-guard/src/guard.ts` — align the existing `FilterHook` (wired at the mode-a point in Story 4.4) to the E4-AD-6 signature `inspect(direction, meta, body?) → allow | block(reason)`: generalize `direction` to `"egress" | "ingress"` and add an optional `body?: unknown`. Keep `NOOP_HOOK` as the default (`GuardConfig.filterHook` unset ⇒ no-op).
  - [x] Invoke the hook at BOTH connection-gateway points (E4-AD-6 / FR-10 "ingress/egress payloads"), after the permission + allowlist/credential checks (a filter runs only on egress that would otherwise be permitted):
    - **egress** — before the adapter forward: `filterHook("egress", { destination: adapter.host, op: req.op }, req.params)`; a block ⇒ the existing egress refusal (kind `egress`) with the hook's reason.
    - **ingress** — on the adapter's returned data, before it re-enters the sandbox: `filterHook("ingress", { destination: adapter.host, op: req.op }, result.data)`; a block ⇒ a refusal (kind `egress`) stating the ingress was blocked (the sandbox gets a refusal, not the data).
  - [x] Add a **registrable sentinel test hook** factory: `sentinelFilterHook(sentinel: string): FilterHook` — blocks (`{ allow: false, reason: "…matched the content filter…" }`) when the serialized `{ meta, body }` contains `sentinel`, otherwise passes. This is the "trivial test filter" that proves the seam; NOT a real inspector.
  - [x] **The seam is an interface + registration point, not scanning logic** (E4-AD-6). Do NOT build a real content/PII inspector — that's the deferred injection-resistant reference monitor. The plain-egress (mode-b) CONNECT point is **deferred with mode-b** (Story 4.3 scope) — note that the same hook serves it when mode-b lands.

- [x] **Task 2: Optional registration for a live demo (fail-open to no-op)** (AC: #1, #2)
  - [x] `apps/egress-guard/src/server.ts` — if `GUARD_FILTER_SENTINEL` is set, register `sentinelFilterHook(that value)`; otherwise leave the default **no-op** (production ships no inspector, FR-10). `deploy/compose.yaml` + `deploy/.env.example` document the optional env (unset by default — the hook must not alter behavior).

- [x] **Task 3: Tests + verification** (AC: all)
  - [x] **Guard unit (Vitest):** (AC1) with the **default (no-op) hook**, an otherwise-allowed connection op forwards unchanged (same result as before the hook) — the no-op does not alter behavior; (AC2) with a **registered sentinel hook**, an **egress** payload containing the sentinel (e.g. in `params`) is **blocked + recorded** as a refusal (the adapter is never called); an **ingress** response containing the sentinel is **blocked** (the sandbox gets a refusal, not the data); a non-matching payload **passes** through. Reuse the injected-`fetch` + `emitRunEvent` harness from the 4.3–4.5 guard tests.
  - [x] Confirm the hook does NOT run on the **model call** (`proxyModel`) — model-provider egress is the cost-metered path (AD-2), not the filter-hook path. (No change to `proxyModel`; note it.)
  - [x] `svelte-check` 0 · `pnpm -r build` 6/6 · `pnpm lint` · all unit suites · e2e incl. Epic 1–3 + 4.1–4.5 regressions green (the default no-op must leave every prior behavior intact) · `docker compose down -v` teardown · no leaked run containers.

## Dev Notes

**The FINAL Epic 4 story — formalize + prove the Filter Hook seam. Small by design: the no-op `FilterHook` interface was ALREADY wired in Story 4.4 at the mode-a connection-forward point. 4.6 (a) aligns the signature to E4-AD-6 (`direction` + `body?`), (b) also wires the ingress (response) point so `direction` is real (FR-10 "ingress/egress payloads"), and (c) proves the seam with a registrable sentinel-blocking test hook + a refusal record. NOT building a real inspector.**

**No user forks — the shape is fully determined by E4-AD-6 + the existing 4.4 wiring. No contract change, no web change, no migration.**

### Architecture (the spines govern — inherited, binding)
- **E4-AD-6 (the crux):** the Filter Hook is a **synchronous interface in the Guard** — `inspect(direction, meta, body?) → allow | block(reason)` — invoked at both Guard points (**credentialed-gateway body, plain-egress connect**). A **no-op hook is registered by default and must not alter behavior**; a **trivial sentinel-blocking test hook proves the seam end-to-end** (this story). The seam is **an interface + registration point, not scanning logic**.
- **AD-2:** the Guard is one choke point with two policy modules — **model-provider destination → cost meter + kill** (LiteLLM, Story 4.5); **anything else → default-deny allowlist + filter hook**. So the filter hook governs **connection/plain egress, NOT the model call**.
- **AD-5:** the filter hook runs at both Guard modes — (a) credentialed-connection gateway, (b) plain allowlisted CONNECT egress. Mode-b is deferred (Story 4.3), so only the mode-a point exists to wire now; the same hook serves mode-b when it lands.
- **Fail-closed unchanged (NFR-2):** a filter **block** becomes a refusal (never a silent pass); the no-op default passes (does not alter behavior). Ordering: permission (4.4) → allowlist/credential (4.3) → **filter hook** → forward; a filter only inspects egress that is otherwise permitted.

### PRD / FR (verbatim intent)
- **FR-10:** the Guard exposes a **defined Filter Hook interface at which inspection logic can run on ingress/egress payloads, without shipping an inspector in MVP**. Glossary: "A defined extension point in the Guard where inspection logic (e.g. secret/PII scanning) can be added later without changing agents. **No inspector ships in MVP.**"
- **Out of scope (prd.md):** "Ship a content-inspection / PII engine. The Filter Hook (FR-10) is in; the inspector is not." — the real inspector is the deferred, roadmap injection-resistant reference monitor.

### Current state (READ — the seam already exists from 4.4)
[Source: apps/egress-guard/src/guard.ts]
- `export type FilterHook = (direction: "egress", meta: { destination: string; op: string }) => { allow: true } | { allow: false; reason: string }` + `const NOOP_HOOK: FilterHook = () => ({ allow: true })` (guard.ts ~L49-53). **What changes:** generalize `direction` to `"egress" | "ingress"`, add `body?: unknown`. **What's preserved:** the no-op default; the `{ allow } | { allow:false, reason }` verdict shape.
- `GuardConfig.filterHook?` (guard.ts ~L124) defaults to `NOOP_HOOK` (`const filterHook = cfg.filterHook ?? NOOP_HOOK`, ~L165). **Preserve.**
- `forwardConnection` (guard.ts ~L245-265) already invokes the hook at the egress point (`filterHook("egress", { destination, op })`) → a block becomes an egress refusal (~L260-262). **What changes:** pass `req.params` as the body; add the ingress invocation on `result.data` before returning `{ ok:true, data }`. **What's preserved:** the permission→allowlist/credential→filter→forward order; the fail-closed refusal on a block.
- **A 4.4 guard test already registers a sentinel-style `filterHook: () => ({ allow:false, reason:"blocked by test sentinel" })`** ("a no-op filter block refuses…") — 4.6 makes that a first-class `sentinelFilterHook` + proves both directions.

### Files being modified (small surface)
- **`apps/egress-guard/src/guard.ts` (UPDATE):** the `FilterHook` signature (+`direction: "ingress"|"egress"`, `body?`), the ingress invocation in `forwardConnection`, `sentinelFilterHook` factory. Preserve the no-op default + all 4.1–4.5 behavior (per-run socket, allowlist/credentials/grants, permission-first, cost key, breach detection).
- **`apps/egress-guard/src/guard.test.ts` (UPDATE):** no-op-doesn't-alter + sentinel egress/ingress block + pass-through.
- **`apps/egress-guard/src/server.ts` (UPDATE):** optional `GUARD_FILTER_SENTINEL` registration (default no-op).
- **`deploy/compose.yaml` + `deploy/.env.example` (UPDATE):** document the optional env (commented/unset).
- **No changes:** contracts, web, control-api, harness, DB. (The filter block reuses the existing `egress` refusal kind — no contract bump.)

### Previous-story intelligence (4.1–4.5)
- The guard test harness (`captureGmailFetch`, `withGrants`/`withGuard`, `emitRunEvent` capturer) is established — reuse it. A registered connection with `FULL_GRANT` + a credentialed connection reaches the filter-hook point (permission + allowlist + credential all pass), so a sentinel egress/ingress block is unit-testable there.
- **Dev/live reality:** the filter runs only on **permitted** egress (after the allowlist + credential pass), which needs a credentialed Gmail connection (OAuth) — so a *live* sentinel block is **gated/manual** (like the Gmail happy path + the cost breach). The seam is **fully proven by unit tests** driving `forwardConnection` with a registered sentinel hook — that IS the end-to-end guard path. No new e2e is required; the existing e2e proves the **no-op default** leaves all prior behavior intact (AC1).
- **Refusal kind:** a filter block reuses `egress` (the contract's `egress | permission`) with a clear detail — no new kind, no contract change. (A dedicated `filter` kind is a future refinement if the inspector lands.)
- **Known deferrals (do not reopen):** the real content/PII inspector (roadmap); mode-b plain egress + its connect-time filter point (Story 4.3 deferral); the 4.1–4.5 review deferrals.

### Security invariants (must hold — do not regress)
- **No-op default must not alter behavior (AC1):** with `filterHook` unset, every 4.1–4.5 path behaves identically (all regressions green). Production ships no inspector (FR-10).
- **Fail-closed:** a filter block is a **refusal** (recorded), never a silent drop or a pass; the sandbox receives a refusal, not the blocked payload (egress: not forwarded; ingress: the data is withheld).
- **The filter never sees a secret it shouldn't:** it inspects the connection request `params` (egress) + the response `data` (ingress) — NOT the held credential/token (which the Guard attaches after the egress hook and never places in `data`). Isolation from 4.1 unchanged.
- **Not on the model path (AD-2):** the hook does not run on `proxyModel` (model-provider egress is cost-metered, not filtered).

### Testing standards
- **Unit (Vitest):** no-op default = unchanged forward (AC1); sentinel hook blocks a matching egress payload (adapter never called) + a matching ingress response (data withheld) + passes a non-matching payload (AC2). In-memory injected fetch; no Docker.
- **E2E:** the existing suite (Epic 1–3 + 4.1–4.5) must stay green with the default no-op (proving AC1 doesn't break anything); a *live* sentinel block is gated/manual (needs a credentialed connection).
- `svelte-check` 0, build 6/6, lint clean, all regressions green.
- **DoD:** the Filter Hook matches E4-AD-6's `inspect(direction, meta, body?)`; the no-op default doesn't alter behavior; a registered sentinel hook demonstrably blocks + records a matching egress and ingress payload through the real `forwardConnection` path; no real inspector shipped; mode-b's connect-time point noted as deferred.

### Project Structure Notes
- Modified: `apps/egress-guard/src/{guard,server}.ts` + `guard.test.ts`, `deploy/compose.yaml` + `.env.example`. No new packages, no contract/web/DB changes. This closes Epic 4 (Sandboxed Execution & the Guard). [E4 spine E4-AD-6; AD-2/AD-5]

### References
- [Source: epics.md#Epic-4 / Story-4.6 (AC1-2), story-map; FR-10]
- [Source: architecture/epic-4-execution-plane/ARCHITECTURE-SPINE.md — E4-AD-6; inherited AD-2/AD-5; Deferred (content inspector, mode-b)]
- [Source: prds/prd-turanga-2026-07-31/prd.md — FR-10 :153-154; glossary :52/:54; out-of-scope :231/:239]
- [Source: apps/egress-guard/src/guard.ts (FilterHook, NOOP_HOOK, forwardConnection); apps/egress-guard/src/guard.test.ts (the existing sentinel-block test); apps/egress-guard/src/server.ts]
- [Source: _bmad-output/implementation-artifacts/4-3-allowlist-credentialed-egress.md, 4-4-skill-permission-enforcement.md, 4-5-cost-metering-kill-on-breach.md, deferred-work.md; project-context.md]

## Dev Agent Record

### Agent Model Used
claude-opus-4-8[1m]

### Debug Log References
- e2e flakes while iterating were test-harness artifacts, not 4.6 regressions: (a) the fresh-DB-dependent tests (#19 empty state, #46/#170 first-agent/provider state) fail if the stack isn't `down -v`'d between runs; (b) the login rate-limiter trips past ~20 logins per control-api process. A clean cycle (`down -v` → poll `/health` ONLY, no manual logins → run once) gives a clean 20/20. Verified.

### Completion Notes List
- Closed Epic 4 by formalizing + proving the Filter Hook seam (E4-AD-6/FR-10). The interface (wired no-op in 4.4) now matches `inspect(direction, meta, body?)`: `direction` generalized to `"egress" | "ingress"`, `body?` added.
- Wired the hook at BOTH connection-gateway points (making `direction` real, FR-10 "ingress/egress payloads"): **egress** on the outbound request `params` (before the credentialed forward), **ingress** on the returned `data` (before it re-enters the sandbox). A block → a refusal (fail-closed); the no-op default passes unchanged. It runs only on otherwise-permitted egress (after permission + allowlist + credential) and never sees the held credential.
- Added `sentinelFilterHook(sentinel)` (blocks when the serialized meta/body contains the sentinel) + optional `GUARD_FILTER_SENTINEL` registration in `server.ts` — default stays **no-op** (no inspector ships, FR-10).
- **AC1** proven by the full e2e (20/20 green with the no-op default — every 4.1–4.5 behavior intact) + a unit test (no-op = unchanged forward). **AC2** proven by 3 unit tests through the real `forwardConnection` path: a sentinel-matching egress payload is blocked + recorded (adapter never called); a sentinel-matching ingress response is withheld as a refusal (data never reaches the sandbox); a non-matching payload passes. A *live* sentinel block needs a credentialed connection (the filter runs after the credential check, which dev's no-OAuth path refuses first) — gated/manual, consistent with the Gmail happy-path + the cost breach.
- **No** contract, web, control-api, harness, or DB changes. The filter block reuses the existing `egress` refusal kind (a dedicated `filter` kind is a future refinement if the inspector lands). The hook is not on the model path (AD-2). Mode-b's connect-time point stays deferred with mode-b.

### File List
**Modified**
- apps/egress-guard/src/guard.ts
- apps/egress-guard/src/guard.test.ts
- apps/egress-guard/src/server.ts
- deploy/compose.yaml
- deploy/.env.example

### Change Log
| Date | Change |
| --- | --- |
| 2026-08-02 | Story 4.6 implemented (closes Epic 4): formalized the Filter Hook to `inspect(direction, meta, body?)`, wired egress + ingress inspection at the connection gateway (no-op default), added `sentinelFilterHook` + optional `GUARD_FILTER_SENTINEL` registration. Verified: build 6/6, svelte-check 0/0, lint clean, guard unit 22 (+4), all unit suites, 20/20 e2e on a fresh live stack (no-op default = no regressions), gated integration, no leaked containers. Status → review. |
