<script lang="ts">
  // Account dialog — replaces the /settings/profile stub. Profile is read-only for now (the
  // control-api stores only an email; there is no display-name field to write to), so the one
  // real action here is the password change, which POSTs /auth/password.
  import { X } from "@lucide/svelte";
  import { changePassword, logout } from "$lib/auth";
  import { goto } from "$app/navigation";

  let { email = "", onClose }: { email?: string; onClose: () => void } = $props();

  let currentPassword = $state("");
  let newPassword = $state("");
  let confirmPassword = $state("");
  let busy = $state(false);
  let note = $state("");
  let noteKind = $state<"idle" | "error" | "done">("idle");

  let dialogEl = $state<HTMLDivElement | null>(null);

  // Mirrors the control-api's MIN_PASSWORD_LEN so the mismatch is stated before the round-trip.
  const MIN_LEN = 12;
  const canSubmit = $derived(
    !busy && currentPassword.length > 0 && newPassword.length >= MIN_LEN && newPassword === confirmPassword && newPassword !== currentPassword,
  );
  const hint = $derived.by(() => {
    if (!newPassword) return `At least ${MIN_LEN} characters.`;
    if (newPassword.length < MIN_LEN) return `That is ${newPassword.length} characters — ${MIN_LEN} is the minimum.`;
    if (confirmPassword && newPassword !== confirmPassword) return "The two new passwords don't match.";
    if (newPassword === currentPassword) return "The new password must be different from your current one.";
    return `At least ${MIN_LEN} characters.`;
  });

  // After a successful change the "done" note lingers; clear it the moment the user edits a field
  // again, so the length/mismatch hint isn't hidden behind the stale success message.
  function clearDoneNote() {
    if (noteKind === "done") {
      note = "";
      noteKind = "idle";
    }
  }

  async function submit() {
    if (!canSubmit) return;
    busy = true;
    note = "";
    noteKind = "idle";
    const r = await changePassword(currentPassword, newPassword);
    busy = false;
    if (r.ok) {
      noteKind = "done";
      note = "Password changed. Other sessions were signed out.";
      currentPassword = newPassword = confirmPassword = "";
    } else {
      noteKind = "error";
      note = r.error;
    }
  }

  async function signOut() {
    await logout();
    await goto("/login");
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    }
  }

  $effect(() => {
    dialogEl?.focus();
  });
</script>

<svelte:window onkeydown={onKeydown} />

<div class="scrim">
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="dialog" role="dialog" aria-modal="true" aria-label="Account" tabindex={-1} bind:this={dialogEl}>
    <header>
      <span class="title">Account</span>
      <button type="button" class="icon" onclick={onClose} aria-label="Close">
        <X size={15} color="currentColor" />
      </button>
    </header>

    <div class="body">
      <section>
        <div class="micro">Profile</div>
        <label class="field">
          <span>Email</span>
          <input type="text" value={email} readonly />
          <span class="hint">The control plane holds one account. Email can't be changed here.</span>
        </label>
      </section>

      <section class="divider">
        <div class="micro">Password</div>
        <label class="field">
          <span>Current password</span>
          <input type="password" bind:value={currentPassword} autocomplete="current-password" oninput={clearDoneNote} />
        </label>
        <label class="field">
          <span>New password</span>
          <input type="password" bind:value={newPassword} autocomplete="new-password" oninput={clearDoneNote} />
        </label>
        <label class="field">
          <span>Confirm new password</span>
          <input type="password" bind:value={confirmPassword} autocomplete="new-password" oninput={clearDoneNote} />
        </label>
        <p class="note" class:error={noteKind === "error"} class:done={noteKind === "done"} aria-live="polite">
          {note || hint}
        </p>
        <button type="button" class="primary" onclick={submit} disabled={!canSubmit}>Update password</button>
      </section>
    </div>

    <footer>
      <button type="button" class="danger-ghost" onclick={signOut}>Sign out</button>
      <button type="button" class="ghost" onclick={onClose}>Close</button>
    </footer>
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-8);
    /* Scrim is the deepest ink at 55% (DESIGN.md#Elevation — transparency is for scrim only).
       color-mix keeps it a token rather than the design file's literal oklch. */
    background: color-mix(in oklab, var(--ink-1000) 55%, transparent);
  }
  .dialog {
    width: 480px;
    max-width: 100%;
    max-height: 100%;
    display: flex;
    flex-direction: column;
    background: var(--surface-card);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-xl);
    box-shadow: var(--shadow-lg);
    overflow: hidden;
  }
  .dialog:focus-visible {
    outline: none;
  }
  header {
    flex: none;
    height: 48px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 var(--space-3) 0 var(--space-5);
    border-bottom: 1px solid var(--border-hairline);
  }
  .title {
    font-size: var(--text-base);
    font-weight: var(--weight-medium);
    letter-spacing: -0.008em;
  }
  .body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
  }
  section {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .divider {
    padding-top: var(--space-1);
    border-top: 1px solid var(--border-hairline);
  }
  .micro {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: var(--tracking-micro);
    text-transform: uppercase;
    color: var(--text-tertiary);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1-5);
  }
  .field > span {
    font-size: var(--text-xs);
    color: var(--text-secondary);
  }
  .field input {
    height: var(--control-h-md);
    padding: 0 var(--control-pad-x);
    font-size: var(--text-sm);
    color: var(--text-primary);
    background: var(--surface-card);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
  }
  .field input:read-only {
    color: var(--text-secondary);
    background: var(--surface-inset);
  }
  .field input:focus-visible {
    outline: none;
    border-color: var(--border-focus);
    box-shadow: var(--focus-ring);
  }
  .hint {
    font-size: var(--text-2xs);
    color: var(--text-tertiary);
  }
  .note {
    margin: 0;
    font-size: var(--text-xs);
    line-height: var(--lh-xs);
    color: var(--text-tertiary);
  }
  .note.error {
    color: var(--critical-500);
  }
  .note.done {
    color: var(--text-secondary);
  }
  footer {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-5);
    border-top: 1px solid var(--border-hairline);
    background: var(--surface-raised);
  }
  .primary,
  .ghost,
  .danger-ghost,
  .icon {
    cursor: pointer;
    font-size: var(--text-xs);
    font-weight: var(--weight-medium);
    border-radius: var(--radius-md);
    transition: var(--transition-control);
  }
  .primary {
    align-self: flex-start;
    height: var(--control-h-md);
    padding: 0 var(--space-3);
    color: var(--action-primary-fg);
    background: var(--action-primary-bg);
    border: 1px solid transparent;
  }
  .primary:hover:not(:disabled) {
    background: var(--action-primary-bg-hover);
  }
  .primary:disabled {
    color: var(--text-disabled);
    background: var(--surface-inset);
    cursor: not-allowed;
  }
  .ghost,
  .danger-ghost {
    height: 30px;
    padding: 0 var(--space-3);
    color: var(--action-ghost-fg);
    background: transparent;
    border: 1px solid transparent;
  }
  .ghost:hover {
    color: var(--text-primary);
    background: var(--surface-hover);
  }
  .danger-ghost:hover {
    color: var(--critical-500);
    background: var(--surface-hover);
  }
  .icon {
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-tertiary);
    background: transparent;
    border: 1px solid transparent;
  }
  .icon:hover {
    color: var(--text-primary);
    background: var(--surface-hover);
  }
  .primary:focus-visible,
  .ghost:focus-visible,
  .danger-ghost:focus-visible,
  .icon:focus-visible {
    outline: none;
    box-shadow: var(--focus-ring);
  }
</style>
