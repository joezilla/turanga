import { describe, it, expect } from "vitest";
import { isOutbound, attachableSkills, skillLabel, SCOPE_LABELS, BUILTIN_SKILLS } from "./skills";
import type { AttachedSkill } from "./agents";

describe("skills helpers", () => {
  it("marks only draft-reply as outbound", () => {
    expect(isOutbound("draft-reply")).toBe(true);
    expect(isOutbound("read-search")).toBe(false);
    expect(isOutbound("flag-label")).toBe(false);
    expect(isOutbound("summarize")).toBe(false);
  });

  it("attachableSkills excludes already-attached skills", () => {
    const attached: AttachedSkill[] = [
      { skill: "read-search", scope: "read", send: false },
      { skill: "summarize", scope: "none", send: false },
    ];
    expect(attachableSkills(attached).map((s) => s.id)).toEqual(["draft-reply", "flag-label"]);
    expect(attachableSkills([]).length).toBe(4);
  });

  it("maps ids to display labels and scopes to labels", () => {
    expect(skillLabel("read-search")).toBe("read/search");
    expect(skillLabel("draft-reply")).toBe("draft reply");
    expect(SCOPE_LABELS.none).toBe("No access");
    expect(SCOPE_LABELS["read-write"]).toBe("Read & write");
    expect(BUILTIN_SKILLS).toHaveLength(4);
  });
});
