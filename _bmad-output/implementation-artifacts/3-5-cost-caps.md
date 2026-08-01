---
baseline_commit: c57b907d428ecc795414b967bc3d6ed8dd97a1cc
---
# Story 3.5: Set per-run and per-day cost caps

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As the builder,
I want to set spend ceilings on an agent,
so that it can never run away with my money.

## Acceptance Criteria

1. **Given** the Cost caps section, **when** the builder sets caps, **then** both a **per-run** and a **per-day** cap are captured as **money (integer minor units + currency)** and persisted (config owned by `control-api`, AD-7). The amounts render in **mono / tabular-nums**. [Source: epics.md#Story-3.5 FR-11; DESIGN.md#components.cost-caps-control, #Typography (mono cap amounts); ARCHITECTURE-SPINE.md AD-6, AD-7]
2. **Given** a **missing or invalid cap**, **when** entered, **then** validation **blocks it with a stated reason** (inline at the field — cause→consequence→recovery, associated + announced; never a full red banner; the invalid value is not persisted). [Source: epics.md#Story-3.5; EXPERIENCE.md#State-Patterns (Error), #Accessibility (errors associated with the field)]

## Tasks / Subtasks

- [x] **Task 1: Model + persist cost caps** (AC: #1)
  - [x] `packages/domain/src/index.ts` — widen `CostCap` so each side is independently settable in Draft: `interface CostCap { perRun: Money | null; perDay: Money | null }`. Change `Agent.costCap?: CostCap` → `costCap: CostCap` (always present; both sides default `null` until set). `Money { minor, currency }` already exists (integer minor units, ISO-4217 currency). ("Both required" is enforced only at the **Activate** gate — Story 5.1 — not here.) [Source: domain Money/CostCap; ARCHITECTURE-SPINE.md AD-6]
  - [x] `apps/control-api/src/db/schema.ts` — add `costCap jsonb ... $type<CostCap>().notNull().default({ perRun: null, perDay: null })` to `agents` (column `cost_cap`). `drizzle-kit generate` → migration **`0007`**. Preserve columns + migrations `0000`–`0006`.
  - [x] `apps/control-api/src/agents/repo.ts` — extend `AgentRow` (`costCap: CostCap`) and `AgentPatch` (`costCap?: CostCap`); thread through `toRow`, `applyPatch`, Drizzle `create` (default `{ perRun: null, perDay: null }`) + `update`, and the memory repo. Re-export `CostCap`/`Money`.

- [x] **Task 2: Cost-caps validation route (control-api)** (AC: #1, #2)
  - [x] In `apps/control-api/src/agents/routes.ts`, add a `parseCostCap` helper and a `costCap` branch in `PATCH /agents/:id`:
    - `costCap` must be an object with `perRun` and `perDay`, each either `null` **or** a `Money` `{ minor, currency }` where **minor** is an integer `0 ≤ minor ≤ MAX_CAP_MINOR` (100_000_00 = $100,000) and **currency** is a 3-letter uppercase code (MVP: `"USD"`). Reject a non-object, a bad shape, a non-integer/negative/over-cap minor, or a bad currency with **400** + a stated reason. (A `null` side is valid — an unset cap.)
  - [x] `POST /agents` create sets `costCap: { perRun: null, perDay: null }`. `GET /agents/:id` returns it. **Preserve** name/model/instructions/variables/skills behavior + the whole Epic 1/2/3.1–3.4 surface. No `app.ts`/`server.ts` change.

- [x] **Task 3: Web client + money helper** (AC: all)
  - [x] `apps/web/src/lib/agents.ts` — add `Money` + `CostCap` (each side `Money | null`) and `costCap: CostCap`/`costCap?: CostCap` to `Agent`/`AgentPatch`.
  - [x] `apps/web/src/lib/money.ts` — dollars↔minor helpers (unit-tested), `CURRENCY = "USD"`: `parseDollarsToMinor(input): { ok: true; minor: number } | { ok: false; error: string }` (empty → treat as clear upstream; reject negative, non-numeric, or > 2 decimal places with a stated reason; `"5"`→500, `"5.00"`→500, `"0.05"`→5); `formatMinor(minor): string` (minor→`"5.00"`, 2 dp, thousands separators).

- [x] **Task 4: Cost caps section on the definition surface** (AC: all)
  - [x] New **`apps/web/src/lib/components/CostCapsEditor.svelte`** — `value: CostCap`, `onchange: (caps: CostCap) => void`:
    - Two **money inputs**, **Per-run cap** and **Per-day cap**, with **persistent labels** (not placeholder-only), a leading `$`, rendered in **mono / tabular-nums** (`--font-mono`, `font-variant-numeric: tabular-nums`, ≥12px). Each input shows the current amount via `formatMinor` when set, blank when null.
    - On edit: an empty field **clears** that cap (`null`); a valid amount → `parseDollarsToMinor` → emit `onchange` with the updated `CostCap` (`{ minor, currency: "USD" }` on that side); an **invalid** amount → an **inline error** at that field (cause→consequence→recovery, e.g. "Enter a dollar amount like 5.00.") and it is **not** emitted/persisted. Rectangular inputs (4px, no pills).
    - Do **NOT** build the live **cost-meter** (that's Epic 4 live metering — no static placeholder is specced) or any Activate gate.
  - [x] In `apps/web/src/routes/(app)/agents/[id]/+page.svelte`, add a **`<Section label="Cost caps">`** **between Variables and Allowlist** (canonical order … Variables → **Cost caps** → Allowlist; Allowlist is a later story), seed a local `costCap` copy in `load()`, and wire `CostCapsEditor` → debounced (~400ms) `persist({ costCap })` (mirror the seq-guarded `persist`; caps are typed text → debounce like instructions). Keep the config pane single-column < 1024px.

- [x] **Task 5: Tests + verification** (AC: all)
  - [x] **Unit (control-api, Vitest, in-memory repo + real session):** create → `costCap: { perRun: null, perDay: null }`; `GET /agents/:id` returns it; PATCH `costCap` persists a valid pair (durable); a **null** side is accepted; **rejects** a non-object, a non-integer/negative/over-cap `minor`, a bad `currency`, and a malformed side with **400**; **401** without a session. Assert control-api is the only writer (AD-7).
  - [x] **Unit (web, Vitest):** `money.ts` — `parseDollarsToMinor` (`"5"`→500, `"5.00"`→500, `"0.05"`→5; reject `"-1"`, `"abc"`, `"1.234"`) and `formatMinor` (500→`"5.00"`, 123456→`"1,234.56"`).
  - [x] **Playwright e2e (live stack, serial — append to `tests/agents.spec.ts`):** open an agent → Cost caps section; enter **Per-run cap** `0.50` and **Per-day cap** `5.00` → the indicator shows `Saving… → Saved`, the amounts render in mono, and both **persist across reload**; entering an invalid amount (e.g. `-1` or `abc`) shows an **inline error** and does not persist.
  - [x] `svelte-check` 0 · `pnpm -r build` · `pnpm lint` · control-api + web unit · e2e incl. **Epic 1/2/3.1–3.4 regressions** all green.

## Dev Notes

**Fifth Epic 3 story — the spend ceilings. Build: cost-caps persistence (`CostCap` with each side `Money | null`), the money helper, the `CostCapsEditor` (two mono money inputs + inline validation), and the Cost caps section. Do NOT build: the live **cost-meter** (Epic 4 live metering), the **Activate** gate / "both required" enforcement (Story 5.1), the Allowlist section, or any run-time cap *enforcement* (LiteLLM 429s, AD-6 — Epic 4). This story captures the cap config only. No new external tech — Drizzle migration + guarded Hono PATCH + SvelteKit, all established in 3.1–3.4.**

### Architecture / constraints
- **AD-6 (context, not enforced here):** LiteLLM is the cost-enforcement point — every model call carries a per-agent virtual key holding the **daily budget**; the **per-run** cap is a short-lived per-run key minted under it; **spend cannot be exceeded because LiteLLM 429s the call**. Cap **configuration** is owned by `control-api` (pushed into LiteLLM keys); **spend** is owned by `litellm`. 3.5 captures the config; pushing caps into LiteLLM keys + the meter are **Epic 4**. [ARCHITECTURE-SPINE.md AD-6]
- **AD-7 single-writer:** `control-api` is the sole writer — the editor autosaves via `PATCH /agents/:id`. Mirror the seq-guarded `persist()`. [ARCHITECTURE-SPINE.md AD-7]
- **AD-8:** the agent stays **Draft**; **Activate** is gated on *model + per-run + per-day caps* — 3.5 supplies two of the three preconditions but does **not** build the gate (Story 5.1). [ARCHITECTURE-SPINE.md AD-8; EXPERIENCE.md Flow-1: "Activate was disabled until model + both caps were set"]
- **Money convention:** UTC timestamps; **money as integer minor units + ISO-4217 currency (never floats)** — `Money { minor, currency }` already in domain. MVP is single-currency **USD**; the UI shows a leading `$`. [ARCHITECTURE-SPINE.md#Conventions; domain Money]
- **Conventions:** semantic Warm Ink tokens only; **cap amounts always render in IBM Plex Mono with tabular-nums** (mono ≥ 12px); verb-first sentence-case copy; persistent labels; visible focus ring; no motion. [DESIGN.md#Typography; EXPERIENCE.md#Accessibility]

### UX specifics (DESIGN.md / EXPERIENCE.md — Warm Ink baseline wins on conflict)
- **`cost-caps-control`:** "two money inputs (**per-run cap, per-day cap**) in **mono/tabular**. Both required before Activate. Paired with a live cost meter…" — build the two inputs; the meter is Epic 4. [DESIGN.md#components.cost-caps-control, prose L128]
- **Number rendering:** cap amounts in **IBM Plex Mono + `tabular-nums`**; mono metric text stays **≥ 12px**. Currency shown as a **leading `$`** (`$5.00`, `$0.0413` in examples). "Specific unrounded numbers." [DESIGN.md#Typography L34/L105; EXPERIENCE.md#Accessibility, #Voice]
- **Errors:** inline at the field, **cause→consequence→recovery**, associated + announced, **no full red banner**. Form fields have **persistent labels** (not placeholder-only). [EXPERIENCE.md#State-Patterns (Error), #Accessibility]
- **Autosave / sections:** `Saving… → Saved` `--text-tertiary` micro-cap; collapsible sections, 11px tracked micro-cap labels; no Save button. **Cost caps** is the **5th** section (Model → Instructions → Skills → Variables → **Cost caps** → Allowlist). [EXPERIENCE.md#Component-Patterns; DESIGN.md#components.agent-editor-pane]
- **Shape:** rectangular 4px inputs — no pills. Base Input inherits Warm Ink (do not re-style). [DESIGN.md#Shapes L121, L133]
- **Spec gaps (do not over-invent):** "integer minor units" and "single currency" are **not** in the UX spine (they're architecture/domain) — cited from AD-6/domain, not the UX files. No static cost-meter placeholder is specced — omit it.

### Files being modified (READ current state — preserve behavior)
- **`packages/domain/src/index.ts` (UPDATE):** widen `CostCap` sides to `Money | null`; `Agent.costCap` becomes non-optional (default both null). Update the `index.test.ts` fixture (it sets both — still valid).
- **`apps/control-api/src/db/schema.ts` (UPDATE):** add `cost_cap` jsonb. Preserve columns + migrations `0000`–`0006` (new `0007`).
- **`apps/control-api/src/agents/repo.ts` (UPDATE):** `AgentRow`/`AgentPatch` gain `costCap`; thread `toRow`/`applyPatch`/`create`/`update`.
- **`apps/control-api/src/agents/routes.ts` (UPDATE):** `parseCostCap` + costCap branch in PATCH; create default. Keep all prior validation (name/model/instructions/variables/skills + the review hardenings).
- **`apps/web/src/lib/agents.ts` (UPDATE):** `Money`/`CostCap` + `costCap` on `Agent`/`AgentPatch`.
- **`apps/web/src/routes/(app)/agents/[id]/+page.svelte` (UPDATE):** add the Cost caps `<Section>` + local `costCap` state + autosave; keep Model/Instructions/Skills/Variables, header autosave (seq-guarded), `load()` id-guard, responsive split, notFound/error/Retry.
- **`apps/web/tests/agents.spec.ts` (UPDATE):** append the 3.5 e2e (one file → guaranteed serial ordering; the 3.1 empty-state stays first).
- **NEW:** `apps/web/src/lib/money.ts` (+ test), `apps/web/src/lib/components/CostCapsEditor.svelte`, `apps/control-api/drizzle/0007_*.sql`.

### Previous-story intelligence (Epics 1–3.4)
- **Autosave (review-hardened):** `persist()` uses a monotonic `saveSeq` — out-of-order responses can't overwrite newer state; discrete changes persist immediately, **text/number inputs debounce ~400ms** (mirror `onInstructionsInput`). `load()` captures `target = id` and bails on change. Client-side caps prevent silent divergence (apply an input length/step guard for money too). [3-2, 3-3 review]
- **jsonb field pattern:** mirror `parseVariables`/`parseSkills` for `parseCostCap` (validate shape, reject with a stated reason). Repo threading: `toRow` map, `applyPatch` spread-if-defined, `create` `.values`, `update` `set.x`. Last migration `0006` → `0007`. [3-3, 3-4]
- **Web patterns:** discriminated `Result<T>`; `Section` API `<Section label="…">children</Section>`; web vitest wired (`vitest.config.ts`, node env) — put `money.ts` logic there and unit-test it; Warm Ink tokens. [3-3, 3-4]
- **E2E:** serial (`workers:1`); ALL agent e2e in `tests/agents.spec.ts` so the fresh-DB empty-state runs first; caps need **no** provider, so the 3.5 flow is fully e2e-able. [3-2..3-4]
- **Known deferrals (do not reopen):** same-ms ordering, `state` CHECK, vacuous single-writer test, native-select model deviation, autosave-indicator polish, Retry button, domain/repo nullability, `x-forwarded-for` limiter, skills-scope/send enforcement (Epic 4) (`deferred-work.md`).

### Testing standards
- **Unit (control-api):** create default `{perRun:null,perDay:null}`; GET returns costCap; PATCH valid persist + null side accepted + 400 on non-object/bad-minor/bad-currency/malformed; guard 401. In-memory repo.
- **Unit (web):** `money.ts` parse/format edge cases.
- **E2E (Playwright, live stack, serial):** set both caps → mono render + persist across reload; invalid entry → inline error, not persisted.
- `svelte-check` 0, build 6/6, lint clean, Epic 1/2/3.1–3.4 regressions green.
- **DoD:** per-run + per-day caps captured as money (minor units + currency) and persisted via control-api only (AD-7); amounts in mono/tabular; invalid/missing cap blocked inline with a reason; agent stays Draft; regressions intact; only permitted sections modified. NO cost-meter/Activate/allowlist/enforcement; NO contract/version change.

### Project Structure Notes
- New (control-api): migration `0007`. New (web): `money.ts` + test, `CostCapsEditor.svelte`. Modified: control-api `schema.ts`/`repo.ts`/`routes.ts`/`agents.test.ts`, domain `index.ts`/`index.test.ts`, web `agents.ts`/`agents/[id]/+page.svelte`/`tests/agents.spec.ts`. No other apps/packages. Contracts untouched. [ARCHITECTURE-SPINE.md#Structural-Seed, AD-6, AD-7]

### References
- [Source: _bmad-output/planning-artifacts/epics.md#Epic-3 / Story-3.5; FR-11]
- [Source: ARCHITECTURE-SPINE.md AD-6, AD-7, AD-8, #Conventions (money as integer minor units + currency)]
- [Source: ux-designs/ux-turanga-2026-07-30/DESIGN.md#components.cost-caps-control/#cost-meter/#agent-editor-pane, #Typography, #Shapes]
- [Source: ux-designs/ux-turanga-2026-07-30/EXPERIENCE.md#Component-Patterns, #State-Patterns, #Accessibility, #Voice, Key-Flow-1]
- [Source: packages/domain (Money, CostCap, Agent.costCap)]
- [Source: _bmad-output/implementation-artifacts/3-4-skills-permissions.md + 3-3-instructions-variables.md (repo/route/guard/autosave/Section/helper patterns); deferred-work.md]

## Dev Agent Record

### Agent Model Used
claude-opus-4-8[1m]

### Debug Log References
- Widening domain `CostCap` sides to `Money | null` + making `Agent.costCap` non-optional broke the `index.test.ts` assertion (`a.costCap?.perDay.minor`); updated to `a.costCap.perDay?.minor`.
- `parseMoney` treats a missing side (`undefined`) as `null` (an unset cap), so a `{ perRun: null }` body (perDay omitted) is accepted, not a 400.
- svelte-check flagged `perRunText`/`perDayText` seeding from `value` — intentional (seed then sync via `$effect`); marked `// svelte-ignore state_referenced_locally`.

### Completion Notes List
- **Task 1** — domain `CostCap` widened to `{ perRun: Money | null; perDay: Money | null }`; `Agent.costCap` now non-optional (default both null). `cost_cap` jsonb column on `agents` (migration `0007`); `AgentRow`/`AgentPatch` + toRow/applyPatch/create/update threaded (Drizzle + memory).
- **Task 2** — `parseCostCap` + `parseMoney`: each side is `null`/omitted or a `Money { minor, currency }` with an integer `0 ≤ minor ≤ $100,000` and a 3-letter uppercase currency. Wired into `PATCH /agents/:id` (400 with a stated reason on any violation); `POST` defaults `{ perRun: null, perDay: null }`.
- **Task 3** — web `Money`/`CostCap` + `costCap` on `Agent`/`AgentPatch`. `$lib/money.ts`: `parseDollarsToMinor` (dollars→cents; rejects negative/non-numeric/>2dp/over-cap with a reason) + `formatMinor` (cents→`"1,234.56"`), `CURRENCY = "USD"`.
- **Task 4** — `CostCapsEditor.svelte`: two **mono/tabular** money inputs (Per-run / Per-day) with persistent labels + leading `$`; empty clears a cap (null), a valid amount emits `{minor, currency:"USD"}`, an invalid amount shows an **inline error** and is **not** persisted. Wired as `<Section label="Cost caps">` after Variables; debounced (~400ms) seq-guarded `persist({ costCap })`. No cost-meter / Activate gate (Epic 4 / Story 5.1).
- **Task 5** — control-api unit +4 (create default; persist/durable; null side accepted; 400 on non-object/non-integer/negative/over-cap/bad-currency/malformed; 401) → **55/55**. Web unit +2 files (`money.ts` parse/format). E2E +1: set both caps → mono render + persist across reload; invalid amount → inline error, not persisted → **14/14**.
- **Verification** — `pnpm -r build` 6/6, `pnpm -r test` all green (control-api 55, web 13, domain 2), `pnpm lint` clean, `svelte-check` 0, live-stack Playwright 14/14 against a fresh docker stack (migration 0007).

**Documented deferrals (unchanged from the story):** the live **cost-meter**, the **Activate** "both required" gate (Story 5.1), and run-time cap **enforcement** (LiteLLM 429s / pushing caps into virtual keys, AD-6) are **Epic 4**. Single-currency USD MVP. `packages/contracts`/`CONTRACT_VERSION` untouched.

### File List
- NEW `apps/control-api/drizzle/0007_tiresome_whizzer.sql` (+ `drizzle/meta`)
- NEW `apps/web/src/lib/money.ts`
- NEW `apps/web/src/lib/money.test.ts`
- NEW `apps/web/src/lib/components/CostCapsEditor.svelte`
- MOD `packages/domain/src/index.ts` (CostCap sides nullable, Agent.costCap required)
- MOD `packages/domain/src/index.test.ts` (fixture)
- MOD `apps/control-api/src/db/schema.ts` (cost_cap jsonb)
- MOD `apps/control-api/src/agents/repo.ts` (costCap field + threading)
- MOD `apps/control-api/src/agents/routes.ts` (parseCostCap/parseMoney + PATCH branch + create default)
- MOD `apps/control-api/src/agents/agents.test.ts` (+4 tests)
- MOD `apps/web/src/lib/agents.ts` (Money/CostCap types)
- MOD `apps/web/src/routes/(app)/agents/[id]/+page.svelte` (Cost caps section + autosave)
- MOD `apps/web/tests/agents.spec.ts` (+ cost-caps e2e)

### Change Log
- 2026-08-01 — Story 3.5 implemented: per-run + per-day cost caps captured as money (integer minor units + USD), mono/tabular inputs with inline validation, persisted + autosaved via control-api (AD-7). Status → review.
