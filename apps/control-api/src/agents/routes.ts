import { Hono } from "hono";
import { ulid, activationBlockers } from "@turanga/domain";
import type { AgentsRepo, AgentRow, AgentPatch, AgentVariable, AttachedSkill, CostCap, Money } from "./repo.js";
import type { ConnectionsRepo } from "../connections/repo.js";

// Story 5.1: is the agent's model ("<prefix>/<id>") served by a currently-connected provider? The
// prefix is the provider kind (openai/anthropic) or the connection name (openai-compatible).
async function modelProviderConnected(model: string | null, connectionsRepo: ConnectionsRepo): Promise<boolean> {
  if (!model) return false;
  const prefix = model.split("/")[0];
  const providers = await connectionsRepo.listProviders();
  return providers.some((p) => p.status === "connected" && (p.provider === prefix || p.name === prefix));
}

// Bound the display name / model string so one oversized value can't bloat payloads.
const MAX_NAME_LEN = 200;
const MAX_MODEL_LEN = 200;
const MAX_INSTRUCTIONS_LEN = 20000; // Story 3.3
const MAX_VAR_VALUE_LEN = 2000;
const MAX_VARIABLES = 50;
const VAR_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

// Skills (Story 3.4). Only the 4 built-ins; scope is default-deny; send is off-by-default and
// only meaningful for outbound skills (draft-reply). Enforcement lands in Epic 4 (the Guard).
const BUILTIN_SKILLS = new Set(["read-search", "draft-reply", "flag-label", "summarize"]);
const SKILL_SCOPES = new Set(["none", "read", "read-write"]);
const OUTBOUND_SKILLS = new Set(["draft-reply"]);

// Cost caps (Story 3.5). Money is integer minor units + currency; MVP is single-currency USD.
const MAX_CAP_MINOR = 100_000_00; // $100,000
const CAP_CURRENCY = "USD"; // MVP is single-currency

// One side of a cost cap: null (unset) or a Money { minor, currency }.
function parseMoney(input: unknown): { ok: true; value: Money | null } | { ok: false; error: string } {
  if (input === null || input === undefined) return { ok: true, value: null }; // an unset cap
  if (typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "A cap must be a money amount or null." };
  const m = input as { minor?: unknown; currency?: unknown };
  if (typeof m.minor !== "number" || !Number.isInteger(m.minor) || m.minor < 0 || m.minor > MAX_CAP_MINOR) {
    return { ok: false, error: "A cap amount must be a whole number of minor units within range." };
  }
  if (m.currency !== CAP_CURRENCY) {
    return { ok: false, error: `Caps must be in ${CAP_CURRENCY}.` };
  }
  return { ok: true, value: { minor: m.minor, currency: m.currency } };
}

function parseCostCap(input: unknown): { ok: true; value: CostCap } | { ok: false; error: string } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "Cost caps must be an object." };
  const c = input as { perRun?: unknown; perDay?: unknown };
  const perRun = parseMoney(c.perRun);
  if (!perRun.ok) return perRun;
  const perDay = parseMoney(c.perDay);
  if (!perDay.ok) return perDay;
  return { ok: true, value: { perRun: perRun.value, perDay: perDay.value } };
}

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

// Validate `skills` from a PATCH body. `send` is forced off for non-outbound skills so a
// non-outbound skill can never carry a send grant (FR-18). Returns the cleaned array or an error.
function parseSkills(input: unknown): { ok: true; value: AttachedSkill[] } | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: false, error: "Skills must be a list." };
  if (input.length > BUILTIN_SKILLS.size) return { ok: false, error: "Too many skills." };
  const seen = new Set<string>();
  const out: AttachedSkill[] = [];
  for (const item of input) {
    if (item === null || typeof item !== "object") {
      return { ok: false, error: "Each skill must be an object." };
    }
    const s = item as { skill?: unknown; scope?: unknown; send?: unknown };
    if (typeof s.skill !== "string" || !BUILTIN_SKILLS.has(s.skill)) {
      return { ok: false, error: "Unknown skill." };
    }
    if (typeof s.scope !== "string" || !SKILL_SCOPES.has(s.scope)) {
      return { ok: false, error: "Unknown permission scope." };
    }
    if (typeof s.send !== "boolean") return { ok: false, error: "A skill's send grant must be true or false." };
    if (seen.has(s.skill)) return { ok: false, error: `Skill "${s.skill}" is attached more than once.` };
    seen.add(s.skill);
    // Only outbound skills may carry a send grant.
    out.push({ skill: s.skill as AttachedSkill["skill"], scope: s.scope as AttachedSkill["scope"], send: OUTBOUND_SKILLS.has(s.skill) ? s.send : false });
  }
  return { ok: true, value: out };
}

export function agentRoutes(repo: AgentsRepo, connectionsRepo: ConnectionsRepo) {
  const app = new Hono();

  app.get("/agents", async (c) => c.json({ agents: await repo.list() }));

  app.post("/agents", async (c) => {
    // `?? {}` guards a body of literal `null` (valid JSON, so .catch never fires).
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { name?: unknown };
    const trimmed = typeof body.name === "string" ? body.name.trim() : "";
    const name = (trimmed || "Untitled agent").slice(0, MAX_NAME_LEN);
    const row: AgentRow = { id: ulid(Date.now()), name, state: "draft", model: null, instructions: "", variables: [], skills: [], costCap: { perRun: null, perDay: null }, createdAt: new Date().toISOString() };
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
      skills?: unknown;
      costCap?: unknown;
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
        const model = body.model.trim().slice(0, MAX_MODEL_LEN);
        // Story 2.4: if the model's provider KIND is connected, the model id must be one of its ENABLED
        // models. A model for a not-yet-connected kind is allowed (set-now-connect-later); the
        // activation gate (5.1) blocks going Active without a connected provider, so nothing runs on an
        // unenabled model.
        const prefix = model.split("/")[0];
        const modelId = model.slice(prefix.length + 1);
        const connectedOfKind = (await connectionsRepo.listProviders()).filter(
          (p) => p.status === "connected" && (p.provider === prefix || p.name === prefix),
        );
        if (connectedOfKind.length > 0 && !connectedOfKind.some((p) => p.enabledModels.includes(modelId))) {
          return c.json({ error: "That model isn't an enabled model of the connected provider." }, 400);
        }
        patch.model = model;
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
    if (body.skills !== undefined) {
      const parsed = parseSkills(body.skills);
      if (!parsed.ok) return c.json({ error: parsed.error }, 400);
      patch.skills = parsed.value;
    }
    if (body.costCap !== undefined) {
      const parsed = parseCostCap(body.costCap);
      if (!parsed.ok) return c.json({ error: parsed.error }, 400);
      patch.costCap = parsed.value;
    }

    // NOTE (Story 5.1): the general PATCH deliberately does NOT read `body.state` — promotion is a
    // gated action via POST /agents/:id/activate, not a self-editable field.
    const agent = await repo.update(c.req.param("id"), patch);
    if (!agent) return c.json({ error: "That agent doesn't exist." }, 404);
    return c.json({ agent });
  });

  // Deliberate, server-enforced promotion (Story 5.1, FR-5/AD-7). A mis-configured agent can never be
  // activated — the gate is authoritative here; the web disable is UX only.
  app.post("/agents/:id/activate", async (c) => {
    const agent = await repo.get(c.req.param("id"));
    if (!agent) return c.json({ error: "That agent doesn't exist." }, 404);
    const blockers = activationBlockers(agent, await modelProviderConnected(agent.model, connectionsRepo));
    if (blockers.length > 0) return c.json({ error: blockers[0], blockers }, 400);
    const updated = await repo.update(c.req.param("id"), { state: "active" });
    return c.json({ agent: updated });
  });

  // Deactivate returns an Active agent to Draft. Deactivating a Draft is a harmless no-op → Draft.
  app.post("/agents/:id/deactivate", async (c) => {
    const agent = await repo.get(c.req.param("id"));
    if (!agent) return c.json({ error: "That agent doesn't exist." }, 404);
    const updated = await repo.update(c.req.param("id"), { state: "draft" });
    return c.json({ agent: updated });
  });

  return app;
}
