<script lang="ts">
  // Collapsible config section for the agent-definition pane (Story 3.2). Label is an
  // 11px tracked micro-cap (DESIGN.md#agent-editor-pane); the header is a real button
  // with aria-expanded so it's keyboard-operable. Later stories add more sections.
  import { ChevronDown } from "@lucide/svelte";
  import type { Snippet } from "svelte";

  let { label, open = $bindable(true), children }: { label: string; open?: boolean; children: Snippet } = $props();
</script>

<section class="section">
  <button type="button" class="header" aria-expanded={open} onclick={() => (open = !open)}>
    <ChevronDown size={14} color="currentColor" class={open ? "chev open" : "chev"} aria-hidden="true" />
    <span class="label">{label}</span>
  </button>
  {#if open}
    <div class="body">
      {@render children()}
    </div>
  {/if}
</section>

<style>
  .section {
    border-bottom: 1px solid var(--border-subtle);
  }
  .header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    width: 100%;
    padding: var(--space-3) 0;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-secondary);
  }
  .header:focus-visible {
    outline: 2px solid var(--focus-ring);
    outline-offset: 2px;
    border-radius: var(--radius-sm);
  }
  .label {
    font-size: 11px;
    letter-spacing: var(--tracking-micro);
    text-transform: uppercase;
    font-weight: var(--weight-semibold);
  }
  :global(.chev) {
    transition: transform 120ms ease;
  }
  :global(.chev.open) {
    transform: rotate(0deg);
  }
  :global(.chev:not(.open)) {
    transform: rotate(-90deg);
  }
  .body {
    padding: 0 0 var(--space-4);
  }
</style>
