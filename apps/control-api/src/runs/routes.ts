import { Hono } from "hono";
import type { RunsRepo } from "./repo.js";
import type { RunOrchestrator } from "./orchestrator.js";

// Run surface (Epic 4). 4.1 is synchronous store-and-return — POST /runs launches, waits for the
// sandbox to complete, and returns the terminal transcript. Live SSE streaming is Story 4.2.
const MAX_TASK_INPUT = 10_000; // the task input flows into an env-injected job spec — keep it bounded

export function runRoutes(repo: RunsRepo, orchestrator: RunOrchestrator) {
  const app = new Hono();

  app.post("/runs", async (c) => {
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { agentId?: unknown; taskInput?: unknown };
    if (typeof body.agentId !== "string" || !body.agentId) {
      return c.json({ error: "An agentId is required." }, 400);
    }
    const taskInput = (typeof body.taskInput === "string" ? body.taskInput : "").slice(0, MAX_TASK_INPUT);
    try {
      const r = await orchestrator.launch(body.agentId, taskInput);
      if (!r.ok) return c.json({ error: r.error }, r.status);
      return c.json({ run: r.run }, 201);
    } catch (e) {
      return c.json({ error: `The run couldn't be launched: ${e instanceof Error ? e.message : "unexpected error"}` }, 500);
    }
  });

  app.get("/runs/:id", async (c) => {
    const run = await repo.get(c.req.param("id"));
    if (!run) return c.json({ error: "That run doesn't exist." }, 404);
    return c.json({ run });
  });

  app.get("/runs", async (c) => {
    return c.json({ runs: await repo.list(c.req.query("agentId")) }); // bounded by the repo default
  });

  return app;
}
