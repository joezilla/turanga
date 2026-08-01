<script lang="ts">
  import { page } from "$app/state";
  let { children } = $props();
  const items = [
    { href: "/settings/providers", label: "Model providers" },
    { href: "/settings/connections", label: "Data connections" },
    { href: "/settings/profile", label: "Profile" },
  ];
</script>

<div class="settings">
  <nav class="subnav">
    {#each items as item (item.href)}
      <a href={item.href} aria-current={page.url.pathname.startsWith(item.href) ? "page" : undefined}>{item.label}</a>
    {/each}
  </nav>
  <section class="content">{@render children()}</section>
</div>

<style>
  .settings {
    display: flex;
    gap: var(--space-8);
    align-items: flex-start;
  }
  .subnav {
    flex: 0 0 200px;
    display: flex;
    flex-direction: column;
    gap: var(--space-0-5);
  }
  .subnav a {
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-md);
    color: var(--text-secondary);
    text-decoration: none;
    font-size: var(--text-sm);
  }
  .subnav a:hover {
    background: var(--surface-hover);
    color: var(--text-primary);
  }
  .subnav a[aria-current="page"] {
    background: var(--surface-selected);
    color: var(--text-primary);
    font-weight: var(--weight-medium);
  }
  .content {
    flex: 1 1 auto;
    min-width: 0;
  }
</style>
