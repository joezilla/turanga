<script lang="ts">
  // Mono instructions editor (Story 3.3). Renders `{vars}` as signal-tinted tokens via the
  // overlay-highlighter technique: a transparent <textarea> (real caret/editing) sits over an
  // aria-hidden mirror <div> with identical metrics that draws the tokens. Typing `{` opens a
  // variable-insert popover. The popover is anchored to the editor (not the caret) — a
  // documented simplification; caret-anchoring is later polish.
  import { tick } from "svelte";
  import { VAR_TOKEN_RE } from "$lib/variables";

  let { value, variableNames, oninput }: { value: string; variableNames: string[]; oninput: (v: string) => void } = $props();

  const MAX_LEN = 20000; // matches control-api's instructions cap — keep local == persisted

  let ta = $state<HTMLTextAreaElement | null>(null);
  let mirror = $state<HTMLDivElement | null>(null);
  // Seeded from `value`, then kept in sync by the $effect below (external load/reload).
  // svelte-ignore state_referenced_locally
  let internal = $state(value);
  let popoverOpen = $state(false);
  let activeIndex = $state(0); // highlighted popover option (keyboard nav)
  let scrollTop = $state(0);
  let scrollLeft = $state(0);

  // Adopt external changes (initial load / reload) without clobbering an in-progress edit.
  $effect(() => {
    if (ta && document.activeElement === ta) return;
    if (internal !== value) internal = value;
  });

  // Split the text into plain + token segments for the mirror. Reset the stateful global regex.
  const segments = $derived.by(() => {
    const out: { text: string; token: boolean }[] = [];
    let last = 0;
    VAR_TOKEN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = VAR_TOKEN_RE.exec(internal)) !== null) {
      if (m.index > last) out.push({ text: internal.slice(last, m.index), token: false });
      out.push({ text: m[0], token: true });
      last = m.index + m[0].length;
    }
    if (last < internal.length) out.push({ text: internal.slice(last), token: false });
    return out;
  });

  function emit() {
    oninput(internal);
  }

  function onInput() {
    if (!ta) return;
    internal = ta.value;
    emit();
    // Open the popover right after a lone `{`; close it on `{{` or once the caret leaves the `{`.
    const caret = ta.selectionStart;
    const prev = internal[caret - 1];
    const prev2 = internal[caret - 2];
    if (prev === "{" && prev2 !== "{") {
      popoverOpen = true;
      activeIndex = 0;
    } else if (prev === "{" && prev2 === "{") {
      popoverOpen = false; // `{{` is an escape, not a trigger
    } else if (popoverOpen && prev !== "{") {
      popoverOpen = false;
    }
  }

  function onScroll() {
    if (!ta) return;
    scrollTop = ta.scrollTop;
    scrollLeft = ta.scrollLeft;
  }

  function onKeydown(e: KeyboardEvent) {
    if (!popoverOpen) return;
    if (e.key === "Escape") {
      e.stopPropagation();
      popoverOpen = false;
      return;
    }
    if (variableNames.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIndex = (activeIndex + 1) % variableNames.length;
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIndex = (activeIndex - 1 + variableNames.length) % variableNames.length;
    } else if (e.key === "Enter") {
      e.preventDefault();
      insertVariable(variableNames[Math.min(activeIndex, variableNames.length - 1)]);
    }
  }

  async function insertVariable(name: string) {
    if (!ta) return;
    const caret = ta.selectionStart;
    // If the caret still sits just after the triggering `{`, complete it; otherwise insert a
    // whole `{name}` (the caret may have moved after the popover opened).
    const onBrace = internal[caret - 1] === "{";
    const insertText = (onBrace ? "" : "{") + name + "}";
    internal = (internal.slice(0, caret) + insertText + internal.slice(caret)).slice(0, MAX_LEN);
    emit();
    popoverOpen = false;
    await tick();
    const pos = Math.min(caret + insertText.length, internal.length);
    ta.focus();
    ta.setSelectionRange(pos, pos);
  }
</script>

<div class="editor">
  <div class="mirror" aria-hidden="true" bind:this={mirror} style="transform: translate(-{scrollLeft}px, -{scrollTop}px)">
    {#each segments as seg}{#if seg.token}<span class="token">{seg.text}</span>{:else}{seg.text}{/if}{/each}<br />
  </div>
  <textarea
    bind:this={ta}
    bind:value={internal}
    aria-label="Instructions"
    spellcheck="false"
    maxlength={MAX_LEN}
    role="combobox"
    aria-expanded={popoverOpen}
    aria-controls="var-insert-popover"
    aria-activedescendant={popoverOpen && variableNames.length ? `var-opt-${Math.min(activeIndex, variableNames.length - 1)}` : undefined}
    oninput={onInput}
    onscroll={onScroll}
    onkeydown={onKeydown}
    onblur={() => (popoverOpen = false)}
  ></textarea>

  {#if popoverOpen}
    <div id="var-insert-popover" class="popover" role="listbox" aria-label="Insert a variable">
      {#if variableNames.length === 0}
        <p class="empty">No variables yet — <a href="#variables-section" onmousedown={(e) => e.preventDefault()}>add one in Variables</a>.</p>
      {:else}
        {#each variableNames as name, i}
          <!-- Keyboard selection is handled on the combobox textarea (arrow keys + Enter via
               aria-activedescendant); the option itself is mouse-activated. -->
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <div
            id="var-opt-{i}"
            role="option"
            tabindex={-1}
            aria-selected={i === activeIndex}
            class="option"
            class:active={i === activeIndex}
            onmousedown={(e) => e.preventDefault()}
            onclick={() => insertVariable(name)}
          >
            {name}
          </div>
        {/each}
      {/if}
    </div>
  {/if}
</div>

<style>
  .editor {
    position: relative;
    max-width: 640px;
  }
  /* The mirror and textarea MUST share identical box + type metrics so tokens line up. */
  .mirror,
  .editor textarea {
    margin: 0;
    padding: var(--space-3);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 20px;
    white-space: pre-wrap;
    overflow-wrap: break-word;
    box-sizing: border-box;
    min-height: 160px;
    /* Reserve the scrollbar gutter on BOTH boxes so the textarea's wrap width can't drift
       from the mirror's when the textarea scrolls or is resized. */
    scrollbar-gutter: stable;
  }
  .mirror {
    position: absolute;
    inset: 0;
    border-color: transparent;
    color: var(--text-primary);
    background: var(--surface-card);
    overflow: hidden;
    pointer-events: none;
  }
  .editor textarea {
    position: relative;
    width: 100%;
    resize: vertical;
    background: transparent;
    color: transparent;
    caret-color: var(--text-primary);
  }
  .editor textarea:focus-visible {
    outline: 2px solid var(--focus-ring);
    outline-offset: 2px;
  }
  .token {
    background: var(--signal-100);
    color: var(--text-primary);
    border-radius: var(--radius-sm);
  }
  .popover {
    position: absolute;
    top: 100%;
    left: 0;
    margin-top: var(--space-1);
    z-index: 10;
    min-width: 200px;
    max-height: 240px;
    overflow-y: auto;
    padding: var(--space-1);
    background: var(--surface-card);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-md);
    display: flex;
    flex-direction: column;
  }
  .popover .option {
    text-align: left;
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-sm);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    color: var(--text-primary);
    cursor: pointer;
  }
  .popover .option:hover,
  .popover .option.active {
    background: var(--surface-raised);
  }
  .popover .empty {
    margin: 0;
    padding: var(--space-2) var(--space-3);
    font-size: var(--text-sm);
    color: var(--text-tertiary);
  }
  .popover a {
    color: var(--text-link);
  }
</style>
