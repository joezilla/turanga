---
baseline_commit: ef6c5c349abb8c01ba695a10829958fa6d6730f8
---
# Story 3.4: Attach skills with scoped permissions and send-gate config

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As the builder,
I want to attach skills and scope what each may do,
so that my agent has capabilities without over-permission.

## Acceptance Criteria

1. **Given** the Skills section, **when** attaching, **then** the built-in skills (read/search, draft reply, flag/label, summarize) are attachable as **rectangular chips** (never pills) via a **searchable picker popover**; each attached skill shows its name + a remove affordance. Changes **autosave**, written by `control-api` only (AD-7). [Source: epics.md#Story-3.4 FR-17; DESIGN.md#components.skill-chip, #Shapes (rectangular 4px, not pill), #Elevation (--shadow-md); EXPERIENCE.md#Component-Patterns; ARCHITECTURE-SPINE.md AD-7]
2. **Given** an attached skill, **when** its Permission Scope is set, **then** the default is **most-restrictive (deny)** and must be widened explicitly (set **inline** on the chip). [Source: epics.md#Story-3.4 FR-3; DESIGN.md#components.skill-chip ("per-skill permission scope is set inline")]
3. **Given** an outbound skill (send a drafted reply → draft reply), **when** configured, **then** its **send permission is a distinct grant, off by default** (a separate control from the scope). [Source: epics.md#Story-3.4 FR-18; ARCHITECTURE-SPINE.md AD-8 (send-gate); DESIGN.md/EXPERIENCE.md ("send permission is a distinct, off-by-default grant")]

## Tasks / Subtasks

- [x] **Task 1: Model + persist attached skills** (AC: #1, #2, #3)
  - [x] `packages/domain/src/index.ts` — add `export type SkillScope = "none" | "read" | "read-write"` and `export interface AttachedSkill { skill: BuiltinSkill; scope: SkillScope; send: boolean }`. Change `Agent.skills` from `BuiltinSkill[]` to `AttachedSkill[]`. (Concrete per-skill scope semantics + **enforcement** are Epic 4; 3.4 captures the config with a default-deny scope + off-by-default send.) [Source: domain Agent.skills; ARCHITECTURE-SPINE.md AD-7, AD-9]
  - [x] `apps/control-api/src/db/schema.ts` — add `skills jsonb ... $type<AttachedSkill[]>().notNull().default([])` to `agents` (mirror the `variables` jsonb pattern). `drizzle-kit generate` → migration **`0006`**. Preserve columns + migrations `0000`–`0005`.
  - [x] `apps/control-api/src/agents/repo.ts` — extend `AgentRow` (`skills: AttachedSkill[]`) and `AgentPatch` (`skills?: AttachedSkill[]`); thread through `toRow`, `applyPatch`, Drizzle `create` (default `skills: []`) + `update`, and the memory repo. Re-export `AttachedSkill`/`SkillScope`.

- [x] **Task 2: Skills validation route (control-api)** (AC: #1, #2, #3)
  - [x] In `apps/control-api/src/agents/routes.ts`, add a `parseSkills` helper (mirror `parseVariables`) and a `skills` branch in `PATCH /agents/:id`:
    - `skills` must be an array (else 400 "Skills must be a list."), cap at the number of built-ins (4); each item `{ skill, scope, send }` where **skill** ∈ `{read-search, draft-reply, flag-label, summarize}`, **scope** ∈ `{none, read, read-write}`, **send** is a boolean. Reject an unknown skill/scope, a non-boolean send, or a **duplicate** skill with 400. Normalize `send` to `false` for any **non-outbound** skill (only `draft-reply` is outbound), so a non-outbound skill can never carry a send grant. New/unspecified scope defaults to `"none"` (deny); send defaults to `false`.
  - [x] `POST /agents` create sets `skills: []`. `GET /agents/:id` returns them. **Preserve** name/model/instructions/variables behavior + the whole Epic 1/2/3.1–3.3 surface. No `app.ts`/`server.ts` change.

- [x] **Task 3: Web client + skill metadata** (AC: all)
  - [x] `apps/web/src/lib/agents.ts` — add `SkillScope` + `AttachedSkill` and `skills: AttachedSkill[]`/`skills?: AttachedSkill[]` to `Agent`/`AgentPatch`.
  - [x] `apps/web/src/lib/skills.ts` — built-in skill metadata + helpers (unit-tested): `BUILTIN_SKILLS` (the 4, with display labels: `read/search`, `draft reply`, `flag/label`, `summarize`), `OUTBOUND_SKILLS = new Set(["draft-reply"])`, `isOutbound(skill)`, `SCOPE_LABELS` (`none`→"No access", `read`→"Read", `read-write`→"Read & write"), and `attachableSkills(attached)` (the built-ins not yet attached).

- [x] **Task 4: Skills section on the definition surface** (AC: all)
  - [x] New **`apps/web/src/lib/components/SkillsEditor.svelte`** — `value: AttachedSkill[]`, `onchange: (skills: AttachedSkill[]) => void`:
    - **Attached chips:** one **rectangular** chip per attached skill (`--radius-md`, `1px solid var(--border-strong)`, 4px — **never a pill**) showing the display label + a **Remove** affordance. Inline on each chip: a **Permission scope `<select>`** (persistent label; options No access / Read / Read & write; value defaults to `none`) and, **only for the outbound skill (draft reply)**, a distinct **Allow send** checkbox (off by default) — a separate control from the scope.
    - **Add skill:** a verb-first **`Add skill`** button opening a **searchable picker popover** (`--shadow-md`, `Esc` closes, keyboard-reachable) listing the not-yet-attached built-ins filtered by a search input; selecting one attaches it with `scope: "none"`, `send: false`. If all four are attached, the button is disabled or the popover shows "All skills attached."
    - No colour on chips/controls (colour budget is lifecycle/connection only); no animation; status/labels are text (never colour-only). [DESIGN.md#Anti-patterns, #Color-budget; EXPERIENCE.md#Accessibility]
  - [x] In `apps/web/src/routes/(app)/agents/[id]/+page.svelte`, add a **`<Section label="Skills">`** **between Instructions and Variables** (canonical order Model → Instructions → **Skills** → Variables), seed a local `skills` copy in `load()` (like `vars`), and wire `SkillsEditor` → `persist({ skills })` (discrete changes → save immediately, mirroring `onModelChange` + the seq-guarded `persist`). Keep the config pane single-column < 1024px.

- [x] **Task 5: Tests + verification** (AC: all)
  - [x] **Unit (control-api, Vitest, in-memory repo + real session):** create → `skills: []`; `GET /agents/:id` returns them; PATCH `skills` persists a valid array (durable); **rejects** an unknown skill, an unknown scope, a non-boolean send, a duplicate skill, an over-cap array, and a non-array with **400**; **normalizes** `send` to `false` for a non-outbound skill; **allows** `send:true` on `draft-reply`; **401** without a session. Assert control-api is the only writer (AD-7).
  - [x] **Unit (web, Vitest):** `skills.ts` helpers — `isOutbound`, `attachableSkills` (excludes attached), scope/label maps.
  - [x] **Playwright e2e (live stack, serial — append to `tests/agents.spec.ts`):** open an agent → Skills section; **Add skill** opens the picker; attach **read/search** → a rectangular chip appears with a scope select defaulting to **No access** and **no** send control; attach **draft reply** → it shows an **Allow send** control that is **off** by default; widen read/search's scope to **Read**; remove a skill; the indicator shows `Saving… → Saved` and the skills + scopes **persist across reload**.
  - [x] `svelte-check` 0 · `pnpm -r build` · `pnpm lint` · control-api + web unit · e2e incl. **Epic 1/2/3.1–3.3 regressions** all green.

### Review Findings (joint 3.4 + 3.5 + 3.6 code review, 2026-08-01)

_Blind Hunter + Edge Case Hunter + Acceptance Auditor over `ef6c5c3..HEAD`. 7 patch, 5 deferred, 3 dismissed. Auditor confirmed broad AC compliance (rectangular chips, default-deny scope, off-by-default send, mono caps, advisory dependents guard, AD-7, contracts untouched)._

- [x] [Review][Patch][Med] Debounced saves fire against the wrong agent after fast navigation — the section debounce timers (name/instructions/vars/**caps**) aren't cleared on an `id` change, and `persist` uses the current route `id`; edit a cap then open a different agent within ~400ms → the pending timer PATCHes agent B with agent A's cost cap. Clear all pending timers when `id` changes (and/or capture the target id at schedule time). [apps/web/src/routes/(app)/agents/[id]/+page.svelte]
- [x] [Review][Patch][Med] Cost-cap inline error is not associated with its field nor announced (3.5 AC2 requires "associated + announced") — the input has `aria-invalid` but no `aria-describedby`, and the error has no `id`/`role="alert"`. Add `id` + `aria-describedby` + a polite alert region. [apps/web/src/lib/components/CostCapsEditor.svelte]
- [x] [Review][Patch][Med] Provider-dependents fetch failure fails open — `armRemove` only sets `dependents` on `r.ok`; on a transient error it shows the plain "Remove {name}?" with no consequence, defeating the guard. Track a fetch-failed state and say so ("Couldn't check which agents use it — remove anyway?") instead of a clean confirm. [apps/web/src/routes/(app)/settings/providers/+page.svelte]
- [x] [Review][Patch][Med] CostCapsEditor `$effect` re-seeds the *other* field on every keystroke and leaves a stale error — because `onCapsChange` sets `costCap` synchronously, the adopt-external effect runs on each edit, overwriting an in-progress (invalid) entry in the non-focused field and leaving its `*Error` + `aria-invalid` stale. Only adopt when the persisted side actually changed (track last-adopted), and clear that field's error when re-seeding. [apps/web/src/lib/components/CostCapsEditor.svelte]
- [x] [Review][Patch][Low] `parseMoney` accepts any 3-letter uppercase currency (and mismatched per-run/per-day) despite MVP USD-only; the web always renders `$`, so a non-USD stored cap misrenders. Restrict `currency` to `"USD"` (MVP) with a stated 400. [apps/control-api/src/agents/routes.ts]
- [x] [Review][Patch][Low] `parseCostCap` accepts an array body (`typeof [] === "object"`) → `{ costCap: [] }` returns 200 and silently clears both caps. Reject non-plain-object / array with 400. [apps/control-api/src/agents/routes.ts]
- [x] [Review][Patch][Low] Skill picker: `Esc` only closes from the search input, and focus is dropped to `<body>` after attach — move Esc handling to the popover container and restore focus to the "Add skill" button on close/attach. [apps/web/src/lib/components/SkillsEditor.svelte]
- [x] [Review][Defer][Low] Dependents matched by provider **kind**, not connection id — with two same-kind providers, removing either falsely warns "they'll have no model." Refining needs the agent's `model` to carry a connection id (a design change); deferred (typically one provider per kind at MVP).
- [x] [Review][Defer][Low] `SkillId` (web) duplicates domain `BuiltinSkill`, and control-api's `BUILTIN_SKILLS` is a third copy — three sources of truth for the four skill ids. Deferred (web is intentionally decoupled from `@turanga/domain`); fold into the shared-type-consolidation cleanup.
- [x] [Review][Defer][Low] Partial `costCap` PATCH nulls the omitted side (whole-object replace) — fine for the in-app editor (always sends both) but a partial writer loses the other cap silently. Deferred; document costCap as a replace-whole field.
- [x] [Review][Defer][Low] Dependents string concatenates all agent names unbounded and scans the full agent list per arm — fine at MVP scale; cap/paginate later.
- [x] [Review][Defer][Low] A `$0.00` (minor 0) cap is accepted and formatted identically to an unset cap — a zero ceiling is a legitimate (if useless) value; revisit when caps are enforced (Epic 4).

## Dev Notes

**Fourth Epic 3 story — attach skills, scope them, gate send. Build: skills persistence (`AttachedSkill[]`), the `SkillsEditor` (rectangular chips + searchable picker + inline scope select + outbound send toggle), and the Skills section. Do NOT build: Cost caps (3.5), Activate (5.1), the Allowlist section, or any Test-run / actual permission/send *enforcement* (that's the Guard + harness in Epic 4). This story captures the config only. No new external tech — Drizzle migration + guarded Hono PATCH + SvelteKit, all established in 3.1–3.3.**

### Architecture / constraints
- **AD-7 single-writer:** `control-api` is the sole writer — the editor autosaves via `PATCH /agents/:id`. Mirror the 3.2/3.3 seq-guarded `persist()`. [ARCHITECTURE-SPINE.md AD-7]
- **AD-8 send-gate:** "Send-gated actions produce an artifact and the Run completes; approve/send is a separate control-plane action." 3.4 captures the **send grant** (off by default) as config; the actual send/approve flow is Epic 4/5. The agent stays **Draft**; skills are not part of the Activate gate (model + caps only). [ARCHITECTURE-SPINE.md AD-8]
- **AD-9 job spec (deferred consumer):** skills+scopes+send must be snapshotted into the immutable job spec at run start — but the orchestrator/harness are **Epic 4**, so **do NOT change `packages/contracts` or bump `CONTRACT_VERSION`** in 3.4 (no consumer yet; `JobSpec.skills` stays `z.array(z.string())` for now). Leave a note: Epic 4 widens `JobSpec.skills` to carry scope + send and enforces them in the Guard. [ARCHITECTURE-SPINE.md AD-9; packages/contracts]
- **AD-5 allowlist tie-in (context, not built here):** the enforced allowlist = union of attached Connections' destinations (default-deny) + per-agent additions; a skill's permission scope is the agent-side half the Guard will consult. Enforcement is Epic 4. [ARCHITECTURE-SPINE.md AD-5]
- **Default-deny (FR-3):** an attached skill starts at the most-restrictive scope (`none`) and is widened explicitly. Send (FR-18) is a **distinct** grant, off by default, only on the outbound skill. This is the product's "really sandbox agents" wedge — keep the defaults tight.
- **Conventions:** UTC timestamps, semantic Warm Ink tokens only, status never colour-only, verb-first sentence-case copy, visible focus ring, no motion beyond the run pulse. [ARCHITECTURE-SPINE.md#Conventions; DESIGN.md]

### UX specifics (DESIGN.md / EXPERIENCE.md — Warm Ink baseline wins on conflict)
- **`skill-chip`:** `radius: {rounded.md}` (**NOT pill**), `border: 1px solid var(--border-strong)`, rectangular 4px; shows **name + remove**; "Adding opens a **searchable picker popover** (`--shadow-md`)"; "a per-skill **permission scope is set inline**; an outbound (send) permission is a **distinct, off-by-default grant**." Pills are a named **anti-pattern** for skill chips. [DESIGN.md#components.skill-chip, #Shapes, #Anti-patterns]
- **Elevation:** `--shadow-md` is allowed **only** on the skill-picker popover / model dropdown / confirm dialog — use it for the picker, nothing else on this surface. [DESIGN.md#Elevation]
- **Copy:** buttons are verbs — `Add skill`, `Remove`. Sentence case, no exclamation/emoji. Persistent labels on the scope select + send control (not placeholder-only). `Esc` closes the popover; keyboard-reachable. [EXPERIENCE.md#Voice, #Interaction-Primitives, #Accessibility]
- **Autosave / sections:** `Saving… → Saved` `--text-tertiary` micro-cap; collapsible sections, 11px tracked micro-cap labels; no Save button. Skills is the **3rd** section (Model → Instructions → **Skills** → Variables → Cost caps → Allowlist). [EXPERIENCE.md#Component-Patterns; DESIGN.md#components.agent-editor-pane]
- **Colour budget:** chips + permission controls are **ink/neutral** — the saturated-colour budget is reserved for agent lifecycle + connection status only. No colour on skills UI. [DESIGN.md#Color-budget, #Anti-patterns]

### Files being modified (READ current state — preserve behavior)
- **`packages/domain/src/index.ts` (UPDATE):** add `SkillScope` + `AttachedSkill`; change `Agent.skills` to `AttachedSkill[]` (currently `BuiltinSkill[]`, not yet wired to persistence — safe to widen).
- **`apps/control-api/src/db/schema.ts` (UPDATE):** add `skills` jsonb. Preserve columns + migrations `0000`–`0005` (new `0006`).
- **`apps/control-api/src/agents/repo.ts` (UPDATE):** `AgentRow`/`AgentPatch` gain `skills`; thread `toRow`/`applyPatch`/`create`/`update`.
- **`apps/control-api/src/agents/routes.ts` (UPDATE):** `parseSkills` + skills branch in PATCH; create default `skills: []`. Keep name/model/instructions/variables validation + the review hardenings (null-item guard, caps).
- **`apps/web/src/lib/agents.ts` (UPDATE):** `SkillScope`/`AttachedSkill` + `skills` on `Agent`/`AgentPatch`.
- **`apps/web/src/routes/(app)/agents/[id]/+page.svelte` (UPDATE):** add the Skills `<Section>` + local `skills` state + autosave; keep Model/Instructions/Variables, header autosave (seq-guarded), `load()` id-guard, responsive split, notFound/error/Retry.
- **`apps/web/tests/agents.spec.ts` (UPDATE):** append the 3.4 e2e (one file → guaranteed serial ordering; the 3.1 empty-state stays first).
- **NEW:** `apps/web/src/lib/skills.ts` (+ test), `apps/web/src/lib/components/SkillsEditor.svelte`, `apps/control-api/drizzle/0006_*.sql`.

### Previous-story intelligence (Epics 1–3.3)
- **Autosave (3.2/3.3, review-hardened):** `persist()` uses a monotonic `saveSeq` — an out-of-order response can't overwrite newer state; discrete changes persist immediately, text debounces ~400ms. `load()` captures `target = id` and bails if `id` changed. Mirror both for skills (skills are discrete → persist immediately). [3-2, 3-3 review]
- **jsonb array field pattern:** `parseVariables` is the canonical validate-and-cap helper (non-array→400, cap count, per-item validate, dedupe via `Set`, slice oversize) — mirror it for `parseSkills`. Repo threading: `toRow` map, `applyPatch` spread-if-defined, `create` `.values`, `update` `set.x`. Last migration `0005` → `0006`. [3-3]
- **Web patterns:** discriminated `Result<T>`, `credentials:'include'`; `Section` API `<Section label="…">children</Section>`; Warm Ink tokens + `@lucide/svelte`; web vitest is wired (`vitest.config.ts`, node env) for pure-TS helpers — put `skills.ts` logic there and unit-test it. Popover pattern (from InstructionsEditor): `--shadow-md`, `Esc` closes, `onmousedown` preventDefault on options so a click survives blur, keyboard-navigable. [3-3]
- **E2E:** serial (`workers:1`); ALL agent e2e live in `tests/agents.spec.ts` so the fresh-DB empty-state runs first; rows are `a.agent` links; skills need **no** provider, so the 3.4 flow is fully e2e-able. [3-2, 3-3]
- **Known deferrals (do not reopen):** same-ms ordering, `state` CHECK, vacuous single-writer test, native-select model deviation, autosave-indicator polish, Retry button, domain/repo nullability, `x-forwarded-for` limiter (`deferred-work.md`).

### Testing standards
- **Unit (control-api):** create default `[]`; GET returns skills; PATCH valid persist + 400 on unknown-skill/unknown-scope/non-boolean-send/duplicate/over-cap/non-array; send normalized off for non-outbound, allowed on draft-reply; guard 401. In-memory repo.
- **Unit (web):** `skills.ts` helpers.
- **E2E (Playwright, live stack, serial):** add via picker → rectangular chip + default No-access scope; draft-reply shows an off-by-default Allow-send; widen scope; remove; persist across reload.
- `svelte-check` 0, build 6/6, lint clean, Epic 1/2/3.1–3.3 regressions green.
- **DoD:** attach/remove built-in skills via a searchable picker (rectangular chips, never pills); per-skill scope set inline defaulting to deny; outbound send a distinct off-by-default grant; persist via control-api only (AD-7); agent stays Draft; regressions intact; only permitted sections modified. NO cost caps/activate/allowlist/test-run; NO permission/send *enforcement*; NO contract/version change (Epic 4).

### Project Structure Notes
- New (control-api): migration `0006`. New (web): `skills.ts` + test, `SkillsEditor.svelte`. Modified: control-api `schema.ts`/`repo.ts`/`routes.ts`/`agents.test.ts`, domain `index.ts`, web `agents.ts`/`agents/[id]/+page.svelte`/`tests/agents.spec.ts`. Contracts intentionally untouched (Epic 4). [ARCHITECTURE-SPINE.md#Structural-Seed, AD-7, AD-9]

### References
- [Source: _bmad-output/planning-artifacts/epics.md#Epic-3 / Story-3.4; FR-3, FR-17, FR-18]
- [Source: ARCHITECTURE-SPINE.md AD-5, AD-7, AD-8, AD-9, #Conventions, #Capability-Map]
- [Source: ux-designs/ux-turanga-2026-07-30/DESIGN.md#components.skill-chip/#agent-editor-pane, #Shapes, #Elevation, #Anti-patterns, #Color-budget]
- [Source: ux-designs/ux-turanga-2026-07-30/EXPERIENCE.md#Component-Patterns, #Interaction-Primitives, #Accessibility, #Voice, Key-Flow-1]
- [Source: packages/domain (Agent.skills, BuiltinSkill), packages/contracts (JobSpec.skills)]
- [Source: _bmad-output/implementation-artifacts/3-3-instructions-variables.md + 3-2-agent-definition-model.md (repo/route/guard/autosave/Section/popover patterns); deferred-work.md]

## Dev Agent Record

### Agent Model Used
claude-opus-4-8[1m]

### Debug Log References
- Widening domain `Agent.skills` from `BuiltinSkill[]` to `AttachedSkill[]` broke `packages/domain/src/index.test.ts` (used `skills: ["read-search"]`). Updated the fixture to `[{ skill, scope, send }]`.

### Completion Notes List
- **Task 1** — domain `SkillScope` + `AttachedSkill`; `Agent.skills` widened to `AttachedSkill[]`. `skills jsonb` column on `agents` (migration `0006`); `AgentRow`/`AgentPatch` + toRow/applyPatch/create/update threaded (Drizzle + memory).
- **Task 2** — `parseSkills` (mirrors `parseVariables`): array + cap 4; each `{skill,scope,send}` validated against the 4 built-ins / 3 scopes / boolean send; duplicate rejected; **send forced off for non-outbound skills** (only `draft-reply` is outbound). Wired into `PATCH /agents/:id`; `POST` defaults `skills: []`.
- **Task 3** — web `SkillId`/`SkillScope`/`AttachedSkill` + `skills` on `Agent`/`AgentPatch`. `$lib/skills.ts`: `BUILTIN_SKILLS` (display labels), `OUTBOUND_SKILLS`, `isOutbound`, `SCOPE_LABELS`/`SCOPE_ORDER`, `skillLabel`, `attachableSkills`.
- **Task 4** — `SkillsEditor.svelte`: rectangular chips (`--radius-md`, `--border-strong`, 4px — never a pill) with name + Remove; inline **Permission scope** select (default No access) and, only for the outbound skill, a distinct **Allow send** checkbox (off by default); **Add skill** opens a searchable picker popover (`--shadow-md`, `Esc` closes) over the not-yet-attached built-ins. Wired into the definition surface as `<Section label="Skills">` between Instructions and Variables; discrete changes → seq-guarded `persist({ skills })`.
- **Task 5** — control-api unit +6 (create default `[]`; persist/durable; send normalization; unknown-skill/scope/non-boolean-send/duplicate/over-cap/non-array 400; 401) → **51/51**. Web unit +3 (`skills.ts` helpers). E2E +1: attach via picker → rectangular chip + default-deny scope + no send control; draft-reply off-by-default send; widen scope; remove; persist across reload → **13/13**.
- **Verification** — `pnpm -r build` 6/6, `pnpm -r test` all green (control-api 51, web 9, domain 2), `pnpm lint` clean, `svelte-check` 0, live-stack Playwright 13/13 against a fresh docker stack (migration 0006).

**Documented deferrals (unchanged from the story):** scope semantics are an MVP abstraction (`none`/`read`/`read-write`, default-deny) — concrete per-skill meaning + **enforcement** of scopes/send is Epic 4 (the Guard / harness). `packages/contracts`/`CONTRACT_VERSION` intentionally NOT changed — `JobSpec.skills` widens to carry scope+send when the harness enforces them (Epic 4, no consumer yet).

### File List
- NEW `apps/control-api/drizzle/0006_wild_leech.sql` (+ `drizzle/meta`)
- NEW `apps/web/src/lib/skills.ts`
- NEW `apps/web/src/lib/skills.test.ts`
- NEW `apps/web/src/lib/components/SkillsEditor.svelte`
- MOD `packages/domain/src/index.ts` (SkillScope, AttachedSkill, Agent.skills)
- MOD `packages/domain/src/index.test.ts` (skills fixture)
- MOD `apps/control-api/src/db/schema.ts` (skills jsonb)
- MOD `apps/control-api/src/agents/repo.ts` (skills field + threading)
- MOD `apps/control-api/src/agents/routes.ts` (parseSkills + PATCH branch + create default)
- MOD `apps/control-api/src/agents/agents.test.ts` (+6 tests)
- MOD `apps/web/src/lib/agents.ts` (skills types)
- MOD `apps/web/src/routes/(app)/agents/[id]/+page.svelte` (Skills section + autosave)
- MOD `apps/web/tests/agents.spec.ts` (+ skills e2e)

### Change Log
- 2026-08-01 — Story 3.4 implemented: attach built-in skills via a searchable picker (rectangular chips), inline default-deny permission scope, distinct off-by-default send grant for the outbound skill, persisted + autosaved via control-api (AD-7). Status → review.
