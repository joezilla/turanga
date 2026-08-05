<script lang="ts">
  // No conversation selected. The list column (chat/+layout.svelte) shows the agent picker + threads;
  // this pane states the fact and points at the one action.
</script>

<main class="pane">
  <div class="empty">
    <p class="title">Pick a conversation, or start a new one</p>
    <p class="body">
      Choose a published agent, then open a conversation to keep chatting — or start a new one. Each message runs the
      agent's published version, network-isolated and cost-capped, and the reply streams back here.
    </p>
  </div>
</main>

<style>
  .pane {
    flex: 1;
    min-width: 0;
    display: grid;
    place-items: center;
    padding: var(--space-8);
    overflow-y: auto;
  }
  .empty {
    max-width: 420px;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    text-align: center;
  }
  .title {
    margin: 0;
    font-size: var(--text-lg);
    font-weight: var(--weight-medium);
    letter-spacing: var(--tracking-heading);
    color: var(--text-primary);
  }
  .body {
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--lh-sm);
    color: var(--text-secondary);
    text-wrap: pretty;
  }
</style>
