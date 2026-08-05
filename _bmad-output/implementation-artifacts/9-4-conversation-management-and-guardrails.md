---
baseline_commit: 7536793abf1a7be31c50f0360ebe5f59fb617714
---
# Story 9.4: Conversation management + guardrails

Status: done

<!-- FOURTH + FINAL story of Epic 9 (Chat). 9.1 modeled the conversation, 9.2 ran a turn, 9.3 built the
     surface. 9.4 closes the epic: (A) MANAGEMENT — rename + delete a conversation (control-api sole
     writer, AD-7), and surface each conversation's agent + pinned version + LAST ACTIVITY in the list;
     (B) the HISTORY-WINDOWING GUARDRAIL — a long conversation's injected JobSpec.history is BOUNDED
     (last-N exchanges), so a turn's model context (and cost) can't grow unbounded as the thread grows;
     the per-turn cost cap stays authoritative. Windowing is the seam that later composes with Epic 8
     memory summarization (drop-older → summarize-older is additive). "Start a new conversation" already
     exists (9.3). No contract bump, no schema change (last-activity is derived). -->

## Story

As the builder,
I want to manage my conversations and trust their limits,
so that chat is organized and safe to leave running.

## Acceptance Criteria

1. **Given** a list of conversations, **when** the builder manages them, **then** they can **rename**, **delete**, and start a new conversation (control-api sole writer, AD-7); a conversation surfaces its **agent + pinned version + last activity**. [Source: epics.md#Story-9.4 AC1]

2. **Given** a long conversation, **when** a turn runs, **then** the injected `history` is **bounded** (a windowing policy — the seam that later composes with Epic 8 memory), so a turn's context (and cost) can't grow unbounded; the **per-turn cost cap remains authoritative**. [Source: epics.md#Story-9.4 AC2, AD-9]

## Tasks / Subtasks

### Cluster A — backend: rename / delete / last-activity / windowing (AC #1, #2)

- [x] **Task 1: Repos — rename + delete conversations; cascade + last-activity over runs** (AC: #1)
  - [x] `apps/control-api/src/conversations/repo.ts` — add to `ConversationsRepo` + BOTH impls: `rename(id: string, title: string): Promise<void>` (drizzle: `db.update(conversations).set({ title }).where(eq(id))`; fake: mutate the row) and `delete(id: string): Promise<void>` (drizzle: `db.delete(conversations).where(eq(id))`; fake: `rows.delete(id)` + splice `order`). Update the file header ("Rename/delete are Story 9.4" → done).
  - [x] `apps/control-api/src/runs/repo.ts` — add to `RunsRepo` + BOTH impls: (a) `deleteByConversation(conversationId: string): Promise<void>` — the cascade (a conversation's runs ARE its turns; deleting the thread removes them). Drizzle: `db.delete(runs).where(eq(runs.conversationId, conversationId))`; fake: delete matching from `rows` + `order`. (b) `lastActivityByAgent(agentId: string): Promise<Record<string, string>>` — a `{ conversationId → last run createdAt (ISO) }` map for the agent, ONE grouped query (drizzle: `select({ conversationId, last: max(createdAt) }).from(runs).where(and(eq(agentId), isNotNull(conversationId))).groupBy(conversationId)`; fake: reduce). This derives "last activity" with no schema change + no per-turn write.

- [x] **Task 2: Conversations routes — PATCH (rename) + DELETE (cascade)** (AC: #1)
  - [x] `apps/control-api/src/conversations/routes.ts` — add: `PATCH /conversations/:id` (body `{ title }`, validate `title` is a string; `get` → 404 if absent; `rename` → `{ conversation }`) and `DELETE /conversations/:id` (`get` → 404 if absent; `runsRepo.deleteByConversation(id)` THEN `repo.delete(id)` — cascade the turns, then the thread; → `{ ok: true }`). Error shapes mirror the existing routes. Already session-guarded via `/conversations/*`. `runsRepo` is already a param (9.3).
  - [x] Tests (`conversations/routes.test.ts`): rename updates the title (404 unknown); delete removes the conversation AND its linked runs (assert both gone via the repos), 404 unknown; session-guarded (401).

- [x] **Task 3: History windowing — bound the injected thread** (AC: #2)
  - [x] `apps/control-api/src/runs/orchestrator.ts` `validateChatTurn` (`:407-411`) — window the history to the **last N runs** (whole exchanges, so a user turn is never orphaned from its reply): a `const MAX_HISTORY_RUNS = 20;` (near the other tuning constants `:99-104`), then `const windowed = prior.slice(-MAX_HISTORY_RUNS); const history = windowed.flatMap(...)`. **`turnIndex` stays `prior.length`** (the true position — only the injected history is windowed, not the turn number). Comment: the dropped older exchanges are the summarize-older seam (Epic 8 memory) — additive later. The per-turn cost cap (execute's mint) remains authoritative regardless.
  - [x] Test (`conversations/turn.test.ts`): seed a conversation with > `MAX_HISTORY_RUNS` prior runs (each a user+agent transcript), start a turn → the built `JobSpec.history` carries ONLY the last `MAX_HISTORY_RUNS` exchanges (assert via `runtime.established[i].jobSpecJson` — the oldest run's text is absent, the newest present), and `turnIndex` still equals the full prior count.

### Cluster B — web: the management UI + last activity (AC #1)

- [x] **Task 4: `$lib/conversations.ts` — rename / delete / activity clients** (AC: #1)
  - [x] `apps/web/src/lib/conversations.ts` — add: `renameConversation(id, title): Promise<Result<Conversation>>` (PATCH, unwrap `{ conversation }`), `deleteConversation(id): Promise<Result<{ ok: true }>>` (DELETE), and `listConversationActivity(agentId): Promise<Result<Record<string, string>>>` → `GET /conversations/activity?agentId=…` (unwrap `{ activity }`). **Add the matching route** `GET /conversations/activity` in `conversations/routes.ts` (register BEFORE `/:id` so "activity" isn't captured as an id) → `{ activity: await runsRepo.lastActivityByAgent(agentId) }` (400 if no agentId). Mirror the existing client + route conventions.
  - [x] Test (`conversations/routes.test.ts`): `GET /conversations/activity?agentId=` returns the `{ conversationId → lastAt }` map (session-guarded).

- [x] **Task 5: The chat surface — rename + delete + last-activity** (AC: #1)
  - [x] `apps/web/src/routes/(app)/chat/+layout.svelte` — (a) after loading conversations, load `listConversationActivity(selectedAgentId)` and show each row's **last activity** (`formatTimestamp(activity[c.id] ?? c.createdAt)`, mono-num) instead of / alongside createdAt; (b) a per-row **delete** affordance (a small icon-button or a row menu) with a confirm, calling `deleteConversation` → on success reload the list and, if the deleted one was open, `goto("/chat")`; keep the `busyId`-style guard. Refresh the list after a turn is sent (surface new last-activity) — reuse the existing reload.
  - [x] `apps/web/src/routes/(app)/chat/[conversationId]/+page.svelte` — a **rename** affordance in the thread header (an editable title / a rename button → inline input → `renameConversation` → update local + the list). Keep verb-first buttons, confirm on delete, a11y (labels, focus, `aria-live` unaffected). Optionally surface delete here too (deletes → `goto("/chat")`).

### Cluster C — tests + verification (AC: all)

- [x] **Task 6: Tests + full verification** (AC: all)
  - [x] **control-api unit** — rename/delete routes + cascade (Task 2), the windowing (Task 3), the activity endpoint (Task 4); repo methods (rename/delete/deleteByConversation/lastActivityByAgent) agent-scoped where relevant.
  - [x] **web** — `svelte-check` clean.
  - [x] **Playwright** (`chat.spec.ts`, extend — config-only): create a conversation, **rename** it (the new title shows in the list + header), **delete** it (it disappears from the list; an open one navigates back to `/chat`). Last-activity + windowing are backend/unit-covered (the live reply is model-gated).
  - [x] `pnpm -r build` · `pnpm lint` · all unit suites green · **e2e via `deploy/test-stack.sh`** — no migration; prove rename/delete live; **never `down -v` the dev stack**; warm Vite before Playwright; restore + verify dev data. See [[turanga-e2e-clean-run]].
  - [x] Bookkeeping: check every task box, fill Dev Agent Record / File List / Change Log, Status → review. **Epic 9 is complete.**

## Dev Notes

**The epic's capstone — organized + safe.** 9.4 makes chat manageable (rename/delete/last-activity) and safe to leave running (the history window bounds context growth). Two small, independent clusters.

### Decision — delete cascades to the conversation's runs
A conversation's turns ARE runs linked by `conversationId` (9.1/9.2). Deleting the thread should remove them — leaving orphaned runs would pollute the agent's run history + daily-cost aggregation with turns from a thread the builder deleted. So `DELETE /conversations/:id` cascades: `runsRepo.deleteByConversation(id)` then `repo.delete(id)`. This adds the FIRST run-delete surface (`RunsRepo` had none). On the AD-7 boundary: the run-orchestrator remains the sole writer of run *lifecycle* (create/status/cost) — this is a control-plane *cleanup* of a deleted conversation's turns, initiated by control-api, not a lifecycle write. (Test-console/standalone runs have no `conversationId` and are never touched.)

### Decision — last activity is DERIVED (no schema change)
"Last activity" = the newest linked run's `createdAt`. Rather than a stored `last_activity_at` column (a migration + a per-turn write), derive it with ONE grouped query per agent (`lastActivityByAgent` → `{ conversationId → maxCreatedAt }`), merged into the list in the layout. Falls back to the conversation's `createdAt` when it has no runs yet. Leaner (no migration), fine for a builder-first tool. (A stored column would be marginally more stable under run pruning; not worth the migration here.)

### Decision — windowing is LAST-N-RUNS (whole exchanges)
Bound `history` to the last `MAX_HISTORY_RUNS` (= 20) runs — whole exchanges, so a user turn is never separated from its reply. `prior.slice(-MAX_HISTORY_RUNS).flatMap(turns)`. Simple, predictable, and the clean seam: dropping older exchanges is exactly where Epic 8 summarization later plugs in (summarize-older instead of drop-older). **`turnIndex` is NOT windowed** — it stays `prior.length` (the true thread position); only the injected context is bounded. The per-turn cost cap (execute's key mint) is the hard authority on a runaway turn; the window is the soft guardrail against steady growth. (A char/token budget is a later refinement layered on top; a single huge turn is already caught by the cost cap.)

### Architecture (binding)
- **AD-7 — control-api sole writer.** Rename/delete of conversation state go through `conversationsRepo`; the DELETE cascade of a conversation's turns is a control-plane cleanup (the orchestrator still owns run lifecycle). Last-activity is a READ.
- **AD-9 — immutable JobSpec.** Windowing happens control-plane in `validateChatTurn` BEFORE the spec is built; the sandbox still receives an immutable, bounded `history`. No mid-run change.
- **AD-10 — no secret in the sandbox.** History remains secret-free turn content; windowing only trims it.

### Existing patterns to mirror (file:line)
- **Repo methods + fake parity:** `conversations/repo.ts` (create/get/listForAgent → add rename/delete); `runs/repo.ts` (`listByConversation` `:~169` → add `deleteByConversation` + `lastActivityByAgent`; note `and`/`isNotNull`/`max` drizzle imports).
- **Routes:** `conversations/routes.ts` (the 9.1/9.2/9.3 routes — the `c.json({ error }, 4xx)` shapes; register `/conversations/activity` BEFORE `/:id`); `runsRepo` already a param.
- **Windowing site:** `orchestrator.ts:407-411` (the `history` flatMap in `validateChatTurn`), tuning constants `:99-104`.
- **Web client + UI:** `$lib/conversations.ts` (add rename/delete/activity — the `req`/`Result` template); `chat/+layout.svelte` (the list rows + `busyId` guard, the delete affordance + last-activity), `chat/[conversationId]/+page.svelte` (the header → rename). Verb-first buttons, confirm-on-delete, `formatTimestamp` (`$lib/datetime`).
- **Tests:** `conversations/routes.test.ts` (the `appWithSession(agents, convRepo, orchestrator, runsRepo)` harness), `conversations/turn.test.ts` (the `chatOrch` + `jobSpecJson` assertions for windowing), `chat.spec.ts` (the Playwright setup).

### Project Structure Notes
- **Edited (backend):** `apps/control-api/src/conversations/repo.ts` (+ test), `apps/control-api/src/conversations/routes.ts` (+ test), `apps/control-api/src/runs/repo.ts` (+ test), `apps/control-api/src/runs/orchestrator.ts` (+ `conversations/turn.test.ts`). **Edited (web):** `apps/web/src/lib/conversations.ts`, `apps/web/src/routes/(app)/chat/+layout.svelte`, `apps/web/src/routes/(app)/chat/[conversationId]/+page.svelte`, `apps/web/tests/chat.spec.ts`.
- **No change:** contracts (NO bump), the domain, the schema/migrations (last-activity derived — NO new column), `RunTranscript`/`TestConsole`, the SSE route/hub.
- **Scope guard:** NO stored `last_activity_at` column/migration (derived), NO history SUMMARIZATION (the Epic 8 tie-in — 9.4 only drops older exchanges), NO conversation-level cost budget (a later refinement above the per-turn cap), NO shared/end-user chat, NO mid-turn human-in-the-loop. This story is: rename + delete (cascade) + last-activity (derived) + the last-N-runs history window.

### Testing standards
- Vitest (routes: rename/delete/cascade/activity; orchestrator: the window; repos: the new methods), `svelte-check`, Playwright (`chat.spec.ts`: rename + delete flows — config-only). Full verification: `pnpm -r build`, `pnpm lint`, `deploy/test-stack.sh` e2e (no migration); never `down -v` the dev stack; warm Vite.

### References
- [Source: epics.md#Epic-9 (rename/delete/new; last activity; history windowing = the Epic 8 memory tie-in; the per-turn cap stays authoritative) + #Story-9.4 (the two ACs) + #Provisional-later-phase (conversation-level cost budgets — deferred)]
- [Source: architecture spine #AD-7 (control-api sole writer; orchestrator owns run lifecycle), #AD-9 (immutable JobSpec — windowing is control-plane, pre-spec), #AD-10 (no secret in the sandbox)]
- [Source: 9-1/9-2/9-3 (the conversation model + repo/routes + the run link + validateChatTurn's history build + the /chat surface this extends)]
- [Source: [[turanga-e2e-clean-run]] — reset for pristine; never `down -v` the dev stack; warm Vite]

## Dev Agent Record

### Agent Model Used

claude-opus-4-8 (Claude Opus 4.8)

### Debug Log References

- **e2e test-assertion (not a code bug):** the rename test's `getByText("Portfolio review")` matched 2 elements — the thread-header title AND the list row — because the chat bus correctly propagated the rename to both. Scoped to `getByRole("main")`. The publish-gate test flaked once in the full suite (cross-spec timing) but passed in isolation and on re-run; left unchanged.

### Completion Notes List

- **Rename + delete (cascade).** `conversationsRepo.rename`/`delete` + `PATCH`/`DELETE /conversations/:id`. Delete cascades: `runsRepo.deleteByConversation(id)` (the FIRST run-delete surface) then `repo.delete(id)` — a conversation's runs ARE its turns, so the thread's runs go with it (no orphaned run-history/cost). Control-plane cleanup; the orchestrator still owns run *lifecycle* (AD-7). Proven live: send a message → 1 linked run → delete → the conversation 404s AND **0 orphaned runs** remain in the DB. Standalone/test-console runs (no `conversationId`) are never touched.
- **Last activity — derived, no schema change.** `runsRepo.lastActivityByAgent(agentId)` — ONE grouped `max(created_at)` query → `{ conversationId → newest run createdAt }`, exposed at `GET /conversations/activity` (registered BEFORE `/:id` so "activity" isn't captured as an id). The list shows `formatTimestamp(activity[c.id] ?? c.createdAt)` (falls back to createdAt for a thread with no runs yet).
- **History windowing.** `validateChatTurn` bounds the injected `history` to the last `MAX_HISTORY_RUNS = 20` runs (whole exchanges via `prior.slice(-20)`, so a user turn is never orphaned from its reply) — a long thread's model context (and cost) can't grow unbounded. **`turnIndex` stays `prior.length`** (the true position; only the injected context is windowed). The per-turn cost cap remains the hard authority; dropping older exchanges is the Epic 8 summarize-older seam. Unit-proven: 25 prior turns → 20 exchanges (40 history entries) injected, the oldest 5 dropped, `turnIndex` = 25.
- **Web management UI.** `$lib/conversations.ts` gains `renameConversation`/`deleteConversation`/`listConversationActivity`. Rename + delete live in the thread header (verb-first, confirm-on-delete, `aria-label`ed input, ⌘↵/Esc handling); a tiny `chatBus` (mirroring `agentsBus`) lets the thread page signal the sibling list layout to refresh at once after a rename/delete. The list shows last-activity per row.
- **NO contract bump, NO migration** (last-activity derived), no changes to `RunTranscript`/`TestConsole`.
- **Verification:** control-api 253 (+5), contracts 16, domain 5, harness 12, guard 31, svelte-check + `pnpm -r build` + `pnpm lint` clean. e2e on the isolated stack (control-api rebuilt with the new routes): rename shows in header + list; delete removes the row + navigates back to `/chat`; the cascade is proven live (0 orphaned runs) — 5/5 chat.spec. Dev stack restored, 2 agents intact. **Epic 9 is complete.**

### File List

**New**
- `apps/web/src/lib/chatBus.svelte.ts` — the list-refresh bus

**Edited — control-api**
- `apps/control-api/src/conversations/repo.ts` — `rename` + `delete` (both impls)
- `apps/control-api/src/runs/repo.ts` — `deleteByConversation` + `lastActivityByAgent` (both impls; `isNotNull` import)
- `apps/control-api/src/conversations/routes.ts` — `PATCH`/`DELETE /conversations/:id` + `GET /conversations/activity`
- `apps/control-api/src/conversations/routes.test.ts` — management + activity tests
- `apps/control-api/src/runs/orchestrator.ts` — `MAX_HISTORY_RUNS` window in `validateChatTurn`
- `apps/control-api/src/conversations/turn.test.ts` — the windowing test

**Edited — web**
- `apps/web/src/lib/conversations.ts` — rename/delete/activity clients
- `apps/web/src/routes/(app)/chat/+layout.svelte` — last-activity in rows + bus-driven refresh
- `apps/web/src/routes/(app)/chat/[conversationId]/+page.svelte` — rename + delete in the thread header
- `apps/web/tests/chat.spec.ts` — rename + delete e2e

### Change Log

| Date | Version | Description |
|------|---------|-------------|
| 2026-08-05 | 0.1 | Story 9.4 implemented — conversation management + guardrails (Epic 9 FINAL). Rename + delete (delete cascades the conversation's turns via `runsRepo.deleteByConversation`); last-activity derived via a grouped runs query (`GET /conversations/activity`, no migration); the injected chat history bounded to the last 20 exchanges in `validateChatTurn` (`turnIndex` unchanged); web rename/delete in the thread header + last-activity in the list, with a `chatBus` keeping the two in sync. No contract bump, no migration. Verified: control-api 253, build + lint + svelte-check clean; e2e proves rename/delete + the live cascade (0 orphaned runs), 5/5 chat.spec. Status → review. **Epic 9 complete.** |
| 2026-08-05 | 0.2 | Epic 9 code review (9.1–9.4): no High findings — the security spine confirmed. Applied 7 patches: **history reconstructed from succeeded turns only** (a killed/failed prior turn no longer poisons the thread with consecutive user messages); **rename/delete disabled while a turn streams** (closes the delete-during-stream orphaned-run path); `conversationsChanged()` on turn-done (list last-activity refresh); `showStreaming` excludes the error state (no spurious empty block); **empty/whitespace message rejected server-side** (400); **conversation title trimmed + capped (≤200)**; the runs-repo AD-7 comment corrected. 4 deferred (turnIndex concurrency index/lock, server-side in-flight-run reap on delete, re-attach to a running turn on load, thread-read pagination) → deferred-work.md. Verified: control-api 255, build + lint + svelte-check clean; live-proven empty-guard (400) + title trim/cap; chat.spec 5/5. Status → done. |

## Review Findings

_Code review of Epic 9 (stories 9.1–9.4, `9541c7e..0a4197a`), 2026-08-05 — Blind Hunter + Edge Case Hunter + Acceptance Auditor. **No High findings**: all three reviewers independently confirmed the security spine is intact — AD-1 (network=none), AD-7 (control-api sole writer), AD-9 (immutable JobSpec; windowing is control-plane pre-spec), AD-10 (JobSpec.history secret-free via schema stripping), the version-pin (a republish never changes an in-flight conversation), the state-agnostic single `assembleRun` run path, and the standalone-run-safe cascade. Findings below are Medium/Low correctness + robustness._

- [x] [Review][Patch] **A killed/failed prior turn poisons the whole conversation** — history reconstruction (`orchestrator.ts` `validateChatTurn`) flatMaps `turn` messages from ALL prior runs regardless of status. A turn killed/failed after the harness emits its user turn but before the agent reply leaves an orphaned `user` turn in history → `buildMessages` produces two consecutive `user` messages → several model providers reject that (400 on consecutive same-role) → **every subsequent turn in that conversation errors at the model**. Fix: reconstruct history only from **succeeded** runs (`prior.filter(r => r.status === "succeeded").slice(-MAX_HISTORY_RUNS)`) — a succeeded run always carries a clean user+agent pair; this also excludes in-flight runs. `turnIndex = prior.length` stays. [apps/control-api/src/runs/orchestrator.ts validateChatTurn]

- [x] [Review][Patch] **Deleting a conversation mid-turn orphans a live, still-spending run** — the DELETE route deletes the run rows + the conversation but never signals the orchestrator; a turn started moments earlier keeps running the sandbox and spending the minted cost key, and its `setStatus`/`appendMessage` become silent no-ops on the deleted row (cost/status lost, no kill). The web **Delete/Rename buttons are not disabled while a turn streams**, so it's UI-reachable. Fix (web): disable rename + delete while `streamState === "running"`. (Residual — a direct-API delete during a turn still orphans it; a server-side reap of a conversation's in-flight runs is deferred hardening. The run is bounded by the per-run cost cap + the 120s timeout.) [apps/web/src/routes/(app)/chat/[conversationId]/+page.svelte; apps/control-api/src/conversations/routes.ts DELETE]

- [x] [Review][Patch] **The list's last-activity isn't refreshed after a turn is sent** (9.4 Task 5 gap) — the SSE `done` handler calls `loadRuns()` (thread-local) but not `conversationsChanged()`, and the list column only reloads activity on `chatBus.rev` (bumped only on rename/delete). After sending a message the sibling list's "last activity" stays stale until the agent is reselected/reloaded. Fix: `conversationsChanged()` in the `done` handler. [apps/web/src/routes/(app)/chat/[conversationId]/+page.svelte done handler]

- [x] [Review][Patch] **A send-POST failure renders a spurious empty turn block** — `showStreaming = streamState !== "idle" && (streamRunId === null || …)` is true on the `"error"` state (streamRunId null), so a 429/404 send failure renders an empty `<RunTranscript>` + a `failed` status dot in addition to the separate error paragraph. Fix: exclude `"error"` from `showStreaming`. [apps/web/src/routes/(app)/chat/[conversationId]/+page.svelte:39]

- [x] [Review][Patch] **Empty/whitespace message launches a full billable run** — `POST /conversations/:id/messages` coerces a missing/non-string `taskInput` to `""` and never rejects emptiness (the web guards with `draft.trim()`, but the API is the trust boundary). A `{}` / `{"taskInput":"   "}` mints a cost key + establishes a sandbox for an empty turn. Fix: reject an empty/whitespace `taskInput` server-side (400). (Mirrors a pre-existing `runs/routes.ts` gap — out of scope, but chat makes it trivial.) [apps/control-api/src/conversations/routes.ts POST …/messages]

- [x] [Review][Patch] **Conversation title is unbounded (create + rename)** — `title` is only type-checked; `taskInput` is capped at `MAX_TASK_INPUT` but a multi-MB `title` on `POST /conversations` or `PATCH /conversations/:id` is stored verbatim and shipped in every list/activity payload. Fix: cap + trim `title` (e.g. ≤ 200 chars) in `parseCreate` and the PATCH handler (also fixes the client-trims/server-verbatim mismatch). [apps/control-api/src/conversations/routes.ts parseCreate + PATCH]

- [x] [Review][Patch] **Stale AD-7 comment on the runs repo** — `runs/repo.ts` header still declares runs are "Written only by the run-orchestrator (AD-7). No `update(patch)` surface beyond these," but 9.4 added `deleteByConversation` as a control-api (non-orchestrator) writer. Update the comment to note the sanctioned control-plane cleanup exception. [apps/control-api/src/runs/repo.ts:70-71]

- [x] [Review][Defer] **Concurrent sends to one conversation collide on `turnIndex`** — `turnIndex = prior.length` is a read-then-write with no per-conversation lock and no unique `(conversation_id, turn_index)` index; two racing POSTs (two tabs / direct API) both get index N and fork the thread. The single-user UI serializes sends, so low-probability. [apps/control-api/src/runs/orchestrator.ts + db/schema.ts] — deferred: add a unique `(conversation_id, turn_index)` index (a small migration) or a per-conversation advisory lock when concurrency/multi-tenant matters.
- [x] [Review][Defer] **Returning to a conversation mid-stream doesn't re-attach to the running turn** — navigating away closes the EventSource; coming back renders the still-`running` persisted run statically (no live indicator, no re-subscribe), so the reply appears only on a manual reload. [apps/web/src/routes/(app)/chat/[conversationId]/+page.svelte load] — deferred: on load, detect a `running` run and re-open its SSE (real work; rare for a single user).
- [x] [Review][Defer] **`GET /conversations/:id/runs` is unpaginated** — a long thread ships every run's full transcript on every load + every post-turn `loadRuns()`. The model history is windowed (9.4) but the read payload is not bounded. [apps/control-api/src/conversations/routes.ts + runs/repo.ts listByConversation] — deferred: paginate/limit the thread read when threads grow large.

_Dismissed as noise: a sub-second flash where sending a second turn before the just-finished turn reconciles into `runs` briefly hides the completed turn (self-heals when `loadRuns` resolves)._
