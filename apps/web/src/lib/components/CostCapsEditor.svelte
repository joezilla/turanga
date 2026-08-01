<script lang="ts">
  // Cost caps section (Story 3.5). Two mono money inputs (per-run, per-day). Edits convert
  // dollars → integer minor units; an empty field clears that cap; an invalid amount shows an
  // inline error and is not persisted. Enforcement (LiteLLM 429s) + the live meter are Epic 4.
  import type { CostCap, Money } from "$lib/agents";
  import { parseDollarsToMinor, formatMinor, CURRENCY } from "$lib/money";

  let { value, onchange }: { value: CostCap; onchange: (caps: CostCap) => void } = $props();

  const fmt = (m: { minor: number } | null) => (m ? formatMinor(m.minor) : "");

  // Local text state for the two inputs, seeded from the persisted caps then synced by the
  // $effect below only when the *persisted* side actually changes (external load/reload) — not
  // on our own keystrokes.
  // svelte-ignore state_referenced_locally
  let perRunText = $state(fmt(value.perRun));
  // svelte-ignore state_referenced_locally
  let perDayText = $state(fmt(value.perDay));
  let perRunError = $state("");
  let perDayError = $state("");
  // Last persisted minor units we adopted, so we only re-seed on a genuine external change.
  // svelte-ignore state_referenced_locally
  let lastPerRun = $state<number | null>(value.perRun?.minor ?? null);
  // svelte-ignore state_referenced_locally
  let lastPerDay = $state<number | null>(value.perDay?.minor ?? null);

  $effect(() => {
    const active = (document.activeElement as HTMLElement | null)?.dataset?.cap;
    const nextRun = value.perRun?.minor ?? null;
    if (nextRun !== lastPerRun) {
      lastPerRun = nextRun;
      if (active !== "perRun") {
        // don't reformat the field being typed in
        perRunText = fmt(value.perRun);
        perRunError = ""; // a fresh persisted value clears any stale field error
      }
    }
    const nextDay = value.perDay?.minor ?? null;
    if (nextDay !== lastPerDay) {
      lastPerDay = nextDay;
      if (active !== "perDay") {
        perDayText = fmt(value.perDay);
        perDayError = "";
      }
    }
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
        aria-describedby={perRunError ? "per-run-err" : undefined}
        value={perRunText}
        oninput={(e) => edit("perRun", (e.currentTarget as HTMLInputElement).value)}
      />
    </span>
    {#if perRunError}<span id="per-run-err" class="err" role="alert">{perRunError}</span>{/if}
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
        aria-describedby={perDayError ? "per-day-err" : undefined}
        value={perDayText}
        oninput={(e) => edit("perDay", (e.currentTarget as HTMLInputElement).value)}
      />
    </span>
    {#if perDayError}<span id="per-day-err" class="err" role="alert">{perDayError}</span>{/if}
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
