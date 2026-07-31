<script lang="ts">
  import { page } from "$app/state";
  import { LayoutGrid, Settings, PanelLeft } from "@lucide/svelte";

  let { collapsed = false, onToggle }: { collapsed?: boolean; onToggle: () => void } = $props();

  const items = [
    { href: "/agents", label: "Agents", icon: LayoutGrid },
    { href: "/settings", label: "Settings", icon: Settings },
  ];
  const active = (href: string) => page.url.pathname.startsWith(href);
</script>

<aside class="sidebar" class:collapsed>
  <button class="collapse" onclick={onToggle} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
    <PanelLeft size={18} color="currentColor" />
  </button>
  <nav>
    {#each items as item (item.href)}
      <a
        class="nav-item"
        href={item.href}
        aria-current={active(item.href) ? "page" : undefined}
        title={collapsed ? item.label : undefined}
      >
        <item.icon size={18} color="currentColor" />
        {#if !collapsed}<span>{item.label}</span>{/if}
      </a>
    {/each}
  </nav>
</aside>

<style>
  .sidebar {
    width: var(--sidebar-w);
    flex: 0 0 var(--sidebar-w);
    border-right: 1px solid var(--border-subtle);
    background: var(--bg-canvas);
    display: flex;
    flex-direction: column;
    padding: var(--space-2);
    gap: var(--space-1);
    transition: width var(--duration-normal) var(--ease-standard);
  }
  .sidebar.collapsed {
    width: 56px;
    flex-basis: 56px;
  }
  .collapse {
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--control-h-sm);
    height: var(--control-h-sm);
    margin-bottom: var(--space-2);
    color: var(--action-ghost-fg);
    background: transparent;
    border: none;
    border-radius: var(--radius-md);
    cursor: pointer;
  }
  .collapse:hover {
    background: var(--surface-hover);
  }
  nav {
    display: flex;
    flex-direction: column;
    gap: var(--space-0-5);
  }
  .nav-item {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    height: var(--control-h-lg);
    padding: 0 var(--space-3);
    color: var(--text-secondary);
    text-decoration: none;
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    transition: var(--transition-control);
  }
  .nav-item:hover {
    background: var(--surface-hover);
    color: var(--text-primary);
  }
  .nav-item[aria-current="page"] {
    background: var(--surface-selected);
    color: var(--text-primary);
    font-weight: var(--weight-medium);
  }
</style>
