<script lang="ts">
  // Workspace nav rail — the 52px icon column from the design's Agent Management spec
  // (.claude/skills/warm-ink-design/Agent Management.dc.html). Replaces the old Sidebar +
  // Topbar pair: destinations at the top, theme + account at the bottom.
  import { page } from "$app/state";
  import { LayoutGrid, MessageCircle, List, Wrench, Settings, Sun, Moon } from "@lucide/svelte";
  import { toggleTheme, getTheme, type Theme } from "$lib/theme";

  let { email = "", onAccount }: { email?: string; onAccount: () => void } = $props();

  // `disabled` items render but state why. Chat is designed but not built (no published-version
  // surface yet); Runs/Tools have no top-level route — they live under an agent / Settings today.
  const items = [
    { href: "/agents", label: "Agents", icon: LayoutGrid, disabled: false, reason: "" },
    { href: "/chat", label: "Chat", icon: MessageCircle, disabled: true, reason: "Chat is not available yet" },
    { href: "/runs", label: "Runs", icon: List, disabled: true, reason: "Run history lives on each agent for now" },
    { href: "/settings/tools", label: "Tools", icon: Wrench, disabled: false, reason: "" },
    { href: "/settings", label: "Settings", icon: Settings, disabled: false, reason: "" },
  ];

  // /settings/tools would otherwise light up both Tools and Settings — the longest match wins.
  const activeHref = $derived.by(() => {
    const path = page.url.pathname;
    return items
      .filter((i) => !i.disabled && (path === i.href || path.startsWith(i.href + "/")))
      .sort((a, b) => b.href.length - a.href.length)[0]?.href;
  });

  let theme = $state<Theme>("light");
  $effect(() => {
    theme = getTheme();
  });
  function onToggleTheme() {
    toggleTheme();
    theme = getTheme();
  }

  // Two letters from the local part: "jo.toppe@…" → "JT", "amelia@…" → "AM".
  const initials = $derived.by(() => {
    const local = email.split("@")[0] ?? "";
    const parts = local.split(/[._-]+/).filter(Boolean);
    const raw = parts.length > 1 ? parts[0][0] + parts[1][0] : local.slice(0, 2);
    return raw.toUpperCase() || "?";
  });
</script>

<nav class="rail" aria-label="Workspace">
  <span class="mark" aria-hidden="true">T</span>

  {#each items as item (item.href)}
    {#if item.disabled}
      <button type="button" class="item" disabled title={item.reason} aria-label="{item.label} — {item.reason}">
        <item.icon size={16} color="currentColor" />
      </button>
    {:else}
      <a
        class="item"
        href={item.href}
        title={item.label}
        aria-label={item.label}
        aria-current={activeHref === item.href ? "page" : undefined}
      >
        <item.icon size={16} color="currentColor" />
      </a>
    {/if}
  {/each}

  <div class="spacer"></div>

  <button type="button" class="item" onclick={onToggleTheme} title={theme === "dark" ? "Switch to light" : "Switch to dark"} aria-label="Toggle theme">
    {#if theme === "dark"}<Sun size={16} color="currentColor" />{:else}<Moon size={16} color="currentColor" />{/if}
  </button>
  <button type="button" class="avatar" onclick={onAccount} title="Account" aria-label="Account">{initials}</button>
</nav>

<style>
  .rail {
    width: 52px;
    flex: none;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-3) 0;
    border-right: 1px solid var(--border-hairline);
    background: var(--bg-sunken);
  }
  /* No logo exists in this system — the product initial in Instrument Sans stands in. */
  .mark {
    width: 26px;
    height: 26px;
    margin-bottom: var(--space-2-5);
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
  .item {
    width: 30px;
    height: 30px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-tertiary);
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    cursor: pointer;
    transition: var(--transition-control);
  }
  .item:hover:not(:disabled) {
    color: var(--text-primary);
    background: var(--surface-hover);
  }
  .item[aria-current="page"] {
    color: var(--text-primary);
    background: var(--surface-selected);
  }
  .item:disabled {
    color: var(--text-disabled);
    cursor: not-allowed;
  }
  .spacer {
    flex: 1;
  }
  .avatar {
    width: 30px;
    height: 30px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-secondary);
    background: transparent;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    cursor: pointer;
    transition: var(--transition-control);
  }
  .avatar:hover {
    color: var(--text-primary);
    border-color: var(--border-strong);
  }
  .item:focus-visible,
  .avatar:focus-visible {
    outline: none;
    box-shadow: var(--focus-ring);
  }
</style>
