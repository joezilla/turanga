<script lang="ts">
  // App shell (authenticated area). Nests under the root layout (global tokens/CSS) —
  // do not re-import global styles here. Login (Story 1.4) lives outside this group.
  // Client-side auth guard: control-api /auth/me → redirect to /login on 401. The
  // control-api enforces auth on every endpoint, so this guard is UX, not security.
  import { goto } from "$app/navigation";
  import Sidebar from "$lib/components/Sidebar.svelte";
  import Topbar from "$lib/components/Topbar.svelte";
  import { me } from "$lib/auth";

  let { children } = $props();
  let collapsed = $state(false);
  let checked = $state(false);
  let email = $state("");

  $effect(() => {
    collapsed = localStorage.getItem("sidebar-collapsed") === "1";
    me().then((user) => {
      if (!user) {
        goto("/login");
      } else {
        email = user.email;
        checked = true;
      }
    });
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

{#if checked}
  <div class="shell">
    <Sidebar {collapsed} onToggle={toggleSidebar} />
    <div class="main">
      <Topbar {email} />
      <main class="content">
        <div class="content-inner">
          {@render children()}
        </div>
      </main>
    </div>
  </div>
{/if}

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
