<script lang="ts">
  // Cost caps section (Story 3.5). Two mono money inputs (per-run, per-day). Edits convert
  // dollars → integer minor units; an empty field clears that cap; an invalid amount shows an
  // inline error and is not persisted. Enforcement (LiteLLM 429s) + the live meter are Epic 4.
  import type { CostCap, Money } from "$lib/agents";
  import { parseDollarsToMinor, formatMinor, CURRENCY } from "$lib/money";

  let { value, onchange }: { value: CostCap; onchange: (caps: CostCap) => void } = $props();

  // Local text state for the two inputs, seeded from the persisted caps then synced by the
  // $effect below (external load/reload).
  // svelte-ignore state_referenced_locally
  let perRunText = $state(value.perRun ? formatMinor(value.perRun.minor) : "");
  // svelte-ignore state_referenced_locally
  let perDayText = $state(value.perDay ? formatMinor(value.perDay.minor) : "");
  let perRunError = $state("");
  let perDayError = $state("");

  // Adopt external changes (load/reload) when the field isn't being edited.
  $effect(() => {
    const el = document.activeElement as HTMLElement | null;
    if (el?.dataset?.cap !== "perRun") perRunText = value.perRun ? formatMinor(value.perRun.minor) : "";
    if (el?.dataset?.cap !== "perDay") perDayText = value.perDay ? formatMinor(value.perDay.minor) : "";
  });

  function edit(which: "perRun" | "perDay", raw: string) {
    if (which === "perRun") perRunText = raw;
    else perDayText = raw;

    const setError = (msg: string) => (which === "perRun" ? (perRunError = msg) : (perDayError = msg));
    const trimmed = raw.trim();

    if (trimmed === "") {
      setError("");
      onchange({ ...value, [which]: null }); // clear this cap
      return;
    }
    const parsed = parseDollarsToMinor(trimmed);
    if (!parsed.ok) {
      setError(parsed.error); // invalid → inline error, do NOT persist
      return;
    }
    setError("");
    const money: Money = { minor: parsed.minor, currency: CURRENCY };
    onchange({ ...value, [which]: money });
  }
</script>

<div class="caps">
  <label class="cap">
    <span class="field-label">Per-run cap</span>
    <span class="input">
      <span class="symbol">$</span>
      <input
        type="text"
        inputmode="decimal"
        data-cap="perRun"
        aria-label="Per-run cap"
        aria-invalid={perRunError ? "true" : undefined}
        value={perRunText}
        oninput={(e) => edit("perRun", (e.currentTarget as HTMLInputElement).value)}
      />
    </span>
    {#if perRunError}<span class="err">{perRunError}</span>{/if}
  </label>

  <label class="cap">
    <span class="field-label">Per-day cap</span>
    <span class="input">
      <span class="symbol">$</span>
      <input
        type="text"
        inputmode="decimal"
        data-cap="perDay"
        aria-label="Per-day cap"
        aria-invalid={perDayError ? "true" : undefined}
        value={perDayText}
        oninput={(e) => edit("perDay", (e.currentTarget as HTMLInputElement).value)}
      />
    </span>
    {#if perDayError}<span class="err">{perDayError}</span>{/if}
  </label>
</div>

<style>
  .caps {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-4);
    max-width: 560px;
  }
  .cap {
    display: flex;
    flex-direction: column;
  }
  .field-label {
    font-size: var(--text-xs);
    color: var(--text-secondary);
    margin-bottom: var(--space-1);
  }
  .input {
    display: inline-flex;
    align-items: center;
    height: var(--control-h-md);
    padding: 0 var(--space-2);
    background: var(--surface-card);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
  }
  .input:focus-within {
    outline: 2px solid var(--focus-ring);
    outline-offset: 2px;
  }
  /* Cap amounts render in mono / tabular-nums (DESIGN.md#Typography). */
  .symbol,
  .input input {
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    font-size: var(--text-sm);
    color: var(--text-primary);
  }
  .symbol {
    color: var(--text-tertiary);
  }
  .input input {
    width: 8ch;
    border: none;
    background: none;
    text-align: right;
  }
  .input input:focus {
    outline: none;
  }
  .err {
    margin-top: var(--space-1);
    font-size: var(--text-xs);
    color: var(--state-failed);
  }
</style>
