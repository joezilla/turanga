import { Hono } from "hono";
import { ulid, type MemoryGlobalConfig, type MemoryEventKind } from "@turanga/domain";
import type { MemoryRepo, MemoryRow, MemoryEventRow } from "./repo.js";
import type { ModelGateway } from "../litellm/gateway.js";

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
  if (b.requireApprovalDefault !== undefined) {
    if (typeof b.requireApprovalDefault !== "boolean") return { ok: false, error: "requireApprovalDefault must be true or false." };
    value.requireApprovalDefault = b.requireApprovalDefault;
  }
  // embeddingModel / privacy are read-only this story — silently ignored (never a 400, so a full-object
  // round-trip PATCH still succeeds).
  return { ok: true, value };
}

// The memory list/curation view (Story 8.5) — everything the UI shows; the embedding vector is dropped
// (huge + useless to render). A memory can carry real user data → shown ONLY on its own agent's surface.
function view(m: MemoryRow) {
  return {
    id: m.id,
    kind: m.kind,
    content: m.content,
    summary: m.summary,
    topic: m.topic,
    salience: m.salience,
    pinned: m.pinned,
    status: m.status, // Story 8.6
    useCount: m.useCount,
    lastUsedAt: m.lastUsedAt,
    sourceRunId: m.sourceRunId,
    validFrom: m.validFrom,
    validUntil: m.validUntil,
    createdAt: m.createdAt,
  };
}

// A helper to append a learning-changelog event (Story 8.6). Best-effort — a log failure never blocks
// the curation action (control-api sole writer, AD-7; agent-scoped, FR-7).
async function logEvent(repo: MemoryRepo, agentId: string, kind: MemoryEventKind, m: MemoryRow) {
  const event: MemoryEventRow = { id: ulid(Date.now()), agentId, memoryId: m.id, kind, summary: m.summary, sourceRunId: m.sourceRunId, at: new Date().toISOString() };
  await repo.logMemoryEvent(event).catch(() => {});
}

// Validate a memory-edit PATCH (Story 8.5). Only content/summary/pinned are editable; all optional.
function parseMemoryEdit(input: unknown): { ok: true; value: { content?: string; summary?: string; pinned?: boolean } } | { ok: false; error: string } {
  if (typeof input !== "object" || input === null) return { ok: false, error: "Expected a memory edit object." };
  const b = input as Record<string, unknown>;
  const value: { content?: string; summary?: string; pinned?: boolean } = {};
  if (b.content !== undefined) {
    if (typeof b.content !== "string" || !b.content.trim()) return { ok: false, error: "content must be non-empty text." };
    value.content = b.content;
  }
  if (b.summary !== undefined) {
    if (typeof b.summary !== "string") return { ok: false, error: "summary must be text." };
    value.summary = b.summary;
  }
  if (b.pinned !== undefined) {
    if (typeof b.pinned !== "boolean") return { ok: false, error: "pinned must be true or false." };
    value.pinned = b.pinned;
  }
  return { ok: true, value };
}

export function memoryRoutes(repo: MemoryRepo, gateway: ModelGateway) {
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

  // Story 8.5 — the memory-inspection surface. List an agent's memories (agent-scoped, FR-7), sorted
  // pinned-first, then salience desc, then newest. Never returns another agent's rows.
  app.get("/memory/agents/:agentId", async (c) => {
    const rows = await repo.listForAgent(c.req.param("agentId"));
    rows.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.salience - a.salience || (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return c.json({ memories: rows.map(view) });
  });

  // Edit a memory's content/summary/pinned (curation, AD-7 sole writer). Editing `content` RE-EMBEDS it
  // (best-effort — a re-embed failure updates the text but keeps the old vector; the edit never fails
  // because LiteLLM is down). Agent-scoped: only the owning agent's memory resolves (FR-7).
  app.patch("/memory/agents/:agentId/:id", async (c) => {
    const agentId = c.req.param("agentId");
    const id = c.req.param("id");
    const existing = await repo.getMemory(agentId, id);
    if (!existing) return c.json({ error: "That memory doesn't exist." }, 404);
    const parsed = parseMemoryEdit((await c.req.json().catch(() => ({}))) ?? {});
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);

    const patch: { content?: string; summary?: string; embedding?: number[]; pinned?: boolean } = { ...parsed.value };
    if (patch.content !== undefined && patch.content !== existing.content) {
      try {
        patch.embedding = await gateway.embed(patch.content, (await repo.getGlobalConfig()).embeddingModel);
      } catch {
        /* re-embed failed → keep the old vector; the text edit still applies (recall stays functional) */
      }
    }
    await repo.updateMemory(agentId, id, patch);
    const updated = (await repo.getMemory(agentId, id))!;
    // Story 8.6 — changelog: a pin toggle logs pinned/unpinned; any other edit logs edited.
    if (patch.pinned !== undefined && patch.pinned !== existing.pinned) await logEvent(repo, agentId, patch.pinned ? "pinned" : "unpinned", updated);
    else if (patch.content !== undefined || patch.summary !== undefined) await logEvent(repo, agentId, "edited", updated);
    return c.json({ memory: view(updated) });
  });

  // Forget ONE memory (distinct from the bulk purge above). Agent-scoped. Story 8.6 — a forget of a
  // PENDING memory is a REJECT (logs 'rejected'); forgetting an active/quarantined one is 'forgotten'.
  app.delete("/memory/agents/:agentId/:id", async (c) => {
    const agentId = c.req.param("agentId");
    const id = c.req.param("id");
    const existing = await repo.getMemory(agentId, id);
    if (!existing) return c.json({ error: "That memory doesn't exist." }, 404);
    await repo.deleteMemory(agentId, id);
    await logEvent(repo, agentId, existing.status === "pending" ? "rejected" : "forgotten", existing);
    return c.json({ ok: true });
  });

  // Story 8.6 — staged approval: accept a PENDING memory (→ active, now recallable) or quarantine/
  // un-quarantine any memory (a non-destructive recall toggle for rolling back a learning regression).
  // Each logs a changelog event. Agent-scoped (FR-7); the memory resolves only for its owning agent.
  const setStatusRoute = (path: string, from: MemoryRow["status"][] | null, to: MemoryRow["status"], event: MemoryEventKind) =>
    app.post(path, async (c) => {
      const agentId = c.req.param("agentId") ?? "";
      const id = c.req.param("id") ?? "";
      const existing = await repo.getMemory(agentId, id);
      if (!existing) return c.json({ error: "That memory doesn't exist." }, 404);
      if (from && !from.includes(existing.status)) return c.json({ error: `Can't ${event} a ${existing.status} memory.` }, 400);
      await repo.updateMemory(agentId, id, { status: to });
      const updated = (await repo.getMemory(agentId, id))!;
      await logEvent(repo, agentId, event, updated);
      return c.json({ memory: view(updated) });
    });
  setStatusRoute("/memory/agents/:agentId/:id/accept", ["pending"], "active", "accepted");
  setStatusRoute("/memory/agents/:agentId/:id/quarantine", ["active", "pending"], "quarantined", "quarantined");
  setStatusRoute("/memory/agents/:agentId/:id/unquarantine", ["quarantined"], "active", "unquarantined");

  // The learning changelog (Story 8.6) — newest-first, agent-scoped (FR-7).
  app.get("/memory/agents/:agentId/events", async (c) => {
    const events = await repo.listMemoryEvents(c.req.param("agentId"), 200);
    return c.json({ events });
  });

  return app;
}
