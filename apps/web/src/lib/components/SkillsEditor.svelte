<script lang="ts">
  // Skills section (Story 3.4). Attach built-in skills as rectangular chips (never pills) via a
  // searchable picker popover; each chip carries an inline permission scope (default-deny) and,
  // for the outbound skill, a distinct off-by-default send grant. Config only — the Guard
  // enforces scopes/send at run time in Epic 4.
  import { tick } from "svelte";
  import { X, Plus } from "@lucide/svelte";
  import type { AttachedSkill, SkillId, SkillScope } from "$lib/agents";
  import { attachableSkills, isOutbound, skillLabel, SCOPE_LABELS, SCOPE_ORDER } from "$lib/skills";

  let { value, onchange }: { value: AttachedSkill[]; onchange: (skills: AttachedSkill[]) => void } = $props();

  let pickerOpen = $state(false);
  let query = $state("");
  let searchEl = $state<HTMLInputElement | null>(null);

  const candidates = $derived(
    attachableSkills(value).filter((s) => s.label.toLowerCase().includes(query.trim().toLowerCase())),
  );

  async function openPicker() {
    pickerOpen = true;
    query = "";
    await tick();
    searchEl?.focus();
  }

  function attach(skill: SkillId) {
    onchange([...value, { skill, scope: "none", send: false }]); // default-deny, send off
    pickerOpen = false;
  }
  function remove(skill: SkillId) {
    onchange(value.filter((s) => s.skill !== skill));
  }
  function setScope(skill: SkillId, scope: SkillScope) {
    onchange(value.map((s) => (s.skill === skill ? { ...s, scope } : s)));
  }
  function setSend(skill: SkillId, send: boolean) {
    onchange(value.map((s) => (s.skill === skill ? { ...s, send } : s)));
  }
</script>

<div class="skills">
  {#if value.length === 0}
    <p class="muted">No skills attached.</p>
  {/if}

  <ul class="chips">
    {#each value as s (s.skill)}
      <li class="chip">
        <div class="chip-head">
          <span class="name">{skillLabel(s.skill)}</span>
          <button type="button" class="remove" aria-label={`Remove ${skillLabel(s.skill)}`} onclick={() => remove(s.skill)}>
            <X size={14} color="currentColor" />
          </button>
        </div>
        <div class="grants">
          <label class="scope">
            <span class="field-label">Permission scope</span>
            <select value={s.scope} onchange={(e) => setScope(s.skill, (e.currentTarget as HTMLSelectElement).value as SkillScope)}>
              {#each SCOPE_ORDER as sc}
                <option value={sc}>{SCOPE_LABELS[sc]}</option>
              {/each}
            </select>
          </label>
          {#if isOutbound(s.skill)}
            <label class="send">
              <input type="checkbox" checked={s.send} onchange={(e) => setSend(s.skill, (e.currentTarget as HTMLInputElement).checked)} />
              <span>Allow send</span>
            </label>
          {/if}
        </div>
      </li>
    {/each}
  </ul>

  <div class="add">
    <button type="button" class="add-btn" onclick={openPicker} disabled={attachableSkills(value).length === 0}>
      <Plus size={14} color="currentColor" /> Add skill
    </button>

    {#if pickerOpen}
      <div class="picker" role="dialog" aria-label="Add a skill">
        <input
          class="search"
          type="text"
          bind:this={searchEl}
          bind:value={query}
          placeholder="Search skills"
          aria-label="Search skills"
          onkeydown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              pickerOpen = false;
            }
          }}
        />
        {#if candidates.length === 0}
          <p class="empty">No matching skills.</p>
        {:else}
          {#each candidates as c}
            <button type="button" class="option" onmousedown={(e) => e.preventDefault()} onclick={() => attach(c.id)}>{c.label}</button>
          {/each}
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .skills {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    max-width: 560px;
  }
  .muted {
    margin: 0;
    color: var(--text-tertiary);
    font-size: var(--text-sm);
  }
  .chips {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  /* Rectangular (4px) — NEVER a pill (DESIGN.md#Shapes / anti-patterns). */
  .chip {
    padding: var(--space-3);
    background: var(--surface-card);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
  }
  .chip-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
  }
  .name {
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--text-primary);
  }
  .remove {
    display: inline-flex;
    padding: var(--space-1);
    background: none;
    border: none;
    color: var(--text-secondary);
    cursor: pointer;
    border-radius: var(--radius-sm);
  }
  .remove:hover {
    color: var(--text-primary);
  }
  .grants {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: var(--space-4);
    margin-top: var(--space-3);
  }
  .field-label {
    display: block;
    font-size: var(--text-xs);
    color: var(--text-secondary);
    margin-bottom: var(--space-1);
  }
  .scope select {
    height: var(--control-h-sm);
    padding: 0 var(--space-2);
    font-size: var(--text-sm);
    color: var(--text-primary);
    background: var(--surface-card);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
  }
  .send {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    color: var(--text-primary);
  }
  .add {
    position: relative;
  }
  .add-btn {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    height: var(--control-h-md);
    padding: 0 var(--space-3);
    background: var(--action-secondary-bg);
    color: var(--action-secondary-fg);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    cursor: pointer;
  }
  .add-btn:disabled {
    color: var(--text-disabled);
    cursor: default;
  }
  .picker {
    position: absolute;
    top: 100%;
    left: 0;
    margin-top: var(--space-1);
    z-index: 10;
    min-width: 220px;
    padding: var(--space-1);
    background: var(--surface-card);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-md);
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .search {
    height: var(--control-h-sm);
    padding: 0 var(--space-2);
    font-size: var(--text-sm);
    color: var(--text-primary);
    background: var(--surface-card);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
  }
  .picker .option {
    text-align: left;
    padding: var(--space-2) var(--space-3);
    background: none;
    border: none;
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
    color: var(--text-primary);
    cursor: pointer;
  }
  .picker .option:hover {
    background: var(--surface-raised);
  }
  .picker .empty {
    margin: 0;
    padding: var(--space-2) var(--space-3);
    font-size: var(--text-sm);
    color: var(--text-tertiary);
  }
</style>
