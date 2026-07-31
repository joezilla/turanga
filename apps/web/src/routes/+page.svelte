<script lang="ts">
  // Story 1.1 — minimal, unstyled. Warm Ink styling lands in Story 1.2.
  // Proves the web app reaches the control plane (AC3).
  type Status = "checking" | "connected" | "unreachable";
  let status = $state<Status>("checking");

  const base = import.meta.env.VITE_CONTROL_API_URL ?? "http://localhost:8080";

  $effect(() => {
    fetch(`${base}/health`)
      .then((r) => r.json())
      .then((b: { ok?: boolean }) => (status = b?.ok ? "connected" : "unreachable"))
      .catch(() => (status = "unreachable"));
  });
</script>

<main>
  <h1>turanga</h1>
  <p data-testid="control-status">control plane: {status}</p>
</main>
