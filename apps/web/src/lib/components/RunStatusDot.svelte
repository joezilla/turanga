<script lang="ts">
  // Run lifecycle shown as dot + word — never colour-only (UX-DR11). The `running` variant pulses
  // (1600ms — the only looping motion in the test pane; DESIGN.md#Motion). Terminal states map to
  // the lifecycle tokens. `reduce-motion` users get a static dot.
  import { Circle } from "@lucide/svelte";
  import type { RunStatus } from "$lib/runs";

  let { status }: { status: Exclude<RunStatus, "created"> } = $props();

  const color = $derived(
    status === "running"
      ? "var(--state-running)"
      : status === "succeeded"
        ? "var(--state-succeeded)"
        : status === "failed"
          ? "var(--state-failed)"
          : "var(--state-killed)",
  );
</script>

<span class="run-status" class:pulse={status === "running"}>
  <Circle size={7} fill={color} color={color} aria-hidden="true" />
  <span class="word">{status}</span>
</span>

<style>
  .run-status {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    color: var(--text-secondary);
    font-size: var(--text-sm);
  }
  /* The single looping motion in the pane: the in-flight dot pulses at 1600ms. */
  .pulse :global(svg) {
    animation: run-pulse 1600ms ease-in-out infinite;
  }
  @keyframes run-pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.35;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .pulse :global(svg) {
      animation: none;
    }
  }
</style>
