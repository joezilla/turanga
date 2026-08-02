import { Hono } from "hono";
import type { RunsRepo } from "./repo.js";
import type { RunOrchestrator } from "./orchestrator.js";

// Run surface (Epic 4). 4.1 is synchronous store-and-return — POST /runs launches, waits for the
// sandbox to complete, and returns the terminal transcript. Live SSE streaming is Story 4.2.
export function runRoutes(repo: RunsRepo, orchestrator: RunOrchestrator) {
  const app = new Hono();

  app.post("/runs", async (c) => {
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { agentId?: unknown; taskInput?: unknown };
    if (typeof body.agentId !== "string" || !body.agentId) {
      return c.json({ error: "An agentId is required." }, 400);
    }
    const taskInput = typeof body.taskInput === "string" ? body.taskInput : "";
    const r = await orchestrator.launch(body.agentId, taskInput);
    if (!r.ok) return c.json({ error: r.error }, r.status);
    return c.json({ run: r.run }, 201);
  });

  app.get("/runs/:id", async (c) => {
    const run = await repo.get(c.req.param("id"));
    if (!run) return c.json({ error: "That run doesn't exist." }, 404);
    return c.json({ run });
  });

  app.get("/runs", async (c) => {
    const agentId = c.req.query("agentId");
    return c.json({ runs: await repo.list(agentId) });
  });

  return app;
}
