<script lang="ts">
  // App shell (authenticated area). Nests under the root layout (global tokens/CSS) —
  // do not re-import global styles here. Login (Story 1.4) lives outside this group.
  // Client-side auth guard: control-api /auth/me → redirect to /login only on a real 401.
  // NOTE: there is no server-side auth middleware yet — protected data endpoints in later
  // epics must add their own session check; this guard is UX, not a security boundary.
  import { goto } from "$app/navigation";
  import Sidebar from "$lib/components/Sidebar.svelte";
  import Topbar from "$lib/components/Topbar.svelte";
  import { me } from "$lib/auth";

  let { children } = $props();
  let collapsed = $state(false);
  let checked = $state(false);
  let unreachable = $state(false);
  let email = $state("");

  async function checkAuth() {
    unreachable = false;
    const result = await me();
    if (result.status === "authed") {
      email = result.email;
      checked = true;
    } else if (result.status === "unauthed") {
      goto("/login");
    } else {
      // Transient outage — do NOT log the user out; show a notice and retry.
      unreachable = true;
      setTimeout(checkAuth, 2000);
    }
  }

  $effect(() => {
    try {
      collapsed = localStorage.getItem("sidebar-collapsed") === "1";
    } catch {
      /* storage blocked (e.g. private mode) — default to expanded */
    }
    checkAuth();
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
{:else if unreachable}
  <p class="notice" role="status">Can't reach the control plane. Reconnecting…</p>
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
  .notice {
    min-height: 100vh;
    display: grid;
    place-items: center;
    margin: 0;
    color: var(--text-tertiary);
    font-size: var(--text-sm);
  }
</style>
