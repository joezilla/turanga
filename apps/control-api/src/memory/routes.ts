import { Hono } from "hono";
import type { MemoryGlobalConfig } from "@turanga/domain";
import type { MemoryRepo } from "./repo.js";

// Memory config surface (Epic 8, Story 8.2). control-api is the sole writer (AD-7). This exposes ONLY
// the operator's global defaults + an agent-scoped purge — no memory-list/curation (that's 8.5), no
// recall/reflect (8.3/8.4). Session-guarded via /memory* in app.ts.

// Validate a PATCH to the global config. `embeddingModel` + `privacy` are READ-ONLY this story: the
// pgvector column is fixed at 1536 dims (text-embedding-3-small) so changing the model would need a
// migration + re-embed, and `agent-scoped` is the only privacy value — both are ignored if sent.
function parseGlobalConfig(input: unknown): { ok: true; value: Partial<MemoryGlobalConfig> } | { ok: false; error: string } {
  if (typeof input !== "object" || input === null) return { ok: false, error: "Expected a memory settings object." };
  const b = input as Record<string, unknown>;
  const value: Partial<MemoryGlobalConfig> = {};

  if (b.defaultEnabled !== undefined) {
    if (typeof b.defaultEnabled !== "boolean") return { ok: false, error: "defaultEnabled must be true or false." };
    value.defaultEnabled = b.defaultEnabled;
  }
  if (b.killSwitch !== undefined) {
    if (typeof b.killSwitch !== "boolean") return { ok: false, error: "killSwitch must be true or false." };
    value.killSwitch = b.killSwitch;
  }
  if (b.retentionDays !== undefined) {
    if (b.retentionDays !== null && (typeof b.retentionDays !== "number" || !Number.isInteger(b.retentionDays) || b.retentionDays <= 0)) {
      return { ok: false, error: "retentionDays must be a positive whole number of days, or blank to keep memories indefinitely." };
    }
    value.retentionDays = b.retentionDays as number | null;
  }
  // embeddingModel / privacy are read-only this story — silently ignored (never a 400, so a full-object
  // round-trip PATCH still succeeds).
  return { ok: true, value };
}

export function memoryRoutes(repo: MemoryRepo) {
  const app = new Hono();

  app.get("/memory/config", async (c) => {
    return c.json(await repo.getGlobalConfig());
  });

  app.patch("/memory/config", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) ?? {};
    const parsed = parseGlobalConfig(body);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    return c.json(await repo.setGlobalConfig(parsed.value));
  });

  // Opt-in, agent-scoped purge (Story 8.2 AC3). Removes ONLY this agent's memories (FR-7 — the repo is
  // agent-keyed; never touches another agent's rows). Non-destructive by default: disabling memory does
  // not auto-delete; this is a deliberate, confirmed action from the UI.
  app.delete("/memory/agents/:agentId", async (c) => {
    const agentId = c.req.param("agentId");
    const memories = await repo.listForAgent(agentId);
    for (const m of memories) await repo.deleteMemory(agentId, m.id);
    return c.json({ purged: memories.length });
  });

  return app;
}
