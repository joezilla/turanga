import { Hono } from "hono";
import { ulid } from "@turanga/domain";
import type { AgentsRepo, AgentRow, AgentPatch } from "./repo.js";

// Bound the display name / model string so one oversized value can't bloat payloads.
const MAX_NAME_LEN = 200;
const MAX_MODEL_LEN = 200;

export function agentRoutes(repo: AgentsRepo) {
  const app = new Hono();

  app.get("/agents", async (c) => c.json({ agents: await repo.list() }));

  app.post("/agents", async (c) => {
    // `?? {}` guards a body of literal `null` (valid JSON, so .catch never fires).
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { name?: unknown };
    const trimmed = typeof body.name === "string" ? body.name.trim() : "";
    const name = (trimmed || "Untitled agent").slice(0, MAX_NAME_LEN);
    const row: AgentRow = { id: ulid(Date.now()), name, state: "draft", model: null, createdAt: new Date().toISOString() };
    await repo.create(row);
    return c.json({ agent: row }, 201);
  });

  app.get("/agents/:id", async (c) => {
    const agent = await repo.get(c.req.param("id"));
    if (!agent) return c.json({ error: "That agent doesn't exist." }, 404);
    return c.json({ agent });
  });

  // Autosave surface. Only name + model are writable in 3.2; unknown keys are ignored.
  app.patch("/agents/:id", async (c) => {
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { name?: unknown; model?: unknown };
    const patch: AgentPatch = {};

    if (body.name !== undefined) {
      if (typeof body.name !== "string" || !body.name.trim()) {
        return c.json({ error: "A name can't be empty." }, 400);
      }
      patch.name = body.name.trim().slice(0, MAX_NAME_LEN);
    }
    if (body.model !== undefined) {
      if (body.model === null) {
        patch.model = null;
      } else if (typeof body.model === "string" && body.model.trim()) {
        patch.model = body.model.trim().slice(0, MAX_MODEL_LEN);
      } else {
        return c.json({ error: "Model must be a provider/model-id string, or null to clear it." }, 400);
      }
    }

    const agent = await repo.update(c.req.param("id"), patch);
    if (!agent) return c.json({ error: "That agent doesn't exist." }, 404);
    return c.json({ agent });
  });

  return app;
}
