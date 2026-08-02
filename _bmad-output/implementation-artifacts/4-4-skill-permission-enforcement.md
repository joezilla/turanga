---
baseline_commit: deceb43eb7bcedefa2b8b87360bee9014cf8ad40
---
# Story 4.4: Skill execution and permission enforcement at runtime

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As the builder,
I want skills to run only within their scope,
so that permissions are real, not decorative.

## Acceptance Criteria

1. **Given** attached, scoped skills, **when** the agent runs, **then** read/search, flag/label, and summarize **operate through the generic Connection interface** (a provider-agnostic skill→op layer; Gmail is the only implementation, and no email-specific logic lives in the skill/enforcement code paths). [Source: epics.md#Story-4.4 AC1, FR-17, SM-4; AD-5]
2. **Given** a skill invoked **outside its Permission Scope**, **when** attempted, **then** it is **refused and the refusal is recorded on the Run** (the `permission` refusal kind, surfaced as a refusal row). [Source: epics.md#Story-4.4 AC2, FR-3, NFR-4]
3. **Given** the **draft-reply skill without a send grant**, **when** the agent tries to send, **then** **sending is refused; the run produces a draft artifact and completes** (no auto-send). [Source: epics.md#Story-4.4 AC3, FR-18, AD-8]

## Tasks / Subtasks

- [x] **Task 1: Contract — generic connection ops + the skill/permission policy + refusal kind** (AC: #1, #2, #3)
  - [x] `packages/contracts/src/index.ts` — **bump `CONTRACT_VERSION` to `3`**. Replace the Gmail-named op with a **provider-agnostic op** vocabulary: `GuardConnectionRequestSchema.op = z.enum(["read", "label", "send"])` (the connection — not the op — resolves the destination + adapter, keeping ops provider-agnostic, SM-4). Generalize `params` to `z.record(z.string(), z.unknown()).optional()`.
  - [x] Add `kind` to the connection-refusal shape: `GuardConnectionResponseSchema.refusal = z.object({ destination: z.string(), detail: z.string(), kind: z.enum(["egress", "permission"]) })` so the harness relays the correct `refusal` control-message kind (the `permission` kind already exists on the control channel).
  - [x] Add the **generic skill/permission policy** (constants + a pure predicate — no schemas, no email specifics): `SkillScope = "none"|"read"|"read-write"`; `ConnectionOp = "read"|"label"|"send"`; `OP_REQUIREMENTS: Record<ConnectionOp, { requiredScope: "read"|"read-write"; requiresSend: boolean }>` (`read`→{read,false}, `label`→{read-write,false}, `send`→{read-write,true}); `SKILL_OPS: Record<string, ConnectionOp[]>` (`read-search`→[read], `summarize`→[read], `flag-label`→[label], `draft-reply`→[send]); `scopeRank(scope)`; and **`authorizes(grants: {scope,send}[], op): boolean`** = ∃ grant with `scopeRank(scope) ≥ scopeRank(required)` AND `(!requiresSend || send)` — the single shared enforcement predicate the Guard uses.
  - [x] Bump the hardcoded `v: 2` in the web `RunMessage` mirror + test fixtures to `3` (source emit-sites already use `CONTRACT_VERSION`).

- [x] **Task 2: Guard — permission-check-first enforcement + a generic connection adapter** (AC: #1, #2, #3)
  - [x] `apps/egress-guard/src/guard.ts` — per-run state gains **`grants: { scope, send }[]`** (the agent's attached-skill grants, provisioned at register). `register(runId, provision)` reads `provision.grants` (default `[]`).
  - [x] In `forwardConnection`, enforce in this order (E4-AD-8 fail-closed, permission-first — an out-of-scope/ungranted op is refused *before* any credential is consulted, so it's authorized independent of connection state):
    1. **Permission check (NEW):** `authorizes(state.grants, req.op)` → if false, **refuse with `kind: "permission"`** and a cause→consequence→recovery `detail` composed per-op (send: "Blocked send — this agent isn't permitted to send; turn on Allow send for an outbound skill in the Skills section."; label: "Blocked — this agent isn't permitted to modify (needs a read-write skill scope). Widen a skill's scope in the Skills section."; read: analogous).
    2. **Egress check (4.3):** destination on the allowlist AND a credential is held → else **refuse with `kind: "egress"`** (the 4.3 copy).
    3. **Filter Hook** (no-op default, E4-AD-6) → then the adapter forward.
  - [x] **Generic connection adapter (SM-4):** extract the Gmail HTTP into a `ConnectionAdapter` — `forward(op: ConnectionOp, params, accessToken) → { ok; data?; error? }` — selected by the connection's `provider`. A `gmailAdapter` maps `read`→`GET …/messages?maxResults=N`, `label`→`POST …/messages/{id}/modify`, `send`→`POST …/messages/send` (Gmail base URL from the connection's destination). **This adapter is the ONLY place Gmail specifics live**; `forwardConnection`, the enforcement, and the op vocabulary stay provider-agnostic. Reads land now; the write forwards (label/send) mirror the read pattern (attach the held token, `fetch` with a timeout) but are exercised live only with configured OAuth (see Testing).
  - [x] Fail-closed preserved (NFR-2): any error / unknown connection / missing credential / unauthorized op / malformed request ⇒ refused, never permitted. `teardown` still zeroes credentials + drops grants.
  - [x] `apps/egress-guard/src/app.ts` — the register route already forwards the JSON provision body; ensure `grants` passes through to `guard.register`.

- [x] **Task 3: control-api — provision the skill grants + drive the harness's skills** (AC: #1, #2, #3)
  - [x] `apps/control-api/src/runs/orchestrator.ts` — extend `resolveRunConnections` (from 4.3): the agent's attached skills with `scope !== "none"` now drive two outputs — **`jobSpec.skills`** = those skills' ids (what the harness will run; the jobSpec field already exists, currently `[]`), and **`provision.grants`** = those skills' `{ scope, send }` (what the Guard enforces — control-plane, never in the jobSpec). Keep the 4.3 credential/allowlist provisioning. `AgentLike.skills` becomes `AttachedSkill[]` (`{ skill, scope, send }`, from `@turanga/domain`).
  - [x] `apps/control-api/src/runs/guardClient.ts` — `RunProvision` gains `grants: { scope: SkillScope; send: boolean }[]`; `fakeRunGuard` records it (already captures the whole provision). No token/grant ever in the jobSpec (assert, AD-10).

- [x] **Task 4: Harness — deterministic skill execution through the connection interface** (AC: #1, #2, #3)
  - [x] `apps/agent-harness/src/main.ts` — replace the single 4.3 read with a **deterministic skill run** over `spec.skills`, provider-agnostic (uses `SKILL_OPS` + the gmail connection handle from `spec.connections`):
    - **Phase 1 — read ops** (`OP_REQUIREMENTS[op].requiredScope === "read"`): attempt each read; fold an `ok` summary into the model context, or `emit` a relayed refusal (`{ type: "refusal", kind: <Guard's kind>, detail }`).
    - **Phase 2 — the model call** → the agent turn (the response / **the draft artifact** for draft-reply).
    - **Phase 3 — outbound/write ops** (`label`, `send`): attempt each; a refusal (permission or egress) is relayed. A blocked send does **not** kill the run — the draft (Phase 2) stands and the run completes (AC3, AD-8).
  - [x] Generalize `readOutcome` → `opOutcome(op, res)`: `ok` → a system-context summary; `refusal` → a `refusal` control message carrying **the Guard's `kind`** (egress vs permission); plain error → nothing. The harness still names only logical ops — no URL, key, or token (AD-10). Keep the bare-loop contract (`JOB_SPEC`, `--network=none`, single stdout channel).

- [x] **Task 5: Test pane — permission refusals render (web)** (AC: #2, #3)
  - [x] Confirm the refusal row (built in 4.2, rewired in 4.3 to render `{msg.detail}` with the caution dot) renders a **permission** refusal identically (detail inline, dot + text, no red banner) — a permission refusal reads the same as an egress one (both are guardrail stops; the `kind` is data for the record, not a distinct visual in MVP). Likely **no** web code change beyond the e2e. **No** draft-review surface / approve-send control (deferred, AD-8 — the draft is the model's agent turn).

- [x] **Task 6: Tests + verification** (AC: all)
  - [x] **Contract unit:** `authorizes` truth table (read/label/send × none/read/read-write × send on/off); `SKILL_OPS`/`OP_REQUIREMENTS` shape; the op enum + refusal `kind` parse.
  - [x] **Guard unit (injected fetch):** (a) an authorized `read` with a held credential forwards through the gmail adapter (token attached, not returned); (b) an **out-of-scope** op (e.g. `label` with only a `read` grant) → **permission refusal**, *before* any credential is consulted (assert the fetch is never called); (c) `send` with a `read-write`+`send:false` grant → **permission refusal** (AC3); (d) `send` with `read-write`+`send:true` but no credential → **egress refusal** (permission passed, egress failed); (e) fail-closed on adapter error; (f) the gmail adapter is the only email-specific unit.
  - [x] **control-api unit:** the orchestrator provisions `grants` + populates `jobSpec.skills` from the agent's scoped skills; a `none`-scoped skill is excluded; **no grant/token in the jobSpec** (assert).
  - [x] **Harness unit:** `opOutcome` maps ok/permission-refusal/egress-refusal/error; the phase split (read before model before outbound) is covered by a small pure-function or sequence test.
  - [x] **Playwright e2e (live stack, serial — append to `tests/agents.spec.ts`):** (AC2) an agent with **flag-label at scope `read`** (below read-write) → run → a **permission** refusal row renders (the label op is out of scope) — observable with **no OAuth** (permission-first). (AC3) an agent with **draft-reply, scope `read-write`, send OFF** → run → a **blocked-send** refusal row renders and the run still resolves terminally (the draft artifact = the agent turn; with no provider key it's the model-error turn — the send refusal is the enforced deliverable). [mirrors 4.1–4.3's no-credential dev pattern]
  - [x] **Gated integration** (`RUN_SANDBOX_IT`): the live run still streams + reaps; no credential in the transcript.
  - [x] `svelte-check` 0 · `pnpm -r build` 6/6 · `pnpm lint` · all unit suites · e2e incl. Epic 1–3 + 4.1/4.2/4.3 regressions green · `docker compose down -v` teardown · **no leaked run containers**.

## Dev Notes

**Fourth Epic 4 story — make permissions real: the Guard enforces each skill's permission scope + send-gate at runtime, and an out-of-scope invocation or an ungranted send is refused + recorded. Scope confirmed with the user (2026-08-02):**
- **Deterministic skill execution** — the harness runs each attached skill's ops once (read-search/summarize→read, flag-label→label, draft-reply→send), demonstrating the interface + exercising enforcement. **Model-driven tool-calling / an agent loop is deferred** (a much larger capability; AD-8 frames 4.4 as "refuse out-of-scope; draft-reply without send → artifact + complete").
- **Provider-agnostic op layer (SM-4)** — skills map to generic ops (`read`/`label`/`send`); the enforcement + skill code carry **no email specifics**; the Gmail HTTP lives only in the Guard's `gmailAdapter`. This satisfies SM-4's code-inspection metric (the second connector is the roadmap validation).
- **Permission-check-first** — the Guard authorizes the op against the agent's granted skill scopes/send **before** the credential/allowlist check, so a permission refusal is reachable + e2e-testable **without configured OAuth** (mirrors 4.1–4.3's dev pattern) and it's the correct authz order.
- **Refusal transport (inherited from 4.3):** the **Guard decides** the refusal (permission or egress); the **harness relays** it as a `refusal` control message in 4.4. The out-of-band Guard→orchestrator channel (E4-AD-10 target — so a compromised harness can't suppress records) remains **4.5**.

**Do NOT build:** model-driven tool-calling / the agent loop, a real Gmail draft-create or the approve/send control-plane action (AD-8 — the drafted reply is the model's agent turn; a send/review surface is roadmap), a distinct visual for permission-vs-egress refusals, the standalone allowlist/skills-editor runtime UI, the per-run cost key + kill-on-429 + real metering (4.5), the real Filter Hook logic (4.6), a second connector.

### Architecture (the spines govern — inherited, binding)
[Source: architecture/epic-4-execution-plane/ARCHITECTURE-SPINE.md; architecture/architecture-turanga-2026-07-31/ARCHITECTURE-SPINE.md]
- **Story-map line (Epic-4 spine :141):** "**4.4** Skill/permission runtime enforcement | **AD-5 (Connection interface) + inherited scopes/send** — refuse out-of-scope; draft-reply without send → artifact + complete." There is **no separate skill-enforcement AD** — 4.4 rides AD-5/AD-2's default-deny + credentialed-gateway machinery, with the **Guard as the enforcement point**.
- **AD-5:** for an attached Connection the harness issues a *logical* request; the Guard authorizes/credentials/forwards. A skill's op is a logical connection request the Guard classifies (AD-2) and permits only within scope.
- **AD-8 (send-gate):** send-gated actions **produce an artifact and the Run completes**; approve/send is a **separate control-plane action** (deferred); mid-run `review` is deferred.
- **AD-10:** no secret in the sandbox — the token stays Guard-side; the jobSpec carries only logical skill ids + connection handles.
- **E4-AD-9:** the harness↔Guard protocol is a **versioned contract** — 4.4 generalizes the op vocabulary + adds the refusal `kind` (bump `CONTRACT_VERSION`). The harness sees only logical ops.
- **E4-AD-10:** refusal truth is the **Guard**, merged onto the Run (harness-relayed in 4.4; out-of-band in 4.5). **NFR-4:** every refusal is a structured record on the Run.
- **E4-AD-8 fail-closed:** any Guard error/misconfig ⇒ refused, never permitted (NFR-2).

### PRD / FR (verbatim intent)
- **FR-3:** attach skills + scoped permissions; **default-deny**; an agent invoking a skill **outside its Permission Scope is refused and recorded** at run time.
- **FR-17:** the built-in set (read/search, draft reply, flag/label, summarize) are **generic capabilities through the Skill interface — not email-specific**; read/search, flag/label, summarize **operate through the generic Connection interface (SM-4)**.
- **FR-18:** outbound actions are **permission-gated, never automatic** — with send ungranted, draft-reply **produces a draft but cannot send; a send attempt is refused and recorded**; a drafted reply is **never dispatched as a side effect**.
- **SM-4 (genericity):** the Connection-interface / skill code paths contain **no use-case-specific logic** (code inspection).

### UX specifics (DESIGN.md / EXPERIENCE.md — Warm Ink)
- **Refusal row** — egress and permission refusals surface **the same inline row** (dot + reason, no red banner). The specs word only the *egress* example ("Blocked egress to … — not on this agent's allowlist."), so 4.4 **authors permission-refusal copy** in the same cause→consequence→recovery voice (name the blocked action + the recovery = grant the scope / turn on send in the Skills section). [DESIGN.md:54/127, EXPERIENCE.md:51/60]
- **Refusal ≠ killed ≠ failed:** a refusal is an inline row while the **turn still resolves** (killed is cap-breach → 4.5; failed is an error). Never colour-only; caution dot (consistent with 4.3's refusal row). [EXPERIENCE.md:73/75/89, DESIGN.md:98]
- **Send-gate authoring (Epic 3, done):** the skill chip carries a **distinct, off-by-default send grant** (UX-DR22); a drafted reply is "a produced artifact reviewed/sent as a **separate action**" — the *separate action* is deferred (AD-8). [epics.md:93, EXPERIENCE.md:62]
- No `permission`-specific copy or a draft-review surface exists in the specs — author the copy; the draft artifact is the transcript agent turn.

### Files being modified (READ current state — preserve behavior)
- **`packages/contracts/src/index.ts` (UPDATE):** v3; generic op enum; refusal `kind`; the `SkillScope`/`ConnectionOp`/`OP_REQUIREMENTS`/`SKILL_OPS`/`authorizes` policy.
- **`apps/egress-guard/src/guard.ts` (UPDATE):** per-run `grants`; permission-check-first in `forwardConnection`; extract the `ConnectionAdapter`/`gmailAdapter` (SM-4). Preserve 4.3 allowlist/credential/teardown + the 4.1 socket lifecycle + fail-closed.
- **`apps/egress-guard/src/guard.test.ts` (UPDATE):** the 4.3 op `"gmail.list"` → `"read"`; add the permission-first + adapter cases.
- **`apps/control-api/src/runs/orchestrator.ts` (UPDATE):** grants + jobSpec.skills from `AttachedSkill[]`. Preserve the 4.1/4.2/4.3 fail-closed order, concurrency slot, reap+teardown, credential minting, token-not-in-jobSpec.
- **`apps/control-api/src/runs/guardClient.ts` (UPDATE):** `RunProvision.grants`.
- **`apps/control-api/src/runs/runs.test.ts` (UPDATE):** the connection tests now also assert `grants` + `jobSpec.skills`; the `v: 2` fixtures → `3`.
- **`apps/agent-harness/src/main.ts` + `main.test.ts` (UPDATE):** the phased skill run + `opOutcome`. Op `"gmail.list"` → `"read"`.
- **`apps/web/src/lib/runs.ts` (UPDATE):** the `RunMessage` mirror `v: 3`.
- **`apps/web/tests/agents.spec.ts`, `apps/control-api/src/runs/sandbox.integration.test.ts` (UPDATE):** the permission-refusal e2e + the no-leak assertion.

### Previous-story intelligence (4.3 / 4.2 / 4.1 + Epic 3)
- **4.3 shipped (v2):** the credentialed-connection gateway (mode a) + default-deny allowlist + refusal records; the harness relays refusals; the Guard holds per-run `{ allowlist, credentials }` and forwards `gmail.list` reads (the op 4.4 renames to `read` + generalizes). `resolveRunConnections` in the orchestrator already derives the gmail handle + mints the credential gated on `scope !== "none"` — extend it to also emit `grants` + `jobSpec.skills`. The refusal row renders `{msg.detail}` with the `--state-killed` (caution) dot.
- **Contract discipline:** every `v:` emit-site in source uses `CONTRACT_VERSION`; only the web mirror + test fixtures carry a literal (bump those to `3`). `JobSpec.connections` has `.default([])`.
- **Domain (Epic 3):** `AttachedSkill { skill: BuiltinSkill; scope: "none"|"read"|"read-write"; send: boolean }`; `BuiltinSkill = "read-search"|"draft-reply"|"flag-label"|"summarize"`. The agents repo returns `skills: AttachedSkill[]`.
- **Guard fail-closed + isolation (4.1):** per-run UDS, ULID validation, `MAX_REQ_BODY`, timeouts, one socket error can't crash the shared process, `--network=none`, Docker socket only in control-api — all unchanged.
- **Dev observability pattern:** no OAuth in dev/e2e → reads get egress refusals (no credential); **permission-first** makes out-of-scope/ungranted-send refusals observable without OAuth. Happy-path reads/writes need configured OAuth (gated/manual).
- **Known deferrals (do not reopen):** the 4.1–4.3 review deferrals (guard socket reaper, tenancy, secrets-in-prod, transcript caps, error-copy polish, mode-b egress, allowlist-editor UI, out-of-band refusal channel); this story's deferrals (tool-calling loop, real writes live, draft-review/approve-send, second connector).

### Security invariants (must hold — do not regress)
- **Enforcement is Guard-side (not the harness):** the permission decision uses the Guard's provisioned `grants`; a compromised harness naming any op cannot widen scope or force a send — the Guard refuses. The jobSpec carries only skill ids + connection handles (no scope/send/token there is authoritative).
- **Default-deny + fail-closed (FR-3/NFR-2):** an unauthorized op is refused; any Guard error ⇒ refused. Send is off unless a skill grants it.
- **No secret in the sandbox (AD-10):** unchanged from 4.3 — the token is Guard-side; assert it's absent from the jobSpec + any UDS response.
- **Isolation unchanged:** `--network=none`, per-run UDS, Docker socket only in control-api, `SANDBOX_RUNTIME` explicit/fail-closed.

### Testing standards
- **Unit (Vitest):** the `authorizes` truth table; the Guard permission-first + adapter (injected fetch, no Google); orchestrator grants + jobSpec.skills + token-not-in-jobSpec; harness `opOutcome` + phase order. In-memory; no Docker.
- **Integration (gated `RUN_SANDBOX_IT`):** live run streams + reaps; no credential in the transcript.
- **E2E (Playwright, live, serial):** AC2 (out-of-scope label → permission refusal) + AC3 (draft-reply send-off → blocked-send refusal, run completes) — both observable without OAuth via permission-first.
- `svelte-check` 0, build 6/6, lint clean, Epic 1–3 + 4.1/4.2/4.3 regressions green.
- **DoD:** an out-of-scope skill op is refused + recorded (permission refusal row); an ungranted send is refused and the run still produces its draft artifact + completes; reads/flag/summarize run through the generic connection interface with no email logic outside the gmail adapter (SM-4); enforcement is Guard-side + fail-closed; only 4.4 scope (tool-calling, real writes live, approve/send, cost/kill, filter hook are marked seams).

### Project Structure Notes
- Modified: `packages/contracts`, `apps/egress-guard/{guard,guard.test}.ts`, `apps/control-api/src/runs/{orchestrator,guardClient,runs.test}.ts`, `apps/agent-harness/src/{main,main.test}.ts`, `apps/web/src/lib/runs.ts`, the web e2e + integration test. New (optional): a `apps/egress-guard/src/adapters/gmail.ts` if the adapter warrants its own file (keeps SM-4 obvious). **No DB migration**; contract version bump to 3. [E4 spine Structural Seed; AD-5/AD-8/AD-9/AD-10]

### References
- [Source: epics.md#Epic-4 / Story-4.4 (AC1-3); FR-3, FR-17, FR-18, SM-4, NFR-4; UX-DR22]
- [Source: architecture/epic-4-execution-plane/ARCHITECTURE-SPINE.md — story-map :141, E4-AD-8/9/10; inherited AD-2/5/8/9/10]
- [Source: prds/prd-turanga-2026-07-31/prd.md — FR-3 :83, FR-17 :89, FR-18 :95, SM-4 :259, NFR-4 :289; glossary; open question :270 (least-privilege scopes)]
- [Source: ux-designs/ux-turanga-2026-07-30/DESIGN.md#components.test-pane/#skill-chip (:54/:62/:98/:121/:127); EXPERIENCE.md (:51/:60/:62/:73/:75/:89), Key-Flow-1/2]
- [Source: packages/contracts/src/index.ts; packages/domain/src/index.ts (AttachedSkill); apps/egress-guard/src/guard.ts; apps/control-api/src/runs/orchestrator.ts; apps/agent-harness/src/main.ts]
- [Source: _bmad-output/implementation-artifacts/4-3-allowlist-credentialed-egress.md, 4-2-test-pane-streaming.md, 4-1-sandbox-bare-loop.md, deferred-work.md; project-context.md]

## Dev Agent Record

### Agent Model Used
claude-opus-4-8[1m]

### Debug Log References
- `CONTRACT_VERSION`→3: generic op enum (`read|label|send`) + refusal `kind` + the `OP_REQUIREMENTS`/`SKILL_OPS`/`authorizes` policy in contracts. Source emit-sites already use `CONTRACT_VERSION`; only the web mirror + test fixtures needed the literal bump.
- The 4.3 refusal named the destination via a hardcoded `destinationForOp`; with generic ops an uncredentialed run couldn't resolve the host ("the requested destination"). Fixed by **always provisioning the connection metadata** (provider + declared destinations) with an EMPTY token when uncredentialed — the Guard resolves the host for the refusal (NFR-4) and still refuses on egress (empty token / empty allowlist). Split the egress refusal into "not on allowlist" vs "no credential available".
- e2e strict-mode: `getByText("agent")` also matched the refusal text "…this **agent** isn't permitted…" → asserted `.turn-role` instead.

### Completion Notes List
- Permissions are now **real**: the Guard enforces each skill's scope + send-gate per op, **permission-first** (authorized against the agent's provisioned `grants` before any credential is consulted) so out-of-scope/ungranted-send refusals are observable + e2e-tested **without OAuth**. An out-of-scope op → `permission` refusal; a send without the grant → `permission` refusal while the draft (the model's agent turn) still stands and the run completes (AC3, AD-8).
- **Provider-agnostic (SM-4):** skills map to generic `read|label|send` ops via the shared `SKILL_OPS`/`OP_REQUIREMENTS`/`authorizes` policy; the enforcement, orchestrator, and harness carry no email specifics — all Gmail HTTP is isolated in the Guard's `gmailAdapter` (a `ConnectionAdapter` selected by provider).
- **Deterministic skill execution:** the harness runs the attached skills' ops in phases (read → model/draft → outbound) driven by `SKILL_OPS`; a refusal is relayed with the Guard's `kind`. Model-driven tool-calling stays deferred.
- **Security spine held:** enforcement is Guard-side (a compromised harness naming any op can't widen scope or force a send — the Guard refuses on its provisioned grants); the jobSpec carries only skill IDs + connection handles (no authoritative scope/send/token — asserted absent); default-deny + fail-closed on any error; isolation from 4.1 unchanged.
- **Deferred (in scope-confirmation):** the approve/send control-plane action + a draft-review surface (AD-8), real Gmail write ops live (gated/manual — reads land, writes mirror the pattern but need OAuth), the out-of-band Guard→orchestrator refusal channel (4.5), a second connector.

### File List
**Modified**
- packages/contracts/src/index.ts
- packages/contracts/src/index.test.ts
- apps/egress-guard/src/guard.ts
- apps/egress-guard/src/app.ts
- apps/egress-guard/src/guard.test.ts
- apps/control-api/src/runs/orchestrator.ts
- apps/control-api/src/runs/guardClient.ts
- apps/control-api/src/runs/runs.test.ts
- apps/control-api/src/runs/hub.test.ts (v-fixture bump 2→3)
- apps/agent-harness/src/main.ts
- apps/agent-harness/src/main.test.ts
- apps/web/src/lib/runs.ts
- apps/web/tests/agents.spec.ts

### Change Log
| Date | Change |
| --- | --- |
| 2026-08-02 | Story 4.4 implemented: contract v3 (generic `read|label|send` ops, refusal `kind`, the skill→op `authorizes` policy), Guard permission-first enforcement + a provider-agnostic `gmailAdapter` (SM-4), orchestrator skill grants + `jobSpec.skills`, harness phased deterministic skill run relaying the Guard's kind, permission refusals in the test pane. Also hardened the refusal destination (always-provision connection metadata). Verified: build 6/6, svelte-check 0/0, lint clean, unit (contracts 8, guard 14, harness 4, control-api 82), 19/19 e2e on a fresh live stack incl. AC2/AC3 permission refusals, gated integration, no leaked containers. Status → review. |
