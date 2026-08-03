<script lang="ts">
  // Shared run-transcript rows (Story 5.3): the control-channel messages the live test pane and the
  // run-history review both render — `turn` (role + text), `refusal` (caution dot + kind label +
  // detail — "the guard, made legible", NFR-4/UX-DR23), and optionally per-call `metrics` rows.
  // `done` renders nothing (the terminal outcome is shown by the caller's RunStatusDot).
  import { Circle } from "@lucide/svelte";
  import { formatMicros } from "$lib/money";
  import type { RunMessage } from "$lib/runs";

  // showMetrics: the review renders per-call metrics inline (observability); the test pane keeps
  // metrics in its own resolution summary (last-metrics), so it passes false — behavior unchanged.
  let { transcript, showMetrics = false }: { transcript: RunMessage[]; showMetrics?: boolean } = $props();

  const fmtNum = (n: number) => n.toLocaleString("en-US");
  const refusalLabel = (kind: "egress" | "permission") => (kind === "egress" ? "Blocked egress" : "Permission denied");
</script>

{#each transcript as msg, i (i)}
  {#if msg.type === "turn"}
    <div class="turn">
      <span class="turn-role">{msg.role}</span>
      <p class="turn-text">{msg.text}</p>
    </div>
  {:else if msg.type === "refusal"}
    <!-- A guardrail stopped an op — reads caution (dot + kind + full reason), never a red banner. -->
    <div class="refusal">
      <Circle size={7} fill="var(--state-killed)" color="var(--state-killed)" aria-hidden="true" />
      <span class="refusal-kind">{refusalLabel(msg.kind)}</span>
      <span>{msg.detail}</span>
    </div>
  {:else if msg.type === "metrics" && showMetrics}
    <p class="metrics mono-num">{fmtNum(msg.latencyMs)} ms · {fmtNum(msg.tokens)} tokens · {formatMicros(msg.costMicros)}</p>
  {/if}
{/each}

<style>
  .turn {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .turn-role {
    font-size: 11px;
    letter-spacing: var(--tracking-micro);
    text-transform: uppercase;
    color: var(--text-tertiary);
  }
  .turn-text {
    margin: 0;
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    color: var(--text-primary);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .refusal {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    margin: 0;
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }
  /* The refusal kind ("Blocked egress" / "Permission denied") — states what the guard stopped. */
  .refusal-kind {
    color: var(--state-killed);
    font-weight: var(--weight-medium);
    white-space: nowrap;
  }
  .metrics {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }
</style>
