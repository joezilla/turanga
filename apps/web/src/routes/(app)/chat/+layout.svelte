<script lang="ts">
  // Chat workspace — master/detail, agent-first (Story 9.3). The 264px list column holds a published-
  // agent picker + that agent's conversations + New; the route content (the thread) fills the rest.
  // Only PUBLISHED agents can be chatted with (publishedVersion != null; the server enforces it too).
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { listAgents, type Agent } from "$lib/agents";
  import { listConversations, createConversation, getConversation, listConversationActivity, type Conversation } from "$lib/conversations";
  import { formatTimestamp } from "$lib/datetime";
  import { chatBus } from "$lib/chatBus.svelte";
  import ControlStatus from "$lib/components/ControlStatus.svelte";

  let { children } = $props();

  let agents = $state<Agent[]>([]); // published-only (filtered below)
  let agentsState = $state<"loading" | "ok" | "error">("loading");
  let agentsError = $state("");
  let selectedAgentId = $state("");

  let conversations = $state<Conversation[]>([]);
  let activity = $state<Record<string, string>>({}); // conversationId → last run createdAt (ISO); derived server-side
  let convState = $state<"loading" | "ok" | "error">("loading");
  let convError = $state("");
  let creating = $state(false);
  let createError = $state("");
  let convSeq = 0;

  const openConvId = $derived(page.params.conversationId ?? "");
  const publishable = $derived(agents.filter((a) => a.publishedVersion !== null));
  const selectedAgent = $derived(publishable.find((a) => a.id === selectedAgentId) ?? null);

  async function loadAgents() {
    agentsState = "loading";
    const r = await listAgents();
    if (r.ok) {
      agents = r.value;
      agentsState = "ok";
      // Default the picker to the first published agent (unless an open conversation sets it below).
      if (!selectedAgentId && publishable.length > 0) selectedAgentId = publishable[0].id;
    } else {
      agentsError = r.error;
      agentsState = "error";
    }
  }

  async function loadConversations() {
    if (!selectedAgentId) {
      conversations = [];
      convState = "ok";
      return;
    }
    const s = ++convSeq;
    convState = "loading";
    const r = await listConversations(selectedAgentId);
    if (s !== convSeq) return; // a newer load started — drop this stale response
    if (r.ok) {
      conversations = r.value;
      convState = "ok";
      // Last activity per conversation (best-effort — a failure just falls back to createdAt in the row).
      void listConversationActivity(selectedAgentId).then((a) => {
        if (a.ok) activity = a.value;
      });
    } else {
      convError = r.error;
      convState = "error";
    }
  }

  $effect(() => {
    loadAgents();
  });

  // Keep the picker in sync with the open conversation (deep-link / conversation→conversation nav).
  $effect(() => {
    const cid = openConvId;
    if (!cid) return;
    void getConversation(cid).then((r) => {
      if (r.ok && r.value) selectedAgentId = r.value.agentId;
    });
  });

  // Reload the conversation list whenever the selected agent changes.
  $effect(() => {
    void selectedAgentId;
    loadConversations();
  });

  // The thread page bumps this after a rename/delete — refresh the list at once.
  $effect(() => {
    if (chatBus.rev > 0) loadConversations();
  });

  async function onNew() {
    if (!selectedAgentId || creating) return;
    creating = true;
    createError = "";
    const r = await createConversation(selectedAgentId);
    creating = false;
    if (r.ok) {
      await loadConversations();
      await goto(`/chat/${r.value.id}`);
    } else {
      createError = r.error;
    }
  }
</script>

<aside class="column">
  <header>
    <h2 class="title">Chat</h2>
    <button type="button" class="secondary" onclick={onNew} disabled={creating || !selectedAgent}>New</button>
  </header>

  {#if agentsState === "loading"}
    <p class="msg">Loading agents…</p>
  {:else if agentsState === "error"}
    <div class="msg-block">
      <p class="msg error">{agentsError}</p>
      <button type="button" class="secondary" onclick={loadAgents}>Retry</button>
    </div>
  {:else if publishable.length === 0}
    <!-- fact + one action: no published agent to chat with -->
    <div class="msg-block">
      <p class="msg">No published agents yet.</p>
      <p class="msg">Publish an agent to chat with it.</p>
      <a class="secondary" href="/agents">Go to agents</a>
    </div>
  {:else}
    <div class="picker">
      <label class="picker-label" for="chat-agent">Agent</label>
      <select id="chat-agent" bind:value={selectedAgentId} aria-label="Choose a published agent">
        {#each publishable as a (a.id)}
          <option value={a.id}>{a.name} · v{a.publishedVersion}</option>
        {/each}
      </select>
    </div>

    {#if createError}<p class="msg error">{createError}</p>{/if}

    <div class="rows">
      {#if convState === "loading"}
        <p class="msg">Loading conversations…</p>
      {:else if convState === "error"}
        <div class="msg-block">
          <p class="msg error">{convError}</p>
          <button type="button" class="secondary" onclick={loadConversations}>Retry</button>
        </div>
      {:else if conversations.length === 0}
        <div class="msg-block">
          <p class="msg">No conversations yet.</p>
          <button type="button" class="secondary" onclick={onNew} disabled={creating}>Start one</button>
        </div>
      {:else}
        {#each conversations as c (c.id)}
          <a class="row" href="/chat/{c.id}" aria-current={c.id === openConvId ? "page" : undefined}>
            <span class="row-top">
              <span class="name">{c.title || "Untitled conversation"}</span>
              <span class="ver mono-num">v{c.publishedVersion}</span>
            </span>
            <span class="row-bottom mono-num">{formatTimestamp(activity[c.id] ?? c.createdAt)}</span>
          </a>
        {/each}
      {/if}
    </div>
  {/if}

  <footer>
    <span class="micro">{conversations.length} conversations</span>
    <ControlStatus />
  </footer>
</aside>

{@render children()}

<style>
  .column {
    width: 264px;
    flex: none;
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-right: 1px solid var(--border-hairline);
    background: var(--bg-sunken);
  }
  header {
    flex: none;
    height: 48px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 var(--space-2-5) 0 var(--space-4);
    border-bottom: 1px solid var(--border-hairline);
  }
  .title {
    margin: 0;
    font-size: var(--text-base);
    font-weight: var(--weight-medium);
    letter-spacing: -0.008em;
  }
  .picker {
    flex: none;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-2-5);
    border-bottom: 1px solid var(--border-hairline);
  }
  .picker-label {
    font-size: var(--text-2xs);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-tertiary);
  }
  .picker select {
    width: 100%;
    height: 28px;
    box-sizing: border-box;
    padding: 0 var(--space-2);
    font-size: var(--text-sm);
    color: var(--text-primary);
    background: var(--surface-inset);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
  }
  .picker select:focus-visible {
    outline: none;
    background: var(--surface-card);
    border-color: var(--border-focus);
    box-shadow: var(--focus-ring);
  }
  .rows {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: var(--space-1-5) 0;
  }
  .row {
    display: flex;
    flex-direction: column;
    gap: var(--space-0-5);
    padding: var(--space-1-5) var(--space-4);
    text-decoration: none;
    color: var(--text-primary);
    border-left: 2px solid transparent;
  }
  .row:hover {
    background: var(--surface-hover);
  }
  .row[aria-current="page"] {
    background: var(--surface-selected);
    border-left-color: var(--text-primary);
  }
  .row:focus-visible {
    outline: none;
    box-shadow: var(--focus-ring);
  }
  .row-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    min-width: 0;
  }
  .name {
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    letter-spacing: -0.004em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ver {
    flex: none;
    font-size: 10px;
    color: var(--text-tertiary);
  }
  .row-bottom {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-tertiary);
  }
  footer {
    flex: none;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-2-5) var(--space-4);
    border-top: 1px solid var(--border-hairline);
  }
  .micro {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: var(--tracking-micro);
    text-transform: uppercase;
    color: var(--text-tertiary);
  }
  .msg {
    margin: var(--space-3) var(--space-4);
    font-size: var(--text-sm);
    color: var(--text-tertiary);
  }
  .msg.error {
    color: var(--critical-500);
  }
  .msg-block {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-2);
    padding: 0 var(--space-4);
    margin: var(--space-3) 0;
  }
  .secondary {
    height: 26px;
    display: inline-flex;
    align-items: center;
    padding: 0 var(--space-2);
    font-size: var(--text-xs);
    font-weight: var(--weight-medium);
    color: var(--action-secondary-fg);
    background: var(--action-secondary-bg);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    cursor: pointer;
    text-decoration: none;
  }
  .secondary:hover:not(:disabled) {
    background: var(--surface-hover);
  }
  .secondary:disabled {
    color: var(--text-disabled);
    cursor: not-allowed;
  }
  .secondary:focus-visible {
    outline: none;
    box-shadow: var(--focus-ring);
  }
</style>
