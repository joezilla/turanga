<script lang="ts">
  // Story 1.2 — landing page re-skinned on Warm Ink tokens (semantic tokens only).
  // Still proves control-plane connectivity from Story 1.1 (regression-protected).
  // This is NOT the app shell (Story 1.3) — minimal on purpose.
  import { Circle, Sun, Moon } from "@lucide/svelte";
  import { toggleTheme, getTheme, type Theme } from "$lib/theme";

  type Status = "checking" | "connected" | "unreachable";
  let status = $state<Status>("checking");
  let theme = $state<Theme>("light");

  const base = import.meta.env.VITE_CONTROL_API_URL ?? "http://localhost:8080";

  $effect(() => {
    theme = getTheme();
    fetch(`${base}/health`)
      .then((r) => r.json())
      .then((b: { ok?: boolean }) => (status = b?.ok ? "connected" : "unreachable"))
      .catch(() => (status = "unreachable"));
  });

  // Reserved-signal token: a connected/failed state carries the only saturated colour.
  const dotColor = $derived(
    status === "connected"
      ? "var(--state-succeeded)"
      : status === "unreachable"
        ? "var(--state-failed)"
        : "var(--text-tertiary)",
  );

  function onToggle() {
    toggleTheme();
    theme = getTheme();
  }
</script>

<main>
  <!-- Temporary theme toggle — moves to the topbar in Story 1.3. -->
  <button class="theme-toggle" onclick={onToggle} aria-label="Toggle theme">
    {#if theme === "dark"}<Sun size={16} color="currentColor" />{:else}<Moon size={16} color="currentColor" />{/if}
  </button>

  <section class="card">
    <h1>turanga</h1>
    <p class="status">
      <Circle size={8} fill={dotColor} color={dotColor} aria-hidden="true" />
      <span data-testid="control-status">control plane: {status}</span>
    </p>
  </section>
</main>

<style>
  main {
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: var(--space-8);
  }
  .theme-toggle {
    position: fixed;
    top: var(--space-4);
    right: var(--space-4);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--control-h-md);
    height: var(--control-h-md);
    color: var(--action-ghost-fg);
    background: transparent;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    cursor: pointer;
    transition: var(--transition-control);
  }
  .theme-toggle:hover {
    background: var(--surface-hover);
  }
  .card {
    background: var(--surface-card);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-sm);
    padding: var(--space-8);
    min-width: 320px;
    text-align: center;
  }
  h1 {
    margin: 0 0 var(--space-3);
    font-size: var(--text-3xl);
    line-height: var(--lh-3xl);
    font-weight: var(--weight-medium);
    letter-spacing: var(--tracking-heading);
    color: var(--text-primary);
  }
  .status {
    margin: 0;
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    font-family: var(--font-mono);
    font-variant-numeric: var(--numeric-tabular);
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }
</style>
