<script lang="ts">
  // App shell (authenticated area). Nests under the root layout (global tokens/CSS) —
  // do not re-import global styles here. Login (Story 1.4) lives outside this group.
  import Sidebar from "$lib/components/Sidebar.svelte";
  import Topbar from "$lib/components/Topbar.svelte";

  let { children } = $props();
  let collapsed = $state(false);

  $effect(() => {
    collapsed = localStorage.getItem("sidebar-collapsed") === "1";
  });

  function toggleSidebar() {
    collapsed = !collapsed;
    try {
      localStorage.setItem("sidebar-collapsed", collapsed ? "1" : "0");
    } catch {
      /* storage unavailable — still toggles for this session */
    }
  }
</script>

<div class="shell">
  <Sidebar {collapsed} onToggle={toggleSidebar} />
  <div class="main">
    <Topbar />
    <main class="content">
      <div class="content-inner">
        {@render children()}
      </div>
    </main>
  </div>
</div>

<style>
  .shell {
    display: flex;
    min-height: 100vh;
  }
  .main {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .content {
    flex: 1 1 auto;
    overflow-y: auto;
    padding: var(--space-6) var(--space-8);
  }
  .content-inner {
    max-width: var(--content-max);
    margin: 0 auto;
  }
</style>
