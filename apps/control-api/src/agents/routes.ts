import { Hono } from "hono";
import { ulid } from "@turanga/domain";
import type { AgentsRepo, AgentRow } from "./repo.js";

export function agentRoutes(repo: AgentsRepo) {
  const app = new Hono();

  app.get("/agents", async (c) => c.json({ agents: await repo.list() }));

  app.post("/agents", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { name?: unknown };
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "Untitled agent";
    const row: AgentRow = { id: ulid(Date.now()), name, state: "draft", createdAt: new Date().toISOString() };
    await repo.create(row);
    return c.json({ agent: row }, 201);
  });

  return app;
}
