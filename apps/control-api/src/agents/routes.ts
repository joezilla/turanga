import { Hono } from "hono";
import { ulid } from "@turanga/domain";
import type { AgentsRepo, AgentRow, AgentPatch, AgentVariable } from "./repo.js";

// Bound the display name / model string so one oversized value can't bloat payloads.
const MAX_NAME_LEN = 200;
const MAX_MODEL_LEN = 200;
const MAX_INSTRUCTIONS_LEN = 20000; // Story 3.3
const MAX_VAR_VALUE_LEN = 2000;
const MAX_VARIABLES = 50;
const VAR_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

// Validate `variables` from a PATCH body. Returns the cleaned array, or an error string.
function parseVariables(input: unknown): { ok: true; value: AgentVariable[] } | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: false, error: "Variables must be a list." };
  if (input.length > MAX_VARIABLES) return { ok: false, error: `A maximum of ${MAX_VARIABLES} variables is allowed.` };
  const seen = new Set<string>();
  const out: AgentVariable[] = [];
  for (const item of input) {
    if (item === null || typeof item !== "object") {
      return { ok: false, error: "Each variable must be an object with a name and value." };
    }
    const v = item as { name?: unknown; value?: unknown };
    if (typeof v.name !== "string" || !VAR_NAME_RE.test(v.name)) {
      return { ok: false, error: "Each variable needs a name that starts with a letter and uses only letters, numbers, or underscores." };
    }
    if (seen.has(v.name)) return { ok: false, error: `Variable "${v.name}" is defined more than once.` };
    if (typeof v.value !== "string") return { ok: false, error: "Each variable value must be text." };
    seen.add(v.name);
    out.push({ name: v.name, value: v.value.slice(0, MAX_VAR_VALUE_LEN) });
  }
  return { ok: true, value: out };
}

export function agentRoutes(repo: AgentsRepo) {
  const app = new Hono();

  app.get("/agents", async (c) => c.json({ agents: await repo.list() }));

  app.post("/agents", async (c) => {
    // `?? {}` guards a body of literal `null` (valid JSON, so .catch never fires).
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { name?: unknown };
    const trimmed = typeof body.name === "string" ? body.name.trim() : "";
    const name = (trimmed || "Untitled agent").slice(0, MAX_NAME_LEN);
    const row: AgentRow = { id: ulid(Date.now()), name, state: "draft", model: null, instructions: "", variables: [], createdAt: new Date().toISOString() };
    await repo.create(row);
    return c.json({ agent: row }, 201);
  });

  app.get("/agents/:id", async (c) => {
    const agent = await repo.get(c.req.param("id"));
    if (!agent) return c.json({ error: "That agent doesn't exist." }, 404);
    return c.json({ agent });
  });

  // Autosave surface. name + model (3.2) + instructions + variables (3.3); unknown keys ignored.
  app.patch("/agents/:id", async (c) => {
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as {
      name?: unknown;
      model?: unknown;
      instructions?: unknown;
      variables?: unknown;
    };
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
    if (body.instructions !== undefined) {
      if (typeof body.instructions !== "string") {
        return c.json({ error: "Instructions must be text." }, 400);
      }
      patch.instructions = body.instructions.slice(0, MAX_INSTRUCTIONS_LEN); // empty is allowed
    }
    if (body.variables !== undefined) {
      const parsed = parseVariables(body.variables);
      if (!parsed.ok) return c.json({ error: parsed.error }, 400);
      patch.variables = parsed.value;
    }

    const agent = await repo.update(c.req.param("id"), patch);
    if (!agent) return c.json({ error: "That agent doesn't exist." }, 404);
    return c.json({ agent });
  });

  return app;
}
