<script lang="ts">
  // Control-plane reachability readout. Lived in the topbar until the design replaced it with
  // the nav rail; it now sits in the agents list-column footer. Status is a dot AND a word —
  // never colour alone (UX-DR15).
  import { Circle } from "@lucide/svelte";

  type Status = "checking" | "connected" | "unreachable";
  let status = $state<Status>("checking");

  const base = import.meta.env.VITE_CONTROL_API_URL ?? "http://localhost:8080";

  $effect(() => {
    fetch(`${base}/health`)
      .then((r) => r.json())
      .then((b: { ok?: boolean }) => (status = b?.ok ? "connected" : "unreachable"))
      .catch(() => (status = "unreachable"));
  });

  const dotColor = $derived(
    status === "connected"
      ? "var(--state-succeeded)"
      : status === "unreachable"
        ? "var(--state-failed)"
        : "var(--text-tertiary)",
  );
</script>

<span class="status">
  <Circle size={7} fill={dotColor} color={dotColor} aria-hidden="true" />
  <span data-testid="control-status">control plane: {status}</span>
</span>

<style>
  .status {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1-5);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-tertiary);
    white-space: nowrap;
  }
</style>
