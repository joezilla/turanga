<script lang="ts">
  // Run-history surfaces (Story 5.3) sit inside the agents workspace, so they need their own
  // scrolling pane next to the list column. Content is unchanged — this only supplies the
  // padded, scrollable region the old page-level shell used to provide.
  let { children } = $props();
</script>

<main class="pane">
  <div class="inner">
    {@render children()}
  </div>
</main>

<style>
  .pane {
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
    padding: var(--space-6);
  }
  .inner {
    max-width: var(--content-max);
  }
</style>
