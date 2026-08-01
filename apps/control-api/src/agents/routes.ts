import { Hono } from "hono";
import { ulid } from "@turanga/domain";
import type { AgentsRepo, AgentRow } from "./repo.js";

// Bound the display name so one oversized create can't bloat every list payload.
const MAX_NAME_LEN = 200;

export function agentRoutes(repo: AgentsRepo) {
  const app = new Hono();

  app.get("/agents", async (c) => c.json({ agents: await repo.list() }));

  app.post("/agents", async (c) => {
    // `?? {}` guards a body of literal `null` (valid JSON, so .catch never fires).
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { name?: unknown };
    const trimmed = typeof body.name === "string" ? body.name.trim() : "";
    const name = (trimmed || "Untitled agent").slice(0, MAX_NAME_LEN);
    const row: AgentRow = { id: ulid(Date.now()), name, state: "draft", createdAt: new Date().toISOString() };
    await repo.create(row);
    return c.json({ agent: row }, 201);
  });

  return app;
}
