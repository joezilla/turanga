<script lang="ts">
  import { Sun, Moon, User, Circle } from "@lucide/svelte";
  import { toggleTheme, getTheme, type Theme } from "$lib/theme";
  import { logout } from "$lib/auth";
  import { goto } from "$app/navigation";

  let { email = "" }: { email?: string } = $props();

  type Status = "checking" | "connected" | "unreachable";
  let status = $state<Status>("checking");
  let theme = $state<Theme>("light");
  let menuOpen = $state(false);

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

  async function onLogout() {
    menuOpen = false;
    await logout();
    await goto("/login");
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
    <div class="account">
      <button class="icon-btn" onclick={() => (menuOpen = !menuOpen)} aria-label="Account menu" aria-expanded={menuOpen}>
        <User size={16} color="currentColor" />
      </button>
      {#if menuOpen}
        <div class="menu" role="menu">
          <span class="menu-email">{email}</span>
          <button class="menu-item" role="menuitem" onclick={onLogout}>Log out</button>
        </div>
      {/if}
    </div>
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
  .account {
    position: relative;
  }
  .menu {
    position: absolute;
    top: calc(100% + var(--space-1));
    right: 0;
    min-width: 200px;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-2);
    background: var(--surface-raised);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-md);
    z-index: 10;
  }
  .menu-email {
    padding: var(--space-1) var(--space-2);
    font-size: var(--text-xs);
    color: var(--text-tertiary);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .menu-item {
    text-align: left;
    padding: var(--space-2);
    font-size: var(--text-sm);
    color: var(--text-primary);
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
  }
  .menu-item:hover {
    background: var(--surface-hover);
  }
</style>
