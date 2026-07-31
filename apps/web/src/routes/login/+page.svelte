<script lang="ts">
  import { goto } from "$app/navigation";
  import { login } from "$lib/auth";

  let email = $state("");
  let password = $state("");
  let error = $state("");
  let busy = $state(false);

  async function onSubmit(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    error = "";
    const ok = await login(email, password);
    busy = false;
    if (ok) {
      await goto("/agents");
    } else {
      error = "Email or password is incorrect.";
    }
  }
</script>

<main>
  <form class="card" onsubmit={onSubmit} aria-describedby={error ? "login-error" : undefined}>
    <h1>turanga</h1>

    <label class="field">
      <span>Email</span>
      <input type="email" bind:value={email} autocomplete="username" required />
    </label>

    <label class="field">
      <span>Password</span>
      <input type="password" bind:value={password} autocomplete="current-password" required />
    </label>

    {#if error}
      <p class="error" id="login-error" role="alert">{error}</p>
    {/if}

    <button type="submit" class="signin" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>

    <div class="sso-slot" aria-hidden="true">
      <span>Single sign-on coming later</span>
    </div>
  </form>
</main>

<style>
  main {
    min-height: 100vh;
    display: grid;
    place-items: center;
    background: var(--bg-canvas);
    padding: var(--space-8);
  }
  .card {
    width: 400px;
    max-width: 100%;
    background: var(--surface-card);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-sm);
    padding: var(--space-8);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
  h1 {
    margin: 0 0 var(--space-2);
    font-size: var(--text-xl);
    font-weight: var(--weight-medium);
    letter-spacing: var(--tracking-heading);
    color: var(--text-primary);
    text-align: center;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    font-size: var(--text-xs);
    color: var(--text-secondary);
  }
  input {
    height: var(--control-h-lg);
    padding: 0 var(--space-3);
    font-size: var(--text-base);
    color: var(--text-primary);
    background: var(--surface-card);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
  }
  .error {
    margin: 0;
    color: var(--critical-500);
    font-size: var(--text-sm);
  }
  .signin {
    height: var(--control-h-lg);
    background: var(--action-primary-bg);
    color: var(--action-primary-fg);
    border: none;
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    cursor: pointer;
  }
  .signin:disabled {
    color: var(--text-disabled);
    cursor: default;
  }
  .sso-slot {
    border-top: 1px solid var(--border-hairline);
    padding-top: var(--space-4);
    text-align: center;
    color: var(--text-tertiary);
    font-size: var(--text-2xs);
  }
</style>
