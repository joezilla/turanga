<script lang="ts">
  // A conversation thread (Story 9.3). Prior turns are the conversation's linked runs; sending a
  // message runs a new turn against the pinned published snapshot (9.2) and streams the reply over the
  // run SSE — the streaming lifecycle (EventSource, the `runGen` generation guard, the `doneReceived`
  // clean-close-vs-drop distinction, own-the-close) mirrors TestConsole exactly. A turn renders through
  // the shared RunTranscript (a chat turn is a user turn + an agent turn + metrics).
  import { onDestroy } from "svelte";
  import { page } from "$app/state";
  import { Circle } from "@lucide/svelte";
  import RunTranscript from "$lib/components/RunTranscript.svelte";
  import RunStatusDot from "$lib/components/RunStatusDot.svelte";
  import { goto } from "$app/navigation";
  import { getConversation, listConversationRuns, sendMessage, renameConversation, deleteConversation, runEventsUrl, getRun, runCause, type Conversation, type Run, type RunMessage } from "$lib/conversations";
  import { getAgent } from "$lib/agents";
  import { conversationsChanged } from "$lib/chatBus.svelte";
  import { formatMicros } from "$lib/money";

  const conversationId = $derived(page.params.conversationId ?? "");

  let conversation = $state<Conversation | null>(null);
  let agentName = $state("");
  let runs = $state<Run[]>([]); // prior turns, turnIndex ASC
  let loadState = $state<"loading" | "ok" | "notfound" | "error">("loading");
  let loadError = $state("");
  let seq = 0;

  // The composer + the in-flight turn (streamed).
  let draft = $state("");
  let streamRunId = $state<string | null>(null);
  let streamTranscript = $state<RunMessage[]>([]);
  let streamState = $state<"idle" | "running" | "succeeded" | "failed" | "killed" | "error">("idle");
  let streamError = $state("");
  let streamReason = $state("");
  let es: EventSource | null = null; // the live SSE stream (not reactive)
  let doneReceived = false;
  let runGen = 0;

  // Show the streaming turn until its persisted run joins `runs` (dedupe by id after reload).
  const showStreaming = $derived(streamState !== "idle" && (streamRunId === null || !runs.some((r) => r.id === streamRunId)));

  async function load() {
    const s = ++seq;
    loadState = "loading";
    const conv = await getConversation(conversationId);
    if (s !== seq) return;
    if (!conv.ok) {
      loadError = conv.error;
      loadState = "error";
      return;
    }
    if (!conv.value) {
      loadState = "notfound";
      return;
    }
    conversation = conv.value;
    const rr = await listConversationRuns(conversationId);
    if (s !== seq) return;
    if (!rr.ok) {
      loadError = rr.error;
      loadState = "error";
      return;
    }
    runs = rr.value;
    loadState = "ok";
    // The agent name for the header (best-effort — a failure just leaves the version).
    void getAgent(conv.value.agentId).then((a) => {
      if (s === seq && a.ok) agentName = a.value.name;
    });
  }

  async function loadRuns() {
    const rr = await listConversationRuns(conversationId);
    if (rr.ok) runs = rr.value;
  }

  function closeStream() {
    if (es) {
      es.close();
      es = null;
    }
  }

  // A different conversation → reset + close the old stream (the runGen bump discards a superseded start).
  $effect(() => {
    void conversationId;
    runGen++;
    closeStream();
    streamState = "idle";
    streamTranscript = [];
    streamError = "";
    streamReason = "";
    streamRunId = null;
    draft = "";
    load();
  });

  onDestroy(closeStream);

  function send() {
    const text = draft.trim();
    if (streamState === "running" || !text || loadState !== "ok") return;
    closeStream();
    draft = "";
    streamTranscript = [];
    streamError = "";
    streamReason = "";
    streamRunId = null;
    streamState = "running";
    doneReceived = false;
    const myGen = ++runGen;
    void (async () => {
      const started = await sendMessage(conversationId, text);
      if (myGen !== runGen) return; // navigated/superseded during the POST — discard
      if (!started.ok) {
        streamState = "error";
        streamError = started.error;
        return;
      }
      streamRunId = started.value.id;
      const source = new EventSource(runEventsUrl(started.value.id), { withCredentials: true });
      es = source;
      source.addEventListener("message", (e) => {
        if (myGen !== runGen) return; // a superseded stream must not write the current thread
        try {
          streamTranscript = [...streamTranscript, JSON.parse((e as MessageEvent).data) as RunMessage];
        } catch {
          /* skip an unreadable frame rather than break the stream */
        }
      });
      source.addEventListener("done", (e) => {
        if (myGen !== runGen) return;
        doneReceived = true;
        try {
          const { status } = JSON.parse((e as MessageEvent).data) as { status: "succeeded" | "failed" | "killed" };
          streamState = status;
        } catch {
          streamState = "failed";
        }
        closeStream(); // we own the close so the browser doesn't auto-reconnect
        // The turn is now persisted — reload the canonical thread (the streaming turn auto-hides once
        // its run joins `runs`). Pull the persisted reason for a killed/failed cause.
        void loadRuns();
        if (streamState === "killed" || streamState === "failed") {
          void getRun(started.value.id).then((r) => {
            if (myGen === runGen && r.ok && r.value) streamReason = r.value.reason ?? "";
          });
        }
      });
      source.onerror = () => {
        if (myGen !== runGen) return;
        // EventSource also fires error on a normal server close — only surface it if `done` never arrived.
        if (!doneReceived) {
          streamState = "error";
          streamError = "The reply stream dropped before finishing. Check the control plane, then send again.";
        }
        closeStream();
      };
    })();
  }

  function onComposerKeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      send();
    }
  }

  // The persisted cost of a completed turn (summed metrics = the run's costMicros summary).
  const turnCost = (r: Run) => r.costMicros;

  // Management (Story 9.4) — rename + delete.
  let renaming = $state(false);
  let renameDraft = $state("");
  let confirmDelete = $state(false);
  let managing = $state(false); // an in-flight rename/delete

  function startRename() {
    renameDraft = conversation?.title ?? "";
    renaming = true;
  }
  async function saveRename() {
    if (!conversation || managing) return;
    managing = true;
    const r = await renameConversation(conversation.id, renameDraft.trim());
    managing = false;
    if (r.ok) {
      conversation = r.value;
      renaming = false;
      conversationsChanged(); // refresh the list column
    }
  }
  async function doDelete() {
    if (!conversation || managing) return;
    managing = true;
    const r = await deleteConversation(conversation.id);
    managing = false;
    if (r.ok) {
      conversationsChanged();
      await goto("/chat");
    }
  }
</script>

<main class="thread-pane">
  {#if loadState === "loading"}
    <p class="muted center">Loading conversation…</p>
  {:else if loadState === "error"}
    <div class="center empty">
      <p class="error">{loadError}</p>
      <button type="button" class="secondary" onclick={load}>Retry</button>
    </div>
  {:else if loadState === "notfound"}
    <div class="center empty">
      <p>That conversation doesn't exist.</p>
      <a class="secondary" href="/chat">Back to chat</a>
    </div>
  {:else if conversation}
    <header class="head">
      <div class="head-main">
        {#if renaming}
          <input
            class="rename-input"
            bind:value={renameDraft}
            aria-label="Conversation title"
            onkeydown={(e) => {
              if (e.key === "Enter") saveRename();
              else if (e.key === "Escape") renaming = false;
            }}
          />
          <button type="button" class="ghost" onclick={saveRename} disabled={managing}>Save</button>
          <button type="button" class="ghost" onclick={() => (renaming = false)} disabled={managing}>Cancel</button>
        {:else}
          <span class="title">{conversation.title || "Untitled conversation"}</span>
          <button type="button" class="ghost" onclick={startRename}>Rename</button>
        {/if}
      </div>
      <div class="head-meta">
        <span class="agent mono-num">{agentName || conversation.agentId}</span>
        <span class="ver mono-num">pinned v{conversation.publishedVersion}</span>
        {#if confirmDelete}
          <span class="confirm">Delete this conversation?</span>
          <button type="button" class="danger" onclick={doDelete} disabled={managing}>Delete</button>
          <button type="button" class="ghost" onclick={() => (confirmDelete = false)} disabled={managing}>Cancel</button>
        {:else}
          <button type="button" class="ghost" onclick={() => (confirmDelete = true)}>Delete</button>
        {/if}
      </div>
    </header>

    <div class="thread" role="log" aria-live="polite">
      {#if runs.length === 0 && !showStreaming}
        <p class="muted">No messages yet. Send one to start the conversation.</p>
      {:else}
        {#each runs as run (run.id)}
          <div class="turn-block">
            <RunTranscript transcript={run.transcript} showMetrics />
            <div class="turn-foot">
              {#if run.status === "failed" || run.status === "killed"}
                <RunStatusDot status={run.status} />
                {#if runCause(run.status, run.reason)}<span class="cause">{runCause(run.status, run.reason)}</span>{/if}
              {/if}
              {#if turnCost(run) > 0}<span class="turn-cost mono-num">{formatMicros(turnCost(run))}</span>{/if}
            </div>
          </div>
        {/each}

        {#if showStreaming}
          <div class="turn-block">
            <RunTranscript transcript={streamTranscript} showMetrics />
            <div class="turn-foot">
              {#if streamState === "running"}
                <span class="running"><Circle size={7} fill="var(--state-running)" color="var(--state-running)" aria-hidden="true" /> Running…</span>
              {:else if streamState !== "idle"}
                <RunStatusDot status={streamState === "error" ? "failed" : streamState} />
                {#if streamReason}<span class="cause">{streamReason}</span>{/if}
              {/if}
            </div>
          </div>
        {/if}
      {/if}

      {#if streamState === "error"}
        <p class="run-error">
          <Circle size={7} fill="var(--state-failed)" color="var(--state-failed)" aria-hidden="true" />
          <span>{streamError}</span>
        </p>
      {/if}
    </div>

    <div class="composer">
      <label class="visually-hidden" for="chat-message">Message</label>
      <textarea id="chat-message" rows="3" placeholder="Send a message…" bind:value={draft} onkeydown={onComposerKeydown}></textarea>
      <div class="composer-actions">
        <span class="foot">runs the pinned published version · ⌘↵ to send</span>
        <button type="button" class="primary" onclick={send} disabled={streamState === "running" || !draft.trim()}>Send</button>
      </div>
    </div>
  {/if}
</main>

<style>
  .thread-pane {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--bg-canvas);
  }
  .center {
    flex: 1;
    display: grid;
    place-items: center;
    padding: var(--space-8);
  }
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2);
    text-align: center;
  }
  .head {
    flex: none;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-2-5) var(--space-5);
    border-bottom: 1px solid var(--border-hairline);
  }
  .head-main {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
  }
  .title {
    font-size: var(--text-base);
    font-weight: var(--weight-medium);
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .rename-input {
    flex: 1;
    min-width: 0;
    height: 26px;
    padding: 0 var(--space-2);
    font-size: var(--text-sm);
    color: var(--text-primary);
    background: var(--surface-card);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
  }
  .rename-input:focus-visible {
    outline: none;
    border-color: var(--border-focus);
    box-shadow: var(--focus-ring);
  }
  .head-meta {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    font-size: var(--text-xs);
    color: var(--text-tertiary);
  }
  .agent {
    color: var(--text-secondary);
  }
  .ver {
    color: var(--text-tertiary);
  }
  .confirm {
    color: var(--text-secondary);
  }
  .ghost,
  .danger {
    height: 22px;
    padding: 0 var(--space-2);
    font-size: var(--text-2xs);
    border-radius: var(--radius-md);
    background: transparent;
    border: 1px solid var(--border-subtle);
    color: var(--text-secondary);
    cursor: pointer;
  }
  .ghost:hover:not(:disabled) {
    color: var(--text-primary);
    background: var(--surface-hover);
  }
  .danger {
    color: var(--state-failed);
    border-color: var(--border-strong);
  }
  .ghost:disabled,
  .danger:disabled {
    color: var(--text-disabled);
    cursor: default;
  }
  .ghost:focus-visible,
  .danger:focus-visible {
    outline: none;
    box-shadow: var(--focus-ring);
  }
  .thread {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
    padding: var(--space-5);
    max-width: 760px;
    width: 100%;
    margin: 0 auto;
  }
  .turn-block {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .turn-foot {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    font-size: var(--text-xs);
    color: var(--text-tertiary);
  }
  .cause {
    color: var(--text-secondary);
  }
  .turn-cost {
    color: var(--text-tertiary);
  }
  .running {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--text-secondary);
  }
  .run-error {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    margin: 0;
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }
  .muted {
    margin: 0;
    color: var(--text-tertiary);
    font-size: var(--text-sm);
  }
  .error {
    margin: 0;
    color: var(--critical-500);
    font-size: var(--text-sm);
  }
  .composer {
    flex: none;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-5);
    border-top: 1px solid var(--border-hairline);
    max-width: 760px;
    width: 100%;
    box-sizing: border-box;
    margin: 0 auto;
  }
  .composer textarea {
    width: 100%;
    box-sizing: border-box;
    resize: none;
    padding: var(--space-2) var(--space-3);
    font-size: var(--text-sm);
    line-height: var(--lh-sm);
    color: var(--text-primary);
    background: var(--surface-card);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
  }
  .composer textarea:focus-visible {
    outline: none;
    border-color: var(--border-focus);
    box-shadow: var(--focus-ring);
  }
  .composer-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2-5);
  }
  .foot {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-tertiary);
  }
  .primary {
    height: 30px;
    padding: 0 var(--space-4);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--action-primary-fg);
    background: var(--action-primary-bg);
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    cursor: pointer;
  }
  .primary:hover:not(:disabled) {
    background: var(--action-primary-bg-hover);
  }
  .primary:disabled {
    color: var(--text-disabled);
    background: var(--surface-inset);
    cursor: not-allowed;
  }
  .primary:focus-visible {
    outline: none;
    box-shadow: var(--focus-ring);
  }
  .secondary {
    height: 28px;
    display: inline-flex;
    align-items: center;
    padding: 0 var(--space-3);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--action-secondary-fg);
    background: var(--action-secondary-bg);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    cursor: pointer;
    text-decoration: none;
  }
  .secondary:focus-visible {
    outline: none;
    box-shadow: var(--focus-ring);
  }
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
