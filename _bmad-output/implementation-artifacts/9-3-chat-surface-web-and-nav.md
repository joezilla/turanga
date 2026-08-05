---
baseline_commit: f1f1d5f6004ce5970027717ac349ca89651243f2
---
# Story 9.3: The chat surface (web) + enable the nav

Status: review

<!-- THIRD story of Epic 9 (Chat). 9.1 modeled the conversation; 9.2 made a turn RUN (POST
     /conversations/:id/messages → a run built from the pinned published snapshot, streaming over the
     existing run SSE). 9.3 is the WEB surface: enable the disabled Chat nav item, add a /chat route
     where the builder picks a PUBLISHED agent, starts/continues a conversation, sends a message, and
     watches the reply STREAM in — reusing RunTranscript + the run SSE wholesale. One backend gap must
     close first: a thread's prior turns are its linked runs, but there is NO HTTP endpoint to read
     them (listByConversation exists in the repo, unexposed) — 9.3 adds GET /conversations/:id/runs.
     Builder-first (single-tenant, control-plane only). No rename/delete/history-windowing (9.4). No
     contract bump, no migration. -->

## Story

As the builder,
I want a chat page where I pick a published agent and hold a conversation,
so that I can actually use my agents conversationally.

## Acceptance Criteria

1. **Given** the `/chat` route (the nav's disabled Chat item is now enabled), **when** it is opened, **then** the builder picks a **published** agent, starts or continues a conversation, sends a message, and sees the reply **stream** in (reusing `RunTranscript` + the run SSE); multiple conversations per agent are listed. An agent with **no published version** shows the "publish first" empty state (and if NO agent is published, the surface points the builder at publishing one). [Source: epics.md#Story-9.3 AC1]

2. **Given** a conversation, **when** it is viewed, **then** the thread shows the interleaved **user/agent turns** (reconstructed from its linked runs), the **pinned version** (v_N), and **per-turn cost/observability**; voice + a11y per the cross-cutting conventions (verb-first buttons, empty = fact + one action, status = dot + word never colour-only, visible focus, mono-num for numbers — UX-DR15/16, NFR-6). [Source: epics.md#Story-9.3 AC2]

3. **Given** the thread machinery, **when** the web reads a conversation's turns, **then** a control-plane endpoint `GET /conversations/:id/runs` returns the conversation's runs (turnIndex ASC, with transcripts) so prior turns render — backed by the existing `RunsRepo.listByConversation` (9.2), control-api sole writer/reader boundary intact (AD-7), session-guarded. [Source: 9.2 listByConversation; the thread-read gap]

## Tasks / Subtasks

### Cluster A — backend: expose the thread's turns (AC #3)

- [x] **Task 1: `GET /conversations/:id/runs` — read a conversation's turns** (AC: #2, #3)
  - [x] `apps/control-api/src/conversations/routes.ts` — add `runsRepo: RunsRepo` to `conversationRoutes(repo, agentsRepo, orchestrator, runsRepo)` (import `type { RunsRepo }` from `../runs/repo.js`). Add `GET /conversations/:id/runs`: `const conv = await repo.get(id); if (!conv) return 404 "That conversation doesn't exist.";` then `return c.json({ runs: await runsRepo.listByConversation(id) })` (full `RunRow[]` with transcript, turnIndex ASC — the web's `Run` type already matches). Already session-guarded via `/conversations/*`.
  - [x] `apps/control-api/src/app.ts` — pass `runsRepo` into `conversationRoutes(conversationsRepo, agentsRepo, orchestrator, runsRepo)` (runsRepo is already constructed above the orchestrator at `:104`). `apps/control-api/src/server.ts` — no change (createApp builds the route; server injects the orchestrator/repos it already passes).
  - [x] Tests (`conversations/routes.test.ts`): `GET /conversations/:id/runs` returns the linked runs turnIndex-ASC with transcripts (seed via a `memoryRunsRepo` passed into `appWithSession`); unknown conversation → 404; session-guarded (401). Extend `appWithSession` to accept an optional `runsRepo`.

### Cluster B — the web conversations client (AC #1, #2)

- [x] **Task 2: `$lib/conversations.ts` — the chat client** (AC: #1, #2)
  - [x] `apps/web/src/lib/conversations.ts` (NEW) — mirror the `$lib/agents.ts` / `$lib/memory.ts` template: `base` (`VITE_CONTROL_API_URL`), `req<T>()` (`credentials:"include"`, `Result<T>`), the malformed-body guard, and the 404→null discrimination for single fetches. Re-use `Run`, `RunMessage`, `runEventsUrl`, `getRun`, `runCause`, `type Result` from `$lib/runs` (do NOT re-declare them). A `Conversation` type MIRRORS `@turanga/domain` (KEEP IN SYNC): `{ id: string; agentId: string; publishedVersion: number; title: string; createdAt: string }`. Functions:
    - `createConversation(agentId: string, title?: string): Promise<Result<Conversation>>` → `POST /conversations` `{agentId, title}`, unwrap `{ conversation }`. The server's 409 "Publish this agent to chat with it." string flows through as the error.
    - `listConversations(agentId: string): Promise<Result<Conversation[]>>` → `GET /conversations?agentId=…`, unwrap `{ conversations }` (array guard).
    - `getConversation(id: string): Promise<Result<Conversation | null>>` → `GET /conversations/:id`, 404→null.
    - `sendMessage(conversationId: string, taskInput: string): Promise<Result<Run>>` → `POST /conversations/:id/messages` `{taskInput}`, unwrap `{ run }` (copy `startRun` from `runs.ts:52-70`, change only URL + body). The caller opens `runEventsUrl(run.id)` for the SSE.
    - `listConversationRuns(id: string): Promise<Result<Run[]>>` → `GET /conversations/:id/runs`, unwrap `{ runs }` (array guard).

### Cluster C — the chat surface (AC #1, #2)

- [x] **Task 3: Enable the Chat nav item** (AC: #1)
  - [x] `apps/web/src/lib/components/NavRail.svelte` — line 15: flip the Chat item `disabled: true → false` and clear `reason` (`{ href: "/chat", label: "Chat", icon: MessageCircle, disabled: false, reason: "" }`). The href + icon import + active-highlight are already in place; nothing else changes.

- [x] **Task 4: The chat list column + empty pane** (AC: #1)
  - [x] `apps/web/src/routes/(app)/chat/+layout.svelte` (NEW) — the 264px list column, mirroring `agents/+layout.svelte` (list column + `{@render children()}`; the shell + client auth guard come from `(app)/+layout.svelte` free). Contents: (a) a **published-agent picker** — `listAgents()` filtered to `publishedVersion !== null`; a `<select>` (or compact list) bound to `selectedAgentId` ($state); an `aria-label`. (b) the selected agent's **conversations** — `listConversations(selectedAgentId)` (newest-first), each a `<a href="/chat/{c.id}">` row (title or "Untitled", pinned `v{publishedVersion}`, `formatTimestamp(createdAt)` mono-num), `aria-current="page"` for the open one (`page.params.conversationId`). (c) a **"New conversation"** verb-first button → `createConversation(selectedAgentId)` → `goto("/chat/{id}")`. States via the `loadState` machine (`"loading"|"ok"|"error"` + a `seq` guard, from `runs/+page.svelte`). Empty states (fact + one action): no published agents → "Publish an agent to chat with it." + a link to `/agents`; a published agent with no conversations → "No conversations yet." + the New button. When the open conversation implies an agent (a `[conversationId]` page loaded it), keep `selectedAgentId` in sync.
  - [x] `apps/web/src/routes/(app)/chat/+page.svelte` (NEW) — the default detail pane (no conversation selected): a centered "fact + one action" empty card, mirroring `agents/+page.svelte` ("Pick a conversation, or start a new one.").

- [x] **Task 5: The conversation thread + composer + live streaming** (AC: #1, #2)
  - [x] `apps/web/src/routes/(app)/chat/[conversationId]/+page.svelte` (NEW) — the thread pane. **Load** (`loadState` + `seq` guard): `getConversation(id)` (404 → "That conversation doesn't exist.") + `listConversationRuns(id)` → the prior turns. **Render the thread**: for each run (turnIndex ASC), render `<RunTranscript transcript={run.transcript} showMetrics />` (a chat turn is a two-`turn` transcript — user + agent — plus metrics; RunTranscript handles it as-is), each turn showing its per-turn cost (`formatMicros(run.costMicros)` mono-num) + a `RunStatusDot`-style dot+word for a failed/killed turn (with `runCause(run.status, run.reason)`). Header: the agent name + the **pinned version** (`v{conversation.publishedVersion}`). **The composer**: a textarea + a verb-first **Send** button (Cmd/Ctrl+Enter to send, mirroring TestConsole); disabled while a turn is streaming (one turn at a time). **Live streaming on Send** — mirror `TestConsole.runTest/closeStream/onDestroy` EXACTLY: `sendMessage(id, text)` → on `{run}`, open `new EventSource(runEventsUrl(run.id), { withCredentials: true })`; append each `message` frame to a live `streamingTranscript` ($state, `[...t, msg]` — never `.push`); the `done` NAMED event sets the turn terminal + `closeStream()`; `onerror` only surfaces if `done` never arrived (`doneReceived` discriminator); a `runGen` generation guard drops a superseded stream; `onDestroy(closeStream)`; the `es`/`doneReceived`/`runGen` are plain `let` (NOT `$state`). Render the in-flight turn as the newest thread entry with a pulsing `--state-running` dot. On `done`, keep the streamed transcript (it equals the persisted turn) — optionally re-`listConversationRuns` to reconcile. **Republished-mid-conversation note (from 9.2 AC3):** the conversation stays pinned to its version; a "the agent was updated — start a new chat for v_N" hint is a nice-to-have (surface it if `agent.publishedVersion > conversation.publishedVersion`), not required.

### Cluster D — tests + verification (AC: all)

- [x] **Task 6: Tests + full verification** (AC: all)
  - [x] **control-api unit** (Task 1 tests above) — the new endpoint (turnIndex-ASC with transcripts, 404, session-guard).
  - [x] **web** — `svelte-check` clean (the new client + 3 routes + nav change typecheck).
  - [x] **Playwright** (`apps/web/tests/chat.spec.ts`, NEW — config-only where possible, like memory.spec): the **Chat nav item is enabled** and `/chat` loads; with a **published** agent, the picker lists it and "New conversation" creates one that appears in the list + navigates to the thread; an unpublished-only account shows the **"publish first"** empty state; the thread pane shows the composer + a "No messages yet."-style empty thread. **The send→stream→reply flow needs a real model (provider-key-gated)** — assert the composer + Send exist + the conversation/create/list flow; note the live-reply streaming is covered by the 9.2 unit tests + is manual/gated in e2e (same posture as the test-console run happy path). To seed a published agent: create an agent via the API, set a model, publish (mirror the providers/agents specs' setup).
  - [x] `pnpm -r build` · `pnpm lint` · all unit suites green · **e2e via `deploy/test-stack.sh`** — no new migration; prove `/chat` + create/list + the publish-first empty state live; **never `down -v` the dev stack**; warm Vite before Playwright; restore + verify dev data. See [[turanga-e2e-clean-run]].
  - [x] Bookkeeping: check every task box, fill Dev Agent Record / File List / Change Log, Status → review.

## Dev Notes

**Chat, visible at last.** 9.1/9.2 built the model + the run; 9.3 is where the builder actually chats. The whole streaming half is a verbatim reuse of the test console — the only genuinely new backend piece is reading a thread's prior turns.

### THE one backend gap — `GET /conversations/:id/runs` (do this first)
A conversation has no messages table; its thread is its **linked runs** (each run: `taskInput` = the user message, the `turn` role:"agent" in `transcript` = the reply, linked by `conversationId`/`turnIndex`). `RunsRepo.listByConversation` (9.2, `runs/repo.ts`) returns exactly this (full `RunRow[]`, turnIndex ASC) but is **only called internally by the orchestrator** — no HTTP route exposes it. Without the new endpoint the web can start + stream a turn but cannot render prior turns on load/refresh. The endpoint is a thin pass-through (`runsRepo.listByConversation(id)`), conversation-scoped for a clean 404, session-guarded by the existing `/conversations/*` mount.

### The streaming lifecycle — reuse TestConsole VERBATIM (the gotchas are load-bearing)
`TestConsole.svelte` is the exact template (`runTest`/`clearTest`/`closeStream`). Carry over every gotcha:
- **`EventSource` with `{ withCredentials: true }`** (the session cookie; without it the stream is unauthenticated) — the SSE analogue of `credentials:"include"`.
- **`done` is a NAMED SSE event** (`addEventListener("done", …)`), separate from `message` (the transcript frames). It carries `{ status }`.
- **`transcript = [...transcript, msg]`** (a NEW array) drives live reactivity — never `.push`.
- **The `runGen` generation guard** — every async callback re-checks `myGen !== runGen` before writing state, so sending a second message or switching conversations mid-stream drops the old stream's frames. Key the reset `$effect` on **`conversationId`** (switching threads bumps the generation + `closeStream`).
- **`doneReceived`** distinguishes a clean close from a mid-stream drop (`EventSource.onerror` fires on normal server close too — only surface an error if `done` never arrived).
- **We own `closeStream()`** on done/error to suppress the browser's auto-reconnect (there is deliberately NO reconnect/resume logic).
- **`es`/`doneReceived`/`runGen` are plain `let`, NOT `$state`** (control-flow scaffolding, not render inputs). `onDestroy(closeStream)` on unmount.

### RunTranscript renders a chat turn AS-IS
A chat exchange is a two-`turn` transcript (user + agent) + `metrics`, which `RunTranscript.svelte` already renders (`turn` → role label + pre-wrap text — the chat bubble). Pass `showMetrics` true for per-turn cost/latency inline. `refusal`/`tool`/`recall` rows render too (a chat turn that hit the Guard or recalled memory shows those inline — free observability). Optional: build `memoryById` from `listAgentMemories(agentId)` and pass it so a recalled-memory row names the memories (as the run-review page does). No changes to `RunTranscript`.

### Reading prior turns vs streaming the new one
- **Prior turns** (already completed) — `listConversationRuns(id)` → each `run.transcript` → `<RunTranscript>`. Persisted, static.
- **The new turn** (just sent) — `sendMessage` → `run.id` → open the SSE → append the live `streamingTranscript` as the newest thread entry; on `done` it's terminal + already persisted. A completed turn and a streaming turn both render through the same `RunTranscript`.

### The published-agent gate
The chat picker shows only `publishedVersion !== null` agents (a runnable published snapshot exists — the 9.1 refusal enforces it server-side too, 409). The agents list itself does NOT filter on this today, so the filter is new to chat. Empty states: no published agents at all → "Publish an agent to chat with it." + link to `/agents`; a published agent with no threads → "No conversations yet." + New.

### Architecture (binding)
- **AD-1 / AD-9** — every turn is still a fresh `--network=none`, cost-capped, Guard-fronted run (9.2); 9.3 adds no runtime surface, only a read endpoint + UI.
- **AD-7 — control-api sole writer.** The new endpoint is a READ; conversation/run state is unchanged. The web never writes run/conversation state except via the existing POST routes.
- **Builder-first** — single-tenant, control-plane only. A shared/end-user chat surface (identity, per-conversation isolation, rate limits) is an explicitly deferred later phase.

### Existing patterns to mirror (file:line)
- **Streaming:** `TestConsole.svelte` (`runTest`/`clearTest`/`closeStream`/`onDestroy`, the `runGen`/`doneReceived` guards, EventSource `{ withCredentials:true }`); `runEventsUrl` + `getRun` + `runCause` + `RunMessage`/`RunStatus` in `$lib/runs.ts`.
- **Transcript render:** `RunTranscript.svelte` (props `transcript`/`showMetrics`/`memoryById`); the completed-render template `agents/[id]/runs/[runId]/+page.svelte` (load + memoryById + `<RunTranscript … showMetrics {memoryById} />`).
- **Web client:** `$lib/agents.ts` (`base`/`req`/`Result`/`listAgents`, the array guard) + `$lib/memory.ts` (the mirror/KEEP-IN-SYNC discipline); `getRun`'s 404→null in `$lib/runs.ts`.
- **IA + states:** `agents/+layout.svelte` (the 264px list column, the polling+refresh guard, `/`-to-search, `aria-current`), `agents/+page.svelte` (the empty detail pane), `agents/[id]/runs/+page.svelte` (the `loadState`+`seq` four-state block), `agents/[id]/memory/+page.svelte` (the per-row `busyId` guard).
- **Nav:** `NavRail.svelte:13-19` (the items array; flip Chat's `disabled`).
- **a11y/voice:** `RunStatusDot.svelte` (dot + word, reduced-motion), `.mono-num` (`app.css:21-25`), the focus ring (`app.css:26-31`), `formatTimestamp` (`$lib/datetime`), `formatMicros` (`$lib/money`).
- **Backend endpoint:** `conversations/routes.ts` (9.1/9.2 routes to extend), `runs/repo.ts` `listByConversation` (`:81` / drizzle `:169` / fake `:242`).

### Project Structure Notes
- **New:** `apps/web/src/lib/conversations.ts`; `apps/web/src/routes/(app)/chat/+layout.svelte`, `chat/+page.svelte`, `chat/[conversationId]/+page.svelte`; `apps/web/tests/chat.spec.ts`. **Edited (backend):** `apps/control-api/src/conversations/routes.ts` (+ `routes.test.ts`), `apps/control-api/src/app.ts` (pass `runsRepo`). **Edited (web):** `apps/web/src/lib/components/NavRail.svelte` (enable Chat).
- **No change:** contracts (NO bump), the domain/schema/migrations (no new table/column), the orchestrator, `RunTranscript`/`TestConsole` (reused, not modified), the run SSE route/hub.
- **Scope guard:** NO conversation rename/delete (9.4), NO history windowing (9.4), NO shared/end-user chat surface / identity / rate limits (deferred), NO mid-turn human-in-the-loop or token-level streaming (deferred). This story is: the read endpoint + the web client + the /chat surface (picker, list, thread, composer, live streaming) + the enabled nav.

### Testing standards
- Vitest (control-api endpoint), `svelte-check` (web typecheck), Playwright (`chat.spec.ts`, config-only: nav enabled, picker + publish-first empty state, create/list a conversation, the thread composer/empty state; the live reply is model-gated). Full verification: `pnpm -r build`, `pnpm lint`, `deploy/test-stack.sh` e2e; never `down -v` the dev stack; warm Vite before Playwright.

### References
- [Source: epics.md#Epic-9 (builder-first; reuses the run/SSE/observability machinery; RunTranscript) + #Story-9.3 (the two ACs)]
- [Source: architecture spine #AD-1 (network=none), #AD-7 (control-api sole writer), #AD-9 (immutable JobSpec) ; project-context.md (Warm Ink tokens, voice, a11y) ; DESIGN.md/EXPERIENCE.md (the Test-pane chat pattern: streaming turn + pulsing running dot + mono metrics + inline refusals)]
- [Source: 9-2-run-chat-turn-published-version-history (the messages endpoint + listByConversation this exposes + the SSE reuse) ; 9-1 (the conversation model + publish-first 409)]
- [Source: [[turanga-e2e-clean-run]] — reset for pristine; never `down -v` the dev stack; warm Vite]

## Dev Agent Record

### Agent Model Used

claude-opus-4-8 (Claude Opus 4.8)

### Debug Log References

- **e2e nav-locator strict-mode collision:** `getByRole("link", { name: "Chat" })` matched 4 elements because the spec's other tests create agents named `chat-*`, which render as agent-row links on `/agents` (case-insensitive substring). Fixed by scoping the locator to the nav landmark + exact: `getByRole("navigation", { name: "Workspace" }).getByRole("link", { name: "Chat", exact: true })`. A test-authoring fix, not a code issue.
- **First-test cold-compile login flake:** the first Playwright test occasionally stayed on `/login` after sign-in (a cold `/agents` compile racing the redirect — the known e2e warmup flake). Warming `/login`/`/agents`/`/chat` via curl + a re-run resolved it; the 2 later tests (same `signIn`) always passed.

### Completion Notes List

- **The one backend gap closed:** added `GET /conversations/:id/runs` — a thin session-guarded pass-through to `RunsRepo.listByConversation` (built in 9.2 but never exposed over HTTP). Without it the web could start + stream a turn but not render prior turns on load. Conversation-scoped for a clean 404; a READ (the orchestrator stays the sole writer of run state, AD-7). `runsRepo` threaded into `conversationRoutes` + `app.ts`.
- **`$lib/conversations.ts`** mirrors the `agents.ts`/`memory.ts` client template (base + `req` + `Result` + malformed-body guard + 404→null), and **re-exports** `runEventsUrl`/`getRun`/`runCause`/`Run`/`RunMessage`/`RunStatus` from `$lib/runs` so the chat pages import everything chat-related from one place. `Conversation` mirrors `@turanga/domain` (KEEP IN SYNC).
- **The /chat surface (agent-first IA):** a 264px list column (published-agent `<select>` picker → that agent's conversations → New), an empty detail pane, and the thread page. The picker filters `listAgents()` to `publishedVersion !== null` (the publish gate — e2e-proven: a draft-only agent never appears); the layout keeps the picker in sync with the open conversation (deep-link).
- **The thread + live streaming** reuses TestConsole's lifecycle VERBATIM: `EventSource({ withCredentials: true })`, the named `done` event, the `runGen` generation guard (keyed on `conversationId` so switching threads drops the old stream), the `doneReceived` clean-close-vs-drop discriminator, own-the-close (no auto-reconnect), `es`/`doneReceived`/`runGen` as plain `let`, `onDestroy(closeStream)`. Prior turns render via `<RunTranscript … showMetrics />` (a chat turn is a user+agent transcript — no changes to RunTranscript). The streaming turn shows a pulsing `--state-running` dot and auto-reconciles into the persisted thread on `done` (deduped by run id after a `listConversationRuns` reload). ⌘/Ctrl+↵ sends; the composer disables while a turn streams (one turn at a time).
- **Voice/a11y:** verb-first buttons (Send, New, Start one, Retry), empty states = fact + one action, status = `RunStatusDot` dot+word, mono-num for versions/costs/timestamps, visible focus rings, `aria-live="polite"` thread + `aria-current` selection.
- **NO contract bump, NO migration, NO changes to `RunTranscript`/`TestConsole`** (reused as-is).
- **Verification:** control-api 248 (+2: the new endpoint), svelte-check + `pnpm -r build` + `pnpm lint` clean. e2e on the isolated stack (control-api rebuilt with the new route): the Chat nav is enabled + `/chat` loads; the picker shows only published agents (the draft-only gate); starting a conversation opens the thread with the pinned version + composer + empty-thread state — 3/3 chat.spec tests pass. The live send→reply streaming is model-provider-gated in e2e (unit-covered by 9.2). Dev stack restored, 2 agents intact.

### File List

**New**
- `apps/web/src/lib/conversations.ts` — the chat client
- `apps/web/src/routes/(app)/chat/+layout.svelte` — the list column (agent picker + conversations)
- `apps/web/src/routes/(app)/chat/+page.svelte` — the empty detail pane
- `apps/web/src/routes/(app)/chat/[conversationId]/+page.svelte` — the thread + composer + live streaming
- `apps/web/tests/chat.spec.ts` — the chat Playwright spec

**Edited — control-api**
- `apps/control-api/src/conversations/routes.ts` — `GET /conversations/:id/runs` (+ `runsRepo` param)
- `apps/control-api/src/conversations/routes.test.ts` — the endpoint tests (+ `runsRepo` in `appWithSession`)
- `apps/control-api/src/app.ts` — pass `runsRepo` into `conversationRoutes`

**Edited — web**
- `apps/web/src/lib/components/NavRail.svelte` — enable the Chat nav item

### Change Log

| Date | Version | Description |
|------|---------|-------------|
| 2026-08-05 | 0.1 | Story 9.3 implemented — the chat web surface. Added `GET /conversations/:id/runs` (exposing `listByConversation`), a `$lib/conversations.ts` client, enabled the Chat nav item, and built the `/chat` surface: a published-agent picker + conversation list + a thread with a composer and live reply streaming (reusing TestConsole's EventSource lifecycle + `RunTranscript` verbatim). Agent-first IA; builder-first. No contract bump, no migration. Verified: control-api 248, svelte-check + build + lint clean; e2e proves nav + publish-gate + create/list + the thread (3/3 chat.spec); the live reply is model-gated. Status → review. |
