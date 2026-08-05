<script lang="ts">
  import { goto } from "$app/navigation";
  import { login } from "$lib/auth";

  let email = $state("");
  let password = $state("");
  let remember = $state(true);
  let error = $state("");
  let busy = $state(false);

  async function onSubmit(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    error = "";
    const result = await login(email, password);
    busy = false;
    if (result === "ok") {
      await goto("/agents");
    } else if (result === "error") {
      error = "Can't reach the control plane. Check it's running and try again.";
    } else {
      error = "Email or password is incorrect.";
    }
  }
</script>

<main>
  <!-- Sign-in form (left). The brand panel (right) collapses away below 900px. -->
  <section class="pane form-pane">
    <div class="form-wrap">
      <div class="brandmark">
        <span class="logo" aria-hidden="true">T</span>
        <span class="wordmark">Turanga</span>
      </div>

      <form class="form" onsubmit={onSubmit} aria-describedby={error ? "login-error" : undefined}>
        <div class="head">
          <h1>Sign in</h1>
          <p class="sub">Use your work account. Agents keep running while you are signed out.</p>
        </div>

        <div class="field">
          <label class="label" for="login-email">Work email</label>
          <input id="login-email" type="email" bind:value={email} placeholder="you@company.com" autocomplete="username" required />
        </div>

        <div class="field">
          <div class="label-row">
            <label class="label" for="login-password">Password</label>
            <a class="forgot" href="/login" onclick={(e) => e.preventDefault()} aria-disabled="true" title="Password reset is coming later">Forgot?</a>
          </div>
          <input id="login-password" type="password" bind:value={password} placeholder="••••••••••" autocomplete="current-password" required />
        </div>

        <label class="remember">
          <input type="checkbox" bind:checked={remember} />
          <span>Keep me signed in for 30 days</span>
        </label>

        {#if error}
          <p class="error" id="login-error" role="alert">{error}</p>
        {/if}

        <button type="submit" class="signin" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>

        <div class="divider" aria-hidden="true"><span>OR</span></div>

        <button type="button" class="sso" disabled aria-disabled="true" title="Single sign-on is coming later">
          <svg class="lock" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
          </svg>
          Continue with SSO
        </button>

        <p class="foot">No account? <a class="req" href="/login" onclick={(e) => e.preventDefault()}>Request access</a> from your workspace admin.</p>
      </form>
    </div>
  </section>

  <!-- Brand panel (right). Decorative — pure CSS aubergine field, base hue #69366E. -->
  <aside class="pane brand-pane" aria-hidden="true">
    <div class="brand-content">
      <span class="eyebrow">Turanga Platform</span>
      <p class="pitch">Agents that do the work, with every call they make on the record.</p>
      <p class="status"><span class="dot"></span> All regions operational</p>
    </div>
  </aside>
</main>

<style>
  main {
    min-height: 100vh;
    display: grid;
    grid-template-columns: 1fr 1fr;
    background: var(--bg-canvas);
  }
  .pane {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }

  /* ── Form pane ─────────────────────────────────────────────── */
  .form-pane {
    justify-content: center;
    padding: var(--space-8);
  }
  .form-wrap {
    width: 100%;
    max-width: 400px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-10);
  }
  .brandmark {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2-5);
  }
  .logo {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    background: var(--ink-900);
    color: var(--ink-25);
    border-radius: var(--radius-md);
    font-size: var(--text-base);
    font-weight: var(--weight-semibold);
    letter-spacing: 0;
  }
  .wordmark {
    font-size: var(--text-lg);
    font-weight: var(--weight-medium);
    letter-spacing: var(--tracking-heading);
    color: var(--text-primary);
  }
  .form {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
  .head {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-bottom: var(--space-2);
  }
  h1 {
    margin: 0;
    font-size: var(--text-3xl);
    line-height: var(--lh-3xl);
    font-weight: var(--weight-semibold);
    letter-spacing: var(--tracking-heading);
    color: var(--text-primary);
  }
  .sub {
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--lh-sm);
    color: var(--text-secondary);
    max-width: 34ch;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1-5);
  }
  .label {
    font-size: var(--text-xs);
    color: var(--text-secondary);
  }
  .label-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }
  .forgot {
    font-size: var(--text-xs);
    color: var(--text-link);
    text-decoration: none;
  }
  .forgot:hover {
    text-decoration: underline;
  }
  input[type="email"],
  input[type="password"] {
    height: var(--control-h-lg);
    padding: 0 var(--space-3);
    font-size: var(--text-base);
    color: var(--text-primary);
    background: var(--surface-card);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
  }
  input::placeholder {
    color: var(--text-tertiary);
  }
  input[type="email"]:focus-visible,
  input[type="password"]:focus-visible {
    outline: none;
    border-color: var(--border-focus);
    box-shadow: var(--focus-ring);
  }
  .remember {
    display: flex;
    align-items: center;
    gap: var(--space-2-5);
    font-size: var(--text-sm);
    color: var(--text-secondary);
    cursor: pointer;
    margin-top: var(--space-1);
  }
  .remember input {
    width: 17px;
    height: 17px;
    flex: none;
    accent-color: var(--signal-500);
    cursor: pointer;
  }
  .remember input:focus-visible {
    outline: none;
    box-shadow: var(--focus-ring);
  }
  .error {
    margin: 0;
    color: var(--critical-500);
    font-size: var(--text-sm);
  }
  .signin {
    height: var(--control-h-lg);
    margin-top: var(--space-2);
    background: var(--action-primary-bg);
    color: var(--action-primary-fg);
    border: none;
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    cursor: pointer;
    transition: background var(--duration-fast) var(--ease-standard);
  }
  .signin:hover:not(:disabled) {
    background: var(--action-primary-bg-hover);
  }
  .signin:focus-visible {
    outline: none;
    box-shadow: var(--focus-ring);
  }
  .signin:disabled {
    color: var(--text-disabled);
    cursor: default;
  }
  .divider {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    color: var(--text-tertiary);
    font-size: var(--text-2xs);
    letter-spacing: 0.12em;
  }
  .divider::before,
  .divider::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--border-subtle);
  }
  .sso {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    height: var(--control-h-lg);
    background: var(--surface-card);
    color: var(--text-primary);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    cursor: not-allowed;
  }
  .sso:disabled {
    color: var(--text-tertiary);
  }
  .lock {
    flex: none;
  }
  .foot {
    margin: var(--space-2) 0 0;
    font-size: var(--text-xs);
    color: var(--text-tertiary);
    text-align: center;
  }
  .req {
    color: var(--text-link);
    text-decoration: none;
  }
  .req:hover {
    text-decoration: underline;
  }

  /* ── Brand pane (decorative aubergine field, base hue #69366E) ─── */
  .brand-pane {
    position: relative;
    justify-content: flex-end;
    overflow: hidden;
    background:
      radial-gradient(120% 90% at 82% 18%, oklch(0.42 0.11 330 / 0.55), transparent 60%),
      radial-gradient(80% 70% at 12% 8%, oklch(1 0 0 / 0.10), transparent 55%),
      linear-gradient(150deg, #7a3d7f 0%, #69366e 42%, #3f2247 100%);
  }
  /* A soft geometric echo of the source art, kept quiet in the bottom-left. */
  .brand-pane::before {
    content: "";
    position: absolute;
    inset: 0;
    background:
      radial-gradient(closest-side at 78% 42%, oklch(1 0 0 / 0.12), transparent 70%),
      conic-gradient(from 210deg at 70% 40%, oklch(1 0 0 / 0.06), transparent 30% 70%, oklch(1 0 0 / 0.05));
    mix-blend-mode: screen;
    pointer-events: none;
  }
  .brand-content {
    position: relative;
    padding: var(--space-12);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    max-width: 32rem;
  }
  .eyebrow {
    font-size: var(--text-2xs);
    text-transform: uppercase;
    letter-spacing: 0.18em;
    color: oklch(1 0 0 / 0.62);
  }
  .pitch {
    margin: 0;
    max-width: 22ch;
    font-size: var(--text-3xl);
    line-height: var(--lh-3xl);
    font-weight: var(--weight-medium);
    letter-spacing: var(--tracking-heading);
    color: oklch(1 0 0 / 0.96);
  }
  .status {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    margin: var(--space-2) 0 0;
    font-size: var(--text-sm);
    color: oklch(1 0 0 / 0.78);
  }
  .status .dot {
    width: 7px;
    height: 7px;
    border-radius: var(--radius-full);
    background: var(--positive-500);
    box-shadow: 0 0 0 3px oklch(0.52 0.095 152 / 0.25);
  }

  /* ── Responsive: drop the brand pane on narrow viewports ──────── */
  @media (max-width: 900px) {
    main {
      grid-template-columns: 1fr;
    }
    .brand-pane {
      display: none;
    }
  }
</style>
