import { Hono } from "hono";
import type { ToolsRepo, ToolRow } from "./repo.js";

// Tool surface (Epic 6, Story 6.1). Read + delete only this story — CREATING a tool is connecting a
// remote endpoint (Story 6.2) or deploying a container (Epic 7). Session-guarded via /tools* in app.ts.

// The public projection. Establishes the secret-masking pattern NOW (6.2 adds a Guard-held credential
// this must NEVER return — like connections' view() drops the key). 6.1 stores no secret.
function view(r: ToolRow) {
  return {
    id: r.id,
    name: r.name,
    endpoint: r.endpoint,
    status: r.status,
    lastError: r.lastError,
    operations: r.operations,
    createdAt: r.createdAt,
  };
}

export function toolRoutes(repo: ToolsRepo) {
  const app = new Hono();

  app.get("/tools", async (c) => {
    return c.json({ tools: (await repo.listTools()).map(view) });
  });

  app.get("/tools/:id", async (c) => {
    const tool = await repo.getTool(c.req.param("id"));
    if (!tool) return c.json({ error: "That tool doesn't exist." }, 404);
    return c.json({ tool: view(tool) });
  });

  app.delete("/tools/:id", async (c) => {
    const existing = await repo.getTool(c.req.param("id"));
    if (!existing) return c.json({ error: "That tool doesn't exist." }, 404);
    await repo.deleteTool(existing.id);
    return c.json({ ok: true });
  });

  return app;
}
