<script lang="ts">
  // Settings — the design's two-column shell: a 264px nav column matching the agents list, and a
  // content pane with a breadcrumb header. The panes themselves are unchanged; this supplies the
  // chrome around them.
  import { page } from "$app/state";
  import { listAgents, type Agent } from "$lib/agents";
  import { agentsBus } from "$lib/agentsBus.svelte";

  let { children } = $props();

  // Title + blurb live here rather than in each pane, so the breadcrumb, the nav label and the
  // pane heading can never drift apart.
  const items = [
    {
      href: "/settings/providers",
      label: "Model providers",
      blurb: "Connect the providers your agents draw models from. Only enabled models appear in an agent's model list.",
    },
    {
      href: "/settings/connections",
      label: "Data connections",
      blurb: "Accounts an agent can read from or act on. A skill's scope decides what it may do with one at run time.",
    },
    {
      href: "/settings/tools",
      label: "Tools",
      blurb:
        "MCP servers your agents can call — a remote server or one you deploy yourself. Attach a tool to an agent to grant specific operations.",
    },
  ];

  const current = $derived(items.find((i) => page.url.pathname.startsWith(i.href)));

  // The design puts a way back to an in-progress draft in this column, so a detour into Settings
  // (to connect a provider, say) doesn't lose track of the agent you were editing.
  let unpublished = $state<Agent[]>([]);
  $effect(() => {
    void agentsBus.rev; // re-fetch when an agent is published/edited elsewhere (else the banner goes stale)
    void listAgents().then((r) => {
      if (r.ok) unpublished = r.value.filter((a) => a.dirty);
    });
  });
</script>

<aside class="column">
  <header>
    <h2 class="title">Settings</h2>
  </header>
  <nav>
    {#each items as item (item.href)}
      <a href={item.href} aria-current={page.url.pathname.startsWith(item.href) ? "page" : undefined}>{item.label}</a>
    {/each}
  </nav>
  {#if unpublished.length > 0}
    <a class="draft-note" href="/agents/{unpublished[0].id}">
      <span class="dot" aria-hidden="true"></span>
      <span>
        {unpublished.length === 1
          ? `${unpublished[0].name} has unpublished changes`
          : `${unpublished.length} agents have unpublished changes`}
      </span>
    </a>
  {/if}
</aside>

<main class="pane">
  <header class="crumbs">
    <span class="crumb">Settings</span>
    <span class="crumb sep">/</span>
    <span class="crumb here">{current?.label ?? ""}</span>
  </header>
  <div class="scroll">
    <div class="inner">
      {#if current}
        <div class="pane-head">
          <h2>{current.label}</h2>
          <p class="blurb">{current.blurb}</p>
        </div>
      {/if}
      {@render children()}
    </div>
  </div>
</main>

<style>
  .column {
    width: 264px;
    flex: none;
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-right: 1px solid var(--border-hairline);
    background: var(--bg-sunken);
  }
  .column > header {
    flex: none;
    height: 48px;
    display: flex;
    align-items: center;
    padding: 0 var(--space-4);
    border-bottom: 1px solid var(--border-hairline);
  }
  .title {
    margin: 0;
    font-size: var(--text-base);
    font-weight: var(--weight-medium);
    letter-spacing: -0.008em;
  }
  nav {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--space-2-5);
    min-height: 0;
    overflow-y: auto;
  }
  nav a {
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-md);
    color: var(--text-secondary);
    text-decoration: none;
    font-size: var(--text-sm);
    transition: var(--transition-control);
  }
  nav a:hover {
    background: var(--surface-hover);
    color: var(--text-primary);
  }
  nav a[aria-current="page"] {
    background: var(--surface-selected);
    color: var(--text-primary);
    font-weight: var(--weight-medium);
  }
  nav a:focus-visible {
    outline: none;
    box-shadow: var(--focus-ring);
  }
  .draft-note {
    flex: none;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    border-top: 1px solid var(--border-hairline);
    color: var(--text-secondary);
    text-decoration: none;
    font-size: var(--text-xs);
    line-height: var(--lh-xs);
  }
  .draft-note:hover {
    background: var(--surface-hover);
    color: var(--text-primary);
  }
  .draft-note:focus-visible {
    outline: none;
    box-shadow: var(--focus-ring);
  }
  .dot {
    width: 6px;
    height: 6px;
    flex: none;
    border-radius: var(--radius-full);
    background: var(--caution-500);
  }
  .pane {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .crumbs {
    flex: none;
    height: 48px;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 0 var(--space-4);
    border-bottom: 1px solid var(--border-hairline);
    background: var(--surface-card);
  }
  .crumb {
    font-size: var(--text-sm);
    color: var(--text-tertiary);
  }
  .crumb.here {
    color: var(--text-primary);
    font-weight: var(--weight-medium);
    letter-spacing: -0.004em;
  }
  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: var(--space-6) var(--space-6) var(--space-16);
  }
  .inner {
    max-width: 720px;
  }
  .pane-head {
    display: flex;
    flex-direction: column;
    gap: var(--space-1-5);
    margin: 0 0 var(--space-5);
  }
  h2 {
    margin: 0;
    font-size: var(--text-xl);
    line-height: var(--lh-xl);
    font-weight: var(--weight-medium);
    letter-spacing: var(--tracking-heading);
    color: var(--text-primary);
  }
  .blurb {
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--lh-sm);
    color: var(--text-secondary);
    text-wrap: pretty;
  }
</style>
