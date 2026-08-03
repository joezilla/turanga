---
baseline_commit: 393a6a7bb92d7eba7680ed2e52ac1b2c0d793f9f
---
# Story 4.5: Live cost metering and kill-on-breach

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As the builder,
I want spend metered and hard-stopped,
so that the caps I set are real.

## Acceptance Criteria

1. **Given** an agent with caps, **when** it runs, **then** each model call carries a **per-agent key (daily budget)** and a **per-run key (per-run cap)**, and the **live meter reflects run and daily spend**. [Source: epics.md#Story-4.5 AC1, FR-12, AD-6; E4-AD-5]
2. **Given** either cap is reached, **when** the next model call is made, **then** **LiteLLM refuses it** and the **orchestrator reaps the run within one model round-trip** (Run → `killed`); **spend cannot exceed the cap regardless of harness behavior**. [Source: epics.md#Story-4.5 AC2, FR-12, NFR-3, AD-6; E4-AD-5]
3. **Given** a completed run, **when** its spend is displayed, **then** **the meter matches the summed run metrics** (no drift). [Source: epics.md#Story-4.5 AC3, FR-12]

## Tasks / Subtasks

- [x] **Task 1: Contract (v4) — real cost + the Guard→orchestrator event channel** (AC: #1, #2, #3)
  - [x] `packages/contracts/src/index.ts` — **bump `CONTRACT_VERSION` to `4`**. Rename the `metrics` message field `costMinor` → **`costMicros`** (integer **micro-USD**, 1e-6 USD — enough precision for sub-cent per-call costs like `$0.0041`; caps stay `Money` in cents and convert `cap.minor * 10_000` for comparison). Update the web `RunMessage` mirror + fixtures.
  - [x] Add the **Guard→orchestrator event contract** (E4-AD-10, the out-of-band control-plane channel): `GuardRunEventSchema` = a discriminated union on `type` — `{ type: "metrics", v, latencyMs, tokens, costMicros }` and `{ type: "kill", v, scope: z.enum(["run","day"]), detail? }` (a budget breach). (Refusals stay harness-relayed this story — see scope.)
  - [x] Add the **per-run cost key** to the register provision shape (guard-side + guardClient, below) — a control-plane secret, never in the jobSpec (AD-10).

- [x] **Task 2: LiteLLM gateway — mint the key hierarchy + read spend** (AC: #1, #3)
  - [x] `apps/control-api/src/litellm/gateway.ts` — add to `ModelGateway` (+ `fakeModelGateway`): `ensureAgentTeam(agentId, perDayCap: Money | null): Promise<string>` (team_id — `POST /team/new` with `team_alias = agentId`, `max_budget = <perDay USD>`, `budget_duration: "1d"`; idempotent — reuse by alias / cache; omit `max_budget` when the cap is null); `mintRunKey({ teamId, perRunCap: Money | null, runId }): Promise<string>` (`POST /key/generate` with `team_id`, `max_budget = <perRun USD>` when set, `key_alias = run-<runId>`, `duration: "2h"` TTL); `deleteKey(key): Promise<void>` (`POST /key/delete` `{ keys: [key] }`, best-effort); `teamSpendMicros(teamId): Promise<number>` (`GET /team/info` → `info.spend` USD → micros — **best-effort, lags ~60s**; used for the daily display only, never for enforcement).
  - [x] **`max_budget` is USD dollars (float)** — convert `Money.minor` (cents) → dollars (`minor / 100`). Master key (existing `httpModelGateway` construction) authorizes all of these.

- [x] **Task 3: Guard — attach the per-run key, meter real cost, detect breach, call back** (AC: #1, #2, #3)
  - [x] `apps/egress-guard/src/guard.ts` — per-run state gains **`costKey`** (from the register provision). `proxyModel(runId, req)` uses **the per-run cost key** (not the master key) as the `Authorization` bearer for `/v1/chat/completions`. Read the **per-call cost** from the LiteLLM response header **`x-litellm-response-cost`** (USD → micros; fallback 0 if absent).
  - [x] **Budget-breach detection (CRITICAL — it's HTTP 400, not 429):** LiteLLM returns **HTTP 400** with `error.message` containing `"Budget has been exceeded"` / `"ExceededBudget"` / `"ExceededTokenBudget"` (429 is only rate-limits / the `/v1/models` hook). Detect a breach = `status === 400 && /budget|exceeded/i.test(message)`; classify `scope` (`"day"` if the message mentions team/`ExceededBudget`, else `"run"`).
  - [x] **Out-of-band callback (E4-AD-10):** after each model call, POST a `metrics` event `{ latencyMs, tokens, costMicros }` to control-api; on a breach, POST a `kill` event `{ scope }`. New `GuardConfig`: `controlCallbackUrl` + `callbackToken` (a shared secret; sent as a header). Best-effort/fire-and-forget with a short timeout — a lost callback must not hang the model response. `teardown` clears `costKey` (the orchestrator deletes the LiteLLM key).
  - [x] The model response back to the harness still returns `{ ok, text?, error?, tokens?, latencyMs? }` (no cost — cost is the Guard's out-of-band truth now, E4-AD-10). `server.ts` wires the new config from env.

- [x] **Task 4: control-api — mint keys, receive Guard events, reap-on-breach, persist cost** (AC: #1, #2, #3)
  - [x] `apps/control-api/src/runs/guardClient.ts` — `RunProvision` gains `costKey: string` (the minted per-run key). `fakeRunGuard` records it.
  - [x] `apps/control-api/src/runs/orchestrator.ts` — in `validateAndCreate`/`resolveRunConnections`: read `agent.costCap` (add `costCap` to `AgentLike` + the reader), `ensureAgentTeam(agentId, perDay)` then `mintRunKey({teamId, perRun, runId})`, put the key in the provision (fail-closed: a mint failure fails the Run). Establish order (E4-AD-8): **mint key → register (with key + allowlist + grants) → establish → run**. `finally`: `deleteKey(costKey)` alongside teardown (always).
  - [x] **Reap-on-breach + metrics merge:** add a per-run **controller registry** so a Guard callback can act on a live run. Expose `orchestrator.handleGuardEvent(runId, event)`: a `metrics` event → append a `metrics` `ControlChannelMessage` + `hub.publish` (streams + persists — this REPLACES the harness metrics emit, E4-AD-10); a `kill` event → set a per-run `breached = { scope }` flag + `handle.kill()`. In `execute`, after the stream ends, **`breached` (like `timedOut`) wins the terminal**: Run → `killed` with a composed reason ("Killed — per-run cost cap reached ($0.50)." using the agent's cap + the event scope). Register the controller after `establish`, delete it in `finally`.
  - [x] **The callback route:** `apps/control-api/src/runs/routes.ts` (or a sibling) — `POST /internal/guard/runs/:id/events`, authenticated by a **constant-time `GUARD_CALLBACK_TOKEN`** compare (mirrors the guard-admin pattern, reverse direction), body = `GuardRunEventSchema` → `orchestrator.handleGuardEvent`. This endpoint is NOT behind the web session (it's control-plane, guard→control-api).
  - [x] **Persist the cost summary (no drift, AC3):** add a `cost_micros` integer column to the `runs` table (migration) + `RunRow.costMicros`; at `finish`, set it to the **sum of the run's `metrics` costMicros** (the same numbers the meter shows → equal by construction). Add `RunsRepo.sumTodayMicros(agentId)` (sum `cost_micros` of the agent's runs created today) for the daily meter. Expose `GET /agents/:id/cost` → `{ todayMicros, perRunCapMinor, perDayCapMinor }` (session-guarded) for the test-pane daily line.
  - [x] `app.ts` + `server.ts` — wire the `modelGateway` into the orchestrator (for minting), the controller registry, the callback token, and the new route.

- [x] **Task 5: Harness — stop emitting metrics (the Guard owns cost now)** (AC: #1, #3)
  - [x] `apps/agent-harness/src/main.ts` — **remove the `metrics` emit** (E4-AD-10: the harness emits only `turn` + `done`; the Guard reports `metrics` out-of-band). Keep the phased skill run, the relayed `refusal` (harness-relayed this story — deferred), turns, and `done`. The model response no longer carries cost.

- [x] **Task 6: Web — the cost meter + the killed reason** (AC: #1, #2, #3)
  - [x] `apps/web/src/lib/money.ts` — add `formatMicros(micros)` → `"$0.0041"` (micro-USD, ≥4 dp). `apps/web/src/lib/runs.ts` — `RunMessage` mirror `costMinor`→`costMicros`, `v: 4`; a `getAgentCost(id)` client for `GET /agents/:id/cost`.
  - [x] `apps/web/src/routes/(app)/agents/[id]/+page.svelte` — the metrics line gains **cost** with the middot: **`428 ms · 1,284 tokens · $0.0041`** (mono/tabular, ≥12px). Add a compact **run cost-meter**: **`run $0.0041 / $0.50`** and **`today $0.0413 / $5.00`** (fetched via `getAgentCost` on completion; neutral until near a cap; caps from the agent). On a **killed** run (breach), the run-status dot resolves to **`killed`** (caution — the `RunStatusDot` already supports it) with the reason ("Killed — per-run cost cap reached ($0.50).") shown inline (the run's `reason`). The metrics line + meter are the run's summed cost (matches AC3 by construction).
  - [x] The agents-list Active daily meter stays a **placeholder** (Active-only; Epic 5) — no change here.

- [x] **Task 7: Tests + verification** (AC: all)
  - [x] **Contract unit:** `costMicros` on `metrics`; `GuardRunEventSchema` parses `metrics` + `kill`; a wrong version is rejected.
  - [x] **Gateway unit (injected fetch):** `ensureAgentTeam` posts `/team/new` with `budget_duration:"1d"` + the per-day USD (omitted when null); `mintRunKey` posts `/key/generate` with `team_id` + per-run USD + TTL and returns the key; `deleteKey` posts `/key/delete`; cents→dollars conversion. `fakeModelGateway` doubles.
  - [x] **Guard unit (injected fetch):** `proxyModel` attaches the **per-run cost key** (not master); reads `x-litellm-response-cost` → `costMicros`; a **400 "Budget has been exceeded"** is detected as a breach (scope classified) and a `kill` callback is POSTed; a normal call POSTs a `metrics` callback; a failed callback doesn't break the response.
  - [x] **control-api unit:** the orchestrator mints team+key (fakeGateway), puts the key in the provision, **never in the jobSpec** (assert); `deleteKey` runs in `finally`; `handleGuardEvent({kill})` → the run resolves `killed` with a cap reason (reuse the fake runtime + a controller); `handleGuardEvent({metrics})` → a `metrics` message is appended + published (drift-free: `finish` sets `cost_micros` = summed metrics); `sumTodayMicros`; the callback route rejects a bad token (constant-time).
  - [x] **Harness unit:** the harness no longer emits `metrics` (assert the emitted sequence is turn/…/done with no metrics).
  - [x] **Playwright e2e (live stack, serial — append to `tests/agents.spec.ts`):** an agent with caps set → run → the **metrics line shows a cost** (`… · $…`, even `$0.0000` with no provider key) sourced from the Guard callback, and the **run/today meter** renders; the run resolves terminally. (A real **breach→killed** needs a configured provider + a tiny cap to accrue spend — a **gated/manual** check; the kill LOGIC is unit-proven via `handleGuardEvent`.)
  - [x] **Gated integration** (`RUN_SANDBOX_IT`): the live run still streams + reaps; the per-run key is minted + deleted; no key/cost-key in the transcript.
  - [x] `svelte-check` 0 · `pnpm -r build` 6/6 · `pnpm lint` · all unit suites · e2e incl. Epic 1–3 + 4.1–4.4 regressions green · `docker compose down -v` teardown · **no leaked run containers or LiteLLM keys**.

## Dev Notes

**Fifth Epic 4 story — make the caps real, and build the out-of-band Guard→orchestrator channel that 4.2–4.4 deferred. Scope confirmed with the user (2026-08-02):**
- **Cost + kill on the new channel now; refusals stay harness-relayed.** Build the Guard→control-api HTTP callback for **cost `metrics`** (the Guard reads LiteLLM's per-call cost) and the **breach `kill`** signal (E4-AD-5 "the Guard signals the orchestrator"). This realizes the **cost half of E4-AD-10** and moves metrics off the sandbox; moving the 4.3/4.4 **refusal** records onto the channel is a **deferred follow-up** (they work harness-relayed; the Guard already owns the decision).
- **Kill mechanism: Guard → control-api callback (push).** The Guard POSTs per-run events to a new internal, token-authenticated control-api endpoint; the orchestrator reaps the container + marks the run `killed` immediately ("within one model round-trip"). Literal E4-AD-10 control-plane path.
- **Enforcement reality (from the LiteLLM API research):** a budget block on `/v1/chat/completions` is **HTTP 400 `BudgetExceededError`** (message "Budget has been exceeded"), **not 429** — the ACs/spine say "429" but the code must match the **message**. Enforcement is **"eventually hard"**: an in-memory/Redis counter on the hot path, DB reconciled ~60s; under concurrency a small overrun can slip (docs: ≤~10 reqs at high RPS). **MVP trusts LiteLLM (AD-6 defers reserve-then-reconcile)** — the spend guarantee is LiteLLM's, not the harness's; the orchestrator's kill merely reaps a run that can no longer progress.

**Do NOT build:** reserve-then-reconcile / own-accounting overlay (AD-6 deferred), moving refusals out-of-band (chosen scope), the agents-list Active daily meter (Epic 5), mid-stream SSE "close on breach" beyond reaping the run, multi-tenant/multi-window budgets, the real Filter Hook (4.6), the Activate flow (Epic 5).

### Architecture (the spines govern — inherited, binding)
- **E4-AD-5:** at run start the orchestrator **mints a per-run LiteLLM key** (child of the agent's daily-budget key) with the per-run cap as its budget, hands it to the **Guard** (never the sandbox — AD-10). The Guard attaches it when forwarding a model call. On a **breach**, the Guard signals the orchestrator, which **reaps the sandbox + marks the Run `killed` within one model round-trip**. The live meter reads spend from LiteLLM; **the persisted Run summary must equal the summed run metrics (no drift)**.
- **E4-AD-10:** the harness emits **only `turn` + `done`**; the **Guard reports `metrics` (cost/tokens), `refusal`, and 429-kill to the orchestrator over the control-plane path** (Guard→orchestrator, NOT sandbox I/O). The orchestrator **merges both** into the Run + SSE. **Cost + refusal truth is the Guard/LiteLLM, never the harness.** (4.5 realizes cost + kill; refusals deferred.)
- **AD-6:** every model call carries a **per-agent virtual key (daily budget)**; the **per-run cap is a short-lived per-run key minted under it**. **Spend cannot be exceeded because LiteLLM refuses the call** regardless of harness behavior. Cap **config** is owned by control-api (pushed into LiteLLM keys); **spend** is owned by LiteLLM (Postgres/Redis) and only read elsewhere. **MVP trusts LiteLLM; reserve-then-reconcile is Deferred.**
- **AD-7 / E4-AD-7:** the `runs` table is written **only** by the orchestrator; **nobody writes spend — LiteLLM owns it, all others read**. On completion, terminal status + transcript + **summed metrics** + refusals persist. Spend shown is read from LiteLLM / summed metrics, **never recomputed**.
- **AD-8 lifecycle:** `created → running → (succeeded | failed | killed)`. **`killed` = the deliberate cap-breach reap** (this story) — distinct from `failed` (a fail-closed error). **E4-AD-8 fail-closed order:** mint key → register → establish → run; any step failing → `failed`; reap + Guard teardown + **key deletion** always run.
- **NFR-3:** kill-on-breach + the meter hold under concurrent runs; no undercount that silently exceeds. (MVP: LiteLLM's hard budget; the small overrun window is the documented, accepted limitation until reserve-then-reconcile.)

### PRD / FR (verbatim intent)
- **FR-11:** two caps per agent — per-run (max spend for any single Run) + per-day (max cumulative daily); per-day resets at day start.
- **FR-12:** meter spend live against both caps + **terminate an in-progress Run when either is reached** (kill within one model round-trip); the live meter reflects the current run's spend (vs per-run cap) **and** the day's cumulative spend (vs per-day cap); **a per-run breach kills the Run only; a per-day breach kills the Run AND refuses further Runs until the day resets**; the meter's reported spend for a completed Run **matches the sum of its Run metrics (no drift)**.
- **NFR-3:** enforcement holds under concurrency; no silent undercount. **SM-3:** across a battery, no Active agent exceeds its cap; every breach terminates the in-progress run.

### LiteLLM API reference (verified mid-2026, docs.litellm.ai — implementation-ready)
- **Team (per-agent daily):** `POST /team/new` `{ team_alias, max_budget: <USD float>, budget_duration: "1d" }` → `{ team_id, budget_reset_at }`. Idempotent by alias — look up / cache the `team_id` per agent.
- **Key (per-run cap):** `POST /key/generate` `{ team_id, max_budget: <USD float>, key_alias: "run-<id>", duration: "2h" }` → `{ key }`. A child key's spend **rolls up to the team**; a request is blocked when **either** the key or the team budget is exceeded (spend flows up the hierarchy).
- **Budget block:** `POST /v1/chat/completions` → **HTTP 400**, `{ error: { message: "Budget has been exceeded! …" | "ExceededBudget: Crossed spend within team" | "ExceededTokenBudget: …", type: "auth_error", code: 400 } }`. Match the message, not the status. Enforcement is at request start (in-flight calls aren't retro-cancelled); spend counter is in-memory/Redis, DB reconciled ~60s (`proxy_batch_write_at`).
- **Per-call cost:** the proxy adds the **`x-litellm-response-cost`** response header (USD). Read it for `costMicros`.
- **Read spend:** `GET /key/info?key=…` → `info.spend` (USD); `GET /team/info?team_id=…` → team `spend`. **Lags ~60s** — display only, never enforcement.
- **Delete key:** `POST /key/delete` `{ keys: [key] }`. (Short `duration` also auto-expires it.)
- **Auth:** all admin endpoints use the **master key** bearer. `max_budget` is **USD dollars (float)** — convert from `Money.minor` cents (`/100`).
- **Deploy:** the `litellm/litellm-database` image + `store_model_in_db` + Redis (already in `deploy/compose.yaml`) support keys/budgets/spend with the existing master key — **no compose change required to mint keys**; add the `GUARD_CALLBACK_TOKEN` + `CONTROL_API_URL` env for the new callback (control-api + egress-guard), and consider `general_settings`/`litellm_settings` for budget tuning (optional).

### UX specifics (DESIGN.md / EXPERIENCE.md)
- **Cost meter:** live, mono/tabular — **`today $0.0413 / $5.00`** (day spend vs per-day cap) + current-run vs per-run cap; **neutral until near a cap**; the **killed** state uses `--state-killed` (caution) when a cap stops a run. [DESIGN.md:70-72/128, EXPERIENCE.md:63/105, UX-DR20]
- **Metrics line:** each turn carries **`428 ms · 1,284 tokens · $0.0041`** (the middot format 4.2 left room for), IBM Plex Mono + tabular-nums, **≥12px**. [DESIGN.md:54/127, EXPERIENCE.md:104]
- **Killed dot + copy:** killed reads **caution**, distinct from failed; dot + word (never colour-only). Canonical copy: **"Killed — per-day cost cap reached ($5.00)."** (compose the per-run analogue with the cap amount). [DESIGN.md:21/98, EXPERIENCE.md:49/109] The `RunStatusDot` already renders `killed` (caution, fixed in the 4.2 review).

### Files being modified (READ current state — preserve behavior)
- **`packages/contracts/src/index.ts` (UPDATE):** v4; `metrics.costMicros`; `GuardRunEventSchema` (metrics | kill).
- **`apps/control-api/src/litellm/gateway.ts` (UPDATE):** `ensureAgentTeam` / `mintRunKey` / `deleteKey` / `teamSpendMicros` + fakes.
- **`apps/egress-guard/src/guard.ts` (UPDATE):** per-run `costKey`; `proxyModel(runId, req)` uses it + reads the cost header + detects the 400-budget breach + the callback POSTs (metrics/kill). Preserve 4.1-4.4 (per-run socket, allowlist/credentials/grants, permission-first, fail-closed). `app.ts`/`server.ts`: parse `costKey` in register; wire callback config.
- **`apps/control-api/src/runs/orchestrator.ts` (UPDATE):** mint keys (from `agent.costCap`) → provision; the controller registry + `handleGuardEvent` (metrics/kill); breach-wins terminal; delete key in `finally`. Preserve the 4.1-4.4 establish order, concurrency slot, reap+teardown, credential/grant provisioning, token-not-in-jobSpec.
- **`apps/control-api/src/runs/guardClient.ts` (UPDATE):** `RunProvision.costKey`.
- **`apps/control-api/src/runs/routes.ts` (UPDATE):** the internal callback route; `GET /agents/:id/cost`. Keep the SSE relay + `POST /runs`.
- **`apps/control-api/src/runs/repo.ts` + `db/schema.ts` (UPDATE):** `cost_micros` column + migration; `RunRow.costMicros`; `finish` sets it; `sumTodayMicros`.
- **`apps/control-api/src/agents/*` (UPDATE):** the orchestrator's agent reader must expose `costCap`.
- **`apps/agent-harness/src/main.ts` + `main.test.ts` (UPDATE):** remove the `metrics` emit.
- **`apps/web/src/lib/money.ts` + `runs.ts` + the detail page (UPDATE):** `formatMicros`, `getAgentCost`, the metrics-line cost + the run/today meter + the killed reason.
- **`deploy/compose.yaml` (UPDATE):** `GUARD_CALLBACK_TOKEN` (control-api + egress-guard) + `CONTROL_API_URL` (egress-guard). `deploy/.env.example` updated; never commit `.env`.
- **e2e + integration tests (UPDATE):** cost line + meter; key mint/delete + no-leak.

### Previous-story intelligence (4.1–4.4 + Epic 3)
- **The Guard** holds per-run `{ server, allowlist, credentials, grants }` and forwards via `proxyModel` (master key today) + `forwardConnection` (gmailAdapter). `proxyModel` is where the cost key + breach detection land; the header comment already flags "4.5 swaps the master key for the per-run cost key + adds kill-on-429". The Guard has NO channel back to control-api today — that's the new callback.
- **The orchestrator** `execute` has the `timedOut` pattern (flag + `handle.kill()` + terminal `killed`) — the breach reuses it exactly (`breached` flag). The metrics message currently comes from the harness (4.2) via stdout → this story moves it to the Guard callback and **removes the harness emit**. The concurrency-slot reserve/release + fail-closed order + always-teardown are load-bearing (4.2 review) — thread the key mint/delete into them.
- **Contract discipline:** source emit-sites use `CONTRACT_VERSION`; only the web mirror + test fixtures carry a literal (bump to `4`). `metrics.costMinor` is currently hardcoded `0` in the harness — that emit is REMOVED (the Guard reports real cost).
- **Cost caps (Epic 3):** `CostCap { perRun, perDay }`, `Money { minor, currency:"USD" }` (cents). `agents.cost_cap` jsonb. Web `CostCapsEditor` + `money.ts` (`formatMinor`, `parseDollarsToMinor`, `CURRENCY`). The agents-list `.meter` + the detail `lastMetrics` line are the display seams.
- **Auth patterns:** the guard-admin token uses a constant-time `timingSafeEqual` compare — mirror it for the reverse `GUARD_CALLBACK_TOKEN`. `deploy/.env` is gitignored; only `.env.example` is committed.
- **Dev/e2e reality:** no provider key → model calls fail (no spend) → the meter shows `$0.0000`; the cost line + meter + key mint/delete are still exercised. A real **breach** needs a configured provider + a tiny cap to accrue spend → **gated/manual**; the kill LOGIC (breach-detect + reap) is fully unit-tested with injected 400 responses + `handleGuardEvent`.
- **Known deferrals (do not reopen):** the 4.1-4.4 review deferrals (guard socket reaper, tenancy, secrets-in-prod, transcript caps, error-copy polish, mode-b egress, allowlist-editor UI); this story's deferrals (reserve-then-reconcile, refusals out-of-band, Active list meter, multi-window budgets).

### Security invariants (must hold — do not regress)
- **No secret in the sandbox (AD-10):** the per-run cost key is passed control-api → Guard (register body) + held Guard-side; **never** in the jobSpec or any UDS response (assert). The master key stays out of the sandbox (it always has).
- **Spend ≤ cap is LiteLLM's guarantee, not the harness's:** the Guard uses the capped per-run key; LiteLLM refuses the call regardless of harness behavior. The orchestrator's kill reaps a run that can no longer progress.
- **The callback is control-plane, authenticated:** `POST /internal/guard/runs/:id/events` requires the constant-time `GUARD_CALLBACK_TOKEN`; it is NOT web-session-guarded and must not be reachable as a web route. A bad/absent token → 403. The runId is path-scoped; the orchestrator ignores events for unknown/terminal runs.
- **Fail-closed (E4-AD-8):** a key-mint / register / establish failure fails the Run; teardown + **key deletion** always run (no leaked LiteLLM keys). Any Guard error still refuses egress (4.3/4.4 unchanged).
- **Isolation unchanged:** `--network=none`, per-run UDS, Docker socket only in control-api, `SANDBOX_RUNTIME` explicit/fail-closed.

### Testing standards
- **Unit (Vitest):** gateway mint/delete/spend (injected fetch); Guard cost-key + `x-litellm-response-cost` + 400-budget breach-detect + callbacks; orchestrator mint→provision (key-not-in-jobSpec) + `handleGuardEvent` kill→`killed` + metrics→append/publish + `finish` cost = summed metrics (no drift) + `sumTodayMicros` + callback-token reject; harness no-metrics. In-memory; no Docker.
- **Integration (gated `RUN_SANDBOX_IT`):** live run streams + reaps; key minted + deleted; no key in the transcript.
- **E2E (Playwright, live, serial):** caps set → run → the metrics line shows cost + the run/today meter renders + terminal. (Breach→killed is gated/manual with a provider.)
- `svelte-check` 0, build 6/6, lint clean, Epic 1–3 + 4.1–4.4 regressions green.
- **DoD:** each model call carries the per-run key (under the per-agent team); the live meter shows run + today spend; a breach is detected (400/budget) and the orchestrator reaps → `killed` within one round-trip; the persisted run cost equals the summed metrics (no drift); the cost key is never in the sandbox and is deleted on teardown; only 4.5 scope (reserve-then-reconcile, refusals-out-of-band, Active list meter are marked seams).

### Project Structure Notes
- Modified: `packages/contracts`, `apps/control-api/src/litellm/gateway.ts`, `apps/egress-guard/src/{guard,app,server}.ts`, `apps/control-api/src/runs/{orchestrator,guardClient,routes,repo}.ts` + `db/schema.ts` (+ migration), `apps/control-api/src/{app,server}.ts` + the agents reader, `apps/agent-harness/src/main.ts`, `apps/web/src/lib/{money,runs}.ts` + the detail page, `deploy/compose.yaml` + `.env.example`, e2e + integration. New: a small run-controller registry (in the orchestrator or a `runs/controllers.ts`), the callback route. **One DB migration** (`runs.cost_micros`). Contract v4. [E4 spine Structural Seed; AD-5/6/7/8/10, E4-AD-5/10]

### References
- [Source: epics.md#Epic-4 / Story-4.5 (AC1-3), story-map :142; FR-11, FR-12, NFR-3, SM-3]
- [Source: architecture/epic-4-execution-plane/ARCHITECTURE-SPINE.md — E4-AD-5, E4-AD-7, E4-AD-8, E4-AD-10; inherited AD-2/6/7/8/10; Deferred (reserve-then-reconcile)]
- [Source: prds/prd-turanga-2026-07-31/prd.md — FR-11 :167, FR-12 :174, NFR-3 :288, SM-3 :256; addendum :17-20 (enforcement vs observability, concurrency race, reserve-then-reconcile)]
- [Source: docs.litellm.ai — /team/new, /key/generate, /key/info, /key/delete, x-litellm-response-cost; budget block is HTTP 400 BudgetExceededError; budget_duration reset; spend batch-write lag]
- [Source: ux-designs/ux-turanga-2026-07-30/DESIGN.md#components.cost-meter/#cost-caps-control (:70-72/:98/:127/:128); EXPERIENCE.md (:49/:63/:104/:105/:109), UX-DR20]
- [Source: packages/contracts/src/index.ts; apps/control-api/src/litellm/gateway.ts; apps/egress-guard/src/guard.ts; apps/control-api/src/runs/{orchestrator,guardClient,routes,repo}.ts; packages/domain (CostCap/Money); apps/web/src/lib/money.ts]
- [Source: _bmad-output/implementation-artifacts/4-1..4-4 story files, deferred-work.md; project-context.md]

### Review Findings — Epic 4 batch (4.3–4.6), 2026-08-02

_Cross-cutting Guard-security review of Stories 4.3–4.6 (diff 7b9b9ec..HEAD). Most findings land in 4.5's cost/kill machinery; 4.3/4.4/4.6 reference this section._

**Patches (unchecked = to fix):**
- [x] [Review][Patch] Callback token has no production fail-closed check — control-api `server.ts:95` + egress-guard `server.ts:20` default `GUARD_CALLBACK_TOKEN` to the well-known `"dev-guard-callback"` with no prod throw (unlike `GUARD_ADMIN_TOKEN`), so a forged `kill`/`metrics` POST could reap/corrupt any run out of the box. Mirror the admin-token prod throw. [apps/control-api/src/server.ts:95, apps/egress-guard/src/server.ts:20]
- [x] [Review][Patch] Guard request handler isn't fail-closed on a thrown hook — the egress `filterHook` (guard.ts:278) runs before the forward `try`, so a throwing hook (a real inspector, or `JSON.stringify` on an unserializable body) rejects `forwardConnection` → the UDS handler writes no response → the request hangs (NFR-2 violated). Wrap the `handle()` dispatch in try/catch → any throw becomes a written fail-closed error. [apps/egress-guard/src/guard.ts (register request handler / forwardConnection)]
- [x] [Review][Patch] `ensureAgentTeam` check-then-create race → duplicate teams → per-day cap bypass — two concurrent runs for the same agent (no team yet) both `/team/list`→empty→`/team/new`, creating two teams; the daily budget splits and the agent can spend ~2× the cap. Serialize per-agent team creation (in-process lock) for the single-instance MVP. [apps/control-api/src/litellm/gateway.ts:106] (NFR-3)
- [x] [Review][Patch] `proxyModel` fails OPEN to the master key when a registered run has no cost key — `costKey = runs.get(runId)?.costKey ?? cfg.litellmMasterKey` runs a registered-but-keyless run unmetered + unkillable (master key). Refuse the model call when a registered run has no cost key (fail-closed). [apps/egress-guard/src/guard.ts:213]
- [x] [Review][Patch] Budget breach races the in-band `done` → run mislabeled `failed` not `killed` — the async `kill` callback can land after the harness's stdout `done`, so both `if (breached)` checks see false. On a `failed` done, briefly settle (bounded ~150ms, resolvable by the controller) so an in-flight kill/final-metrics lands before finalizing; `.catch(() => {})` the `onKill` `activeHandle.kill()`. [apps/control-api/src/runs/orchestrator.ts:193/221] (AC2 live path; spend is still capped regardless)
- [x] [Review][Patch] Cost meter renders only post-run, not live — the metrics line + run/today meter sit inside the `succeeded|failed|killed` branch; AC1/DESIGN call for a **live** meter. Render the streamed metrics/meter during `running` too. [apps/web/src/routes/(app)/agents/[id]/+page.svelte:397]

**Deferred (logged to deferred-work.md):**
- [x] [Review][Defer] Per-run cost cap can't stop a single model call — LiteLLM admits a fresh key's first call (spend 0 < budget); the harness makes one call, so only the accumulating daily/team cap bites. Enforced across calls when multi-turn lands; reserve-then-reconcile is the deferred hardening (AD-6). [Med]
- [x] [Review][Defer] `ensureAgentTeam` `/team/update` on reuse may reset the daily budget window — verify LiteLLM doesn't reset `spend`/`budget_reset_at` on update; guard the update if it does. [Med]
- [x] [Review][Defer] Missing/NaN `x-litellm-response-cost` header → cost silently reads 0 — verify LiteLLM emits it in prod; consider a key-spend fallback. [Low]
- [x] [Review][Defer] In-memory controller registry / callback lost on a multi-instance control-api — same class as the in-memory RunHub + tenancy deferrals. [Low]
- [x] [Review][Defer] Daily meter window (UTC midnight) diverges from the enforced team window; wire the daily meter to `teamSpendMicros` (currently unused). [Low]
- [x] [Review][Defer] `budgetBreach` is coupled to LiteLLM's status/message prose — broaden / use a structured error code. [Low]
- [x] [Review][Defer] Gmail write ops (`label`/`send`) forward unvalidated params (empty `messageId`, verbatim `raw`) — validate; the write path is gated on OAuth + the no-op filter. [Low, 4.4]
- [x] [Review][Defer] `GET /agents/:id/cost` has no agent-ownership check — deferred multi-tenancy. [Low]

**Dismissed:** send-gate aggregate-OR (documented 4.4 aggregate-enforcement model — correct for the shipped skill set where only draft-reply is send-capable + UI-gated); `GET /agents/:id/cost` returning only `todayMicros` (functionally covered — the web already holds the caps).

## Dev Agent Record

### Agent Model Used
claude-opus-4-8[1m]

### Debug Log References
- Contract v4: `metrics.costMinor` → `costMicros` (micro-USD); `GuardRunEventSchema` (metrics | kill). Source emit-sites use `CONTRACT_VERSION`; web mirror + fixtures bumped to 4.
- LiteLLM budget block is **HTTP 400 "Budget has been exceeded"** (not 429, as the ACs/spine say) — the Guard matches the message; a team message → the `day` scope, else `run`. Per-call cost read from the `x-litellm-response-cost` response header.
- The Guard→orchestrator channel is a token-authenticated control-api callback (`POST /internal/guard/runs/:id/events`); the orchestrator holds a per-run **controller registry** so a callback can merge cost metrics or reap on breach — the breach reuses the 4.1 timeout pattern (`breached` flag + `handle.kill()`), and `breached` wins the terminal over the harness's `done`.
- A test's `emitRunEvent: (…) => events.push(…)` returned `number` (not `void`), which `pnpm -r test` didn't catch but the Docker `tsc` build did — wrapped in a block. (Reminder: run `pnpm -r build` after adding tests before a Docker build.)

### Completion Notes List
- Made the caps real + built the out-of-band Guard→orchestrator channel (E4-AD-10) that 4.2–4.4 deferred, per the confirmed scope (**cost + kill now; refusals stay harness-relayed**; **Guard→control-api HTTP callback**).
- **Key hierarchy (AD-6):** the orchestrator mints a per-agent LiteLLM **team** (daily budget, `budget_duration:"1d"`, idempotent by alias) + a per-run **key** under it (per-run cap, 2h TTL), hands the key to the Guard, and **deletes it on teardown** (no leaked keys — verified live). The Guard uses the per-run key for model calls → LiteLLM 400s when either budget is exceeded, capping spend **regardless of the harness**.
- **Kill (AC2):** the Guard detects the 400 budget block → POSTs a `kill` event → the orchestrator reaps the container + marks the run `killed` with a cap reason within one round-trip. Fully unit-tested (injected 400 + `handleGuardEvent`); the live breach is gated/manual (needs a real provider to accrue spend — dev has none, so the meter shows `$0.0000`).
- **Cost + no-drift (AC1/AC3):** the Guard reports each call's cost (`x-litellm-response-cost` → micro-USD) out-of-band; the orchestrator merges it as a `metrics` message (streamed + persisted) and the persisted `cost_micros` summary = the summed metrics **by construction** (the web meter sums the same events). The harness no longer emits metrics.
- **Web:** the metrics line gains cost (`428 ms · 1,284 tokens · $0.0041`); a run/today cost-meter (`run $… / $0.50 · today $… / $5.00`); the killed/failed reason inline. Verified live e2e (the Guard callback → cost line + meter render end-to-end).
- **Security:** the cost key is Guard-side only (never in the jobSpec — asserted); the callback is control-plane + constant-time-token-authed (403 without it, not a web route); fail-closed key deletion. Isolation from 4.1 unchanged.
- **Deferred (in scope / AD-6):** reserve-then-reconcile (LiteLLM enforcement is "eventually hard" — a small overrun window under concurrency, accepted); moving refusals out-of-band; the agents-list Active daily meter (Epic 5); multi-window budgets.

### File List
**New**
- apps/control-api/src/litellm/gateway.test.ts
- apps/control-api/drizzle/0009_modern_mordo.sql (+ drizzle/meta snapshot/journal) — the `runs.cost_micros` migration

**Modified**
- packages/contracts/src/index.ts + index.test.ts
- apps/control-api/src/litellm/gateway.ts
- apps/egress-guard/src/{guard,app,server}.ts + guard.test.ts
- apps/control-api/src/runs/{orchestrator,guardClient,routes,repo}.ts + runs.test.ts
- apps/control-api/src/db/schema.ts
- apps/control-api/src/{app,server}.ts + app.test.ts
- apps/agent-harness/src/main.ts
- apps/web/src/lib/{money,runs}.ts
- apps/web/src/routes/(app)/agents/[id]/+page.svelte
- apps/web/tests/agents.spec.ts
- apps/control-api/src/runs/{hub.test,sandbox.integration.test}.ts (v-fixture bumps)
- deploy/compose.yaml + deploy/.env.example

### Change Log
| Date | Change |
| --- | --- |
| 2026-08-02 | Story 4.5 implemented: contract v4 (costMicros + the Guard→orchestrator event channel), the LiteLLM team+key hierarchy (per-agent daily + per-run cap), the Guard per-run cost key + 400-budget breach detection + out-of-band cost/kill callback, the control-api callback route + controller registry + reap-on-breach + persisted cost summary (no drift) + the daily-spend endpoint, harness metrics removed, the web cost meter + killed reason. Verified: build 6/6, svelte-check 0/0, lint clean, unit (contracts 9, guard 18, control-api 92, harness 4), 20/20 e2e on a fresh live stack incl. the cost path, gated integration, no leaked containers/keys. Status → review. |
