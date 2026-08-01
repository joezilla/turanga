<script lang="ts">
  // Status shown as dot + word — never colour-only (UX-DR11). The word is always rendered;
  // the dot is decorative (aria-hidden). Reused by the agents list now; the test pane and
  // run status reuse it in later stories. Lifecycle mapping per DESIGN.md#agent-status-dot.
  import { Circle } from "@lucide/svelte";

  type Status = "draft" | "active";

  let { status }: { status: Status } = $props();

  const color = $derived(status === "active" ? "var(--state-succeeded)" : "var(--text-tertiary)");
</script>

<span class="status-dot">
  <Circle size={7} fill={color} color={color} aria-hidden="true" />
  <span class="word">{status}</span>
</span>

<style>
  .status-dot {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    color: var(--text-secondary);
    font-size: var(--text-sm);
  }
</style>
