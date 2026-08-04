<script lang="ts">
  // No agent selected. The list column (agents/+layout.svelte) is already showing everything
  // there is to know; this pane states the fact and points at the one action.
</script>

<main class="pane">
  <div class="empty">
    <p class="title">Pick an agent to edit</p>
    <p class="body">
      An agent's definition, tools, skills and limits all live in one editor. Changes stay a draft until you publish
      them.
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
