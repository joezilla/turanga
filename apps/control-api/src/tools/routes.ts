import { Hono } from "hono";
import { ulid } from "@turanga/domain";
import { encryptSecret } from "../secrets/crypto.js";
import type { ToolsRepo, ToolRow } from "./repo.js";
import type { McpVerifier } from "./mcp.js";

// Tool surface (Epic 6). Connecting a remote MCP tool (Story 6.2): verify by an MCP handshake, discover
// its operations, store the credential ENCRYPTED (AD-10). Session-guarded via /tools* in app.ts.

// The public projection. NEVER returns `encCredential` (the AD-10 mask — like connections' view() drops
// the key); exposes `url` + a boolean `credentialSet` so the UI can show "credential set" without it.
function view(r: ToolRow) {
  return {
    id: r.id,
    name: r.name,
    endpoint: r.endpoint,
    status: r.status,
    lastError: r.lastError,
    url: r.url,
    credentialSet: !!r.encCredential,
    operations: r.operations,
    createdAt: r.createdAt,
  };
}

export function toolRoutes(repo: ToolsRepo, verifier: McpVerifier) {
  const app = new Hono();

  app.get("/tools", async (c) => {
    return c.json({ tools: (await repo.listTools()).map(view) });
  });

  // Connect a remote MCP tool (Story 6.2). Verify FIRST via an MCP handshake — a failure returns the
  // stated cause and persists NOTHING (fail-closed, no orphan rows). On success the credential is
  // encrypted at rest (never echoed, AD-10) and the discovered operations are stored.
  app.post("/tools", async (c) => {
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { name?: unknown; url?: unknown; credential?: unknown };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const url = typeof body.url === "string" ? body.url.trim() : "";
    const credential = typeof body.credential === "string" && body.credential ? body.credential : undefined;
    if (!name) return c.json({ error: "A name is required." }, 400);
    if (!url) return c.json({ error: "A URL is required." }, 400);

    const v = await verifier.verify({ url, credential });
    if (!v.ok) return c.json({ error: v.error }, 400); // fail-closed — never store a bad connection

    const id = ulid(Date.now());
    await repo.createTool({
      id,
      name,
      endpoint: "remote",
      status: "connected",
      lastError: null,
      url,
      encCredential: credential ? encryptSecret(credential) : null,
      operations: v.operations,
      createdAt: new Date().toISOString(),
    });
    return c.json({ tool: view((await repo.getTool(id))!) }, 201);
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
