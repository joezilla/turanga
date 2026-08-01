// Built-in skill metadata + helpers (Story 3.4). The four skills and their display labels;
// which are outbound (carry a send grant); the permission-scope labels; and which built-ins
// are still attachable. Enforcement of scopes/send lands in Epic 4 (the Guard / harness).
import type { AttachedSkill, SkillId, SkillScope } from "$lib/agents";

export interface SkillMeta {
  id: SkillId;
  label: string;
}

export const BUILTIN_SKILLS: SkillMeta[] = [
  { id: "read-search", label: "read/search" },
  { id: "draft-reply", label: "draft reply" },
  { id: "flag-label", label: "flag/label" },
  { id: "summarize", label: "summarize" },
];

// Only an outbound skill (produces something that could be sent) carries a send grant (FR-18).
export const OUTBOUND_SKILLS = new Set<SkillId>(["draft-reply"]);

export const SCOPE_LABELS: Record<SkillScope, string> = {
  none: "No access",
  read: "Read",
  "read-write": "Read & write",
};

export const SCOPE_ORDER: SkillScope[] = ["none", "read", "read-write"];

export function isOutbound(skill: SkillId): boolean {
  return OUTBOUND_SKILLS.has(skill);
}

export function skillLabel(skill: SkillId): string {
  return BUILTIN_SKILLS.find((s) => s.id === skill)?.label ?? skill;
}

/** Built-ins not yet attached — the picker's candidate list. */
export function attachableSkills(attached: AttachedSkill[]): SkillMeta[] {
  const have = new Set(attached.map((a) => a.skill));
  return BUILTIN_SKILLS.filter((s) => !have.has(s.id));
}
