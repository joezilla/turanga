<script lang="ts">
  import { Sun, Moon, User, Circle } from "@lucide/svelte";
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

  const dotColor = $derived(
    status === "connected"
      ? "var(--state-succeeded)"
      : status === "unreachable"
        ? "var(--state-failed)"
        : "var(--text-tertiary)",
  );

  function onToggleTheme() {
    toggleTheme();
    theme = getTheme();
  }
</script>

<header class="topbar">
  <span class="workspace">turanga</span>
  <div class="right">
    <span class="status">
      <Circle size={8} fill={dotColor} color={dotColor} aria-hidden="true" />
      <span data-testid="control-status">control plane: {status}</span>
    </span>
    <button class="icon-btn" onclick={onToggleTheme} aria-label="Toggle theme">
      {#if theme === "dark"}<Sun size={16} color="currentColor" />{:else}<Moon size={16} color="currentColor" />{/if}
    </button>
    <button class="icon-btn" aria-label="Account menu">
      <User size={16} color="currentColor" />
    </button>
  </div>
</header>

<style>
  .topbar {
    height: var(--topbar-h);
    flex: 0 0 var(--topbar-h);
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 var(--space-4);
    border-bottom: 1px solid var(--border-subtle);
    background: var(--bg-canvas);
  }
  .workspace {
    font-weight: var(--weight-medium);
    color: var(--text-primary);
  }
  .right {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }
  .status {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1-5);
    font-family: var(--font-mono);
    font-variant-numeric: var(--numeric-tabular);
    font-size: var(--text-2xs);
    color: var(--text-tertiary);
  }
  .icon-btn {
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
  .icon-btn:hover {
    background: var(--surface-hover);
  }
</style>
