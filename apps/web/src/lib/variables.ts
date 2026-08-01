// Variable-token parsing shared by the instructions editor + the undefined-variable hint.
// A variable reference is `{name}` where name starts with a letter and uses letters,
// numbers, or underscores (max 64) — the same rule control-api enforces (Story 3.3).
export const VAR_TOKEN_RE = /\{([a-zA-Z][a-zA-Z0-9_]{0,63})\}/g;

/** Distinct variable names referenced in `text`, in first-seen order. */
export function referencedVariables(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(VAR_TOKEN_RE)) {
    const name = m[1];
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/** Referenced names that are not in the defined set, in first-seen order. */
export function undefinedVariables(text: string, defined: Iterable<string>): string[] {
  const definedSet = new Set(defined);
  return referencedVariables(text).filter((n) => !definedSet.has(n));
}
