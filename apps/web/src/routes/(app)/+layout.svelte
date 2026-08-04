<script lang="ts">
  // App shell (authenticated area). Nests under the root layout (global tokens/CSS) —
  // do not re-import global styles here. Login (Story 1.4) lives outside this group.
  //
  // Layout follows the design's Agent Management spec: a 52px nav rail, then each route
  // group supplies its own list column + content pane. The shell no longer wraps children
  // in a padded, max-width container — the workspace is full-height and each surface owns
  // its own scrolling region.
  //
  // Client-side auth guard: control-api /auth/me.
  //   - Not signed in on arrival → redirect to /login (a cold visit to a bookmarked URL should
  //     land somewhere you can act, not on a panel about a session you never had).
  //   - Signed in, then the session drops → the design's signed-out panel, which says what
  //     happens to running agents. Losing your session mid-work is the case that copy is for.
  // NOTE: there is no server-side auth middleware on every route yet — protected data
  // endpoints add their own session check; this guard is UX, not a security boundary.
  import { goto } from "$app/navigation";
  import NavRail from "$lib/components/NavRail.svelte";
  import AccountModal from "$lib/components/AccountModal.svelte";
  import { me } from "$lib/auth";

  let { children } = $props();
  let checked = $state(false);
  let signedOut = $state(false);
  let unreachable = $state(false);
  let email = $state("");
  let accountOpen = $state(false);
  let wasAuthed = false; // have we ever seen a valid session in this page life?

  async function checkAuth() {
    unreachable = false;
    const result = await me();
    if (result.status === "authed") {
      email = result.email;
      signedOut = false;
      wasAuthed = true;
      checked = true;
    } else if (result.status === "unauthed") {
      if (wasAuthed) signedOut = true; // the session dropped while working
      else goto("/login"); // never had one — send them somewhere they can sign in
      checked = true;
    } else {
      // Transient outage — do NOT log the user out; show a notice and retry.
      unreachable = true;
      setTimeout(checkAuth, 2000);
    }
  }

  $effect(() => {
    checkAuth();
    // Re-verify when the tab comes back: a session that expired while you were elsewhere should
    // say so, rather than letting every subsequent request fail silently.
    const onVisible = () => {
      if (document.visibilityState === "visible" && !signedOut) void checkAuth();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  });
</script>

{#if signedOut}
  <div class="signed-out">
    <div class="so-card">
      <span class="mark" aria-hidden="true">T</span>
      <div class="so-copy">
        <p class="so-title">You are signed out of turanga</p>
        <p class="so-body">
          Running agents keep running. Anything waiting on your approval stays paused until someone signs in.
        </p>
      </div>
      <a class="primary" href="/login">Sign back in</a>
    </div>
  </div>
{:else if checked}
  <div class="shell">
    <NavRail {email} onAccount={() => (accountOpen = true)} />
    {@render children()}
  </div>
  {#if accountOpen}
    <AccountModal {email} onClose={() => (accountOpen = false)} />
  {/if}
{:else if unreachable}
  <p class="notice" role="status">Can't reach the control plane. Reconnecting…</p>
{/if}

<style>
  .shell {
    display: flex;
    height: 100vh;
    overflow: hidden;
    background: var(--bg-canvas);
  }
  .notice {
    min-height: 100vh;
    display: grid;
    place-items: center;
    margin: 0;
    color: var(--text-tertiary);
    font-size: var(--text-sm);
  }
  .signed-out {
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: var(--space-8);
    background: var(--bg-canvas);
  }
  .so-card {
    width: 360px;
    max-width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-4);
    text-align: center;
  }
  .mark {
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-md);
    background: var(--ink-900);
    color: var(--ink-25);
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
    letter-spacing: -0.02em;
  }
  .so-copy {
    display: flex;
    flex-direction: column;
    gap: var(--space-1-5);
  }
  .so-title {
    margin: 0;
    font-size: var(--text-lg);
    font-weight: var(--weight-medium);
    letter-spacing: var(--tracking-heading);
    color: var(--text-primary);
  }
  .so-body {
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--lh-sm);
    color: var(--text-secondary);
    text-wrap: pretty;
  }
  .primary {
    display: inline-flex;
    align-items: center;
    height: var(--control-h-md);
    padding: 0 var(--space-4);
    font-size: var(--text-xs);
    font-weight: var(--weight-medium);
    color: var(--action-primary-fg);
    background: var(--action-primary-bg);
    border-radius: var(--radius-md);
    text-decoration: none;
  }
  .primary:hover {
    background: var(--action-primary-bg-hover);
  }
  .primary:focus-visible {
    outline: none;
    box-shadow: var(--focus-ring);
  }
</style>
