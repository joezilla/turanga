import { Hono } from "hono";
import { ulid } from "@turanga/domain";
import type { ConversationsRepo, ConversationRow } from "./repo.js";
import type { AgentsRepo } from "../agents/repo.js";

// Chat conversations surface (Epic 9, Story 9.1). control-api is the sole writer (AD-7). A conversation
// is a thread bound to a PUBLISHED agent version: creating one against an agent that was never
// published is refused (chat runs the published snapshot, never the draft), and the current published
// version is PINNED at creation (latest-at-conversation-start). Turn execution is Story 9.2; the web
// surface is 9.3. Session-guarded via /conversations* in app.ts.

function parseCreate(input: unknown): { ok: true; value: { agentId: string; title: string } } | { ok: false; error: string } {
  if (typeof input !== "object" || input === null) return { ok: false, error: "Expected a conversation object." };
  const b = input as Record<string, unknown>;
  if (typeof b.agentId !== "string" || !b.agentId.trim()) return { ok: false, error: "agentId is required." };
  if (b.title !== undefined && typeof b.title !== "string") return { ok: false, error: "title must be text." };
  return { ok: true, value: { agentId: b.agentId, title: (b.title as string | undefined) ?? "" } };
}

export function conversationRoutes(repo: ConversationsRepo, agentsRepo: AgentsRepo) {
  const app = new Hono();

  // Start a conversation. Refused if the agent was never published (publish before you can chat); pins
  // the agent's current published version so republishing never changes an in-flight conversation.
  app.post("/conversations", async (c) => {
    const parsed = parseCreate((await c.req.json().catch(() => ({}))) ?? {});
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const agent = await agentsRepo.get(parsed.value.agentId);
    if (!agent) return c.json({ error: "That agent doesn't exist." }, 404);
    if (agent.publishedVersion == null) return c.json({ error: "Publish this agent to chat with it." }, 409);

    const row: ConversationRow = {
      id: ulid(Date.now()),
      agentId: agent.id,
      publishedVersion: agent.publishedVersion, // PIN latest-at-conversation-start
      title: parsed.value.title,
      createdAt: new Date().toISOString(),
    };
    await repo.create(row);
    return c.json({ conversation: row }, 201);
  });

  // List an agent's conversations (agent-scoped, newest-first).
  app.get("/conversations", async (c) => {
    const agentId = c.req.query("agentId");
    if (!agentId) return c.json({ error: "agentId is required." }, 400);
    return c.json({ conversations: await repo.listForAgent(agentId) });
  });

  app.get("/conversations/:id", async (c) => {
    const conversation = await repo.get(c.req.param("id"));
    if (!conversation) return c.json({ error: "That conversation doesn't exist." }, 404);
    return c.json({ conversation });
  });

  return app;
}
