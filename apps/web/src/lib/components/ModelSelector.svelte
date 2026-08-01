<script lang="ts">
  // Model selection (Story 3.2). Grouped by provider; renders `provider / model-id` in mono.
  // A provider with no usable connection is disabled with an inline "Connect in Settings"
  // link. Provider status is shown as dot + word (never colour-only) in a small legend —
  // a native <select> can't render per-option dots or in-option links (documented deviation).
  import { Circle } from "@lucide/svelte";
  import type { Provider, ProviderKind } from "$lib/connections";

  let { providers, value, onchange }: { providers: Provider[]; value: string | null; onchange: (model: string | null) => void } = $props();

  const KINDS: { kind: ProviderKind; label: string }[] = [
    { kind: "openai", label: "OpenAI" },
    { kind: "anthropic", label: "Anthropic" },
    { kind: "openai-compatible", label: "OpenAI-compatible" },
  ];

  // Per known kind: the unique models available from *connected* providers of that kind.
  const groups = $derived(
    KINDS.map(({ kind, label }) => {
      const connected = providers.filter((p) => p.provider === kind && p.status === "connected");
      const models = [...new Set(connected.flatMap((p) => p.models))];
      return { kind, label, connected: connected.length > 0 && models.length > 0, models };
    }),
  );

  const anyUnconfigured = $derived(groups.some((g) => !g.connected));
  const options = $derived(groups.flatMap((g) => (g.connected ? g.models.map((m) => `${g.kind}/${m}`) : [])));
  // If a previously-selected model's provider is gone, keep it visible as the current value.
  const orphanValue = $derived(value && !options.includes(value) ? value : null);

  function dotColor(connected: boolean): string {
    return connected ? "var(--state-succeeded)" : "var(--text-tertiary)";
  }
</script>

<div class="model-selector">
  <ul class="legend">
    {#each groups as g}
      <li>
        <Circle size={7} fill={dotColor(g.connected)} color={dotColor(g.connected)} aria-hidden="true" />
        <span>{g.label} · {g.connected ? "connected" : "not connected"}</span>
      </li>
    {/each}
  </ul>

  <select
    class="select"
    aria-label="Model"
    value={value ?? ""}
    onchange={(e) => onchange((e.currentTarget as HTMLSelectElement).value || null)}
  >
    <option value="">— Select a model —</option>
    {#if orphanValue}
      <option value={orphanValue}>{orphanValue.replace("/", " / ")}</option>
    {/if}
    {#each groups as g}
      {#if g.connected}
        <optgroup label="{g.label} · connected">
          {#each g.models as m}
            <option value="{g.kind}/{m}">{g.kind} / {m}</option>
          {/each}
        </optgroup>
      {:else}
        <optgroup label="{g.label} · not connected — connect in Settings"></optgroup>
      {/if}
    {/each}
  </select>

  {#if anyUnconfigured}
    <a class="connect" href="/settings/providers">Connect in Settings</a>
  {/if}
</div>

<style>
  .model-selector {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    max-width: 420px;
  }
  .legend {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-4);
  }
  .legend li {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    font-size: var(--text-xs);
    color: var(--text-secondary);
  }
  .select {
    height: var(--control-h-md);
    padding: 0 var(--space-3);
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    font-size: var(--text-sm);
    color: var(--text-primary);
    background: var(--surface-card);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
  }
  .select:focus-visible {
    outline: 2px solid var(--focus-ring);
    outline-offset: 2px;
  }
  .connect {
    font-size: var(--text-sm);
    color: var(--text-link);
    width: fit-content;
  }
</style>
