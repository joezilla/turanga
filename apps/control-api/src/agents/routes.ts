import { Hono } from "hono";
import { ulid, activationBlockers, DEFAULT_MEMORY_CONFIG, MEMORY_KINDS, type MemoryConfig, type MemoryKind } from "@turanga/domain";
import { toView, type AgentsRepo, type AgentRow, type AgentPatch, type AgentVariable, type AttachedSkill, type AttachedTool, type CostCap, type Money } from "./repo.js";
import type { ConnectionsRepo } from "../connections/repo.js";
import type { ToolsRepo } from "../tools/repo.js";
import type { SessionVars } from "../auth/guard.js";

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
const MAX_DESCRIPTION_LEN = 300;
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

// Attached tools (Story 6.3). The Skills analogue, but a grant is an operation ALLOW-LIST, not a scope
// enum — and it's validated against what the tool actually offers (its discovered `operations`), not a
// static set. Default-deny: an empty `operations` is valid (attached but ungranted) and grants nothing.
// Enforcement lands in 6.4 (the Guard). Async because each toolId is resolved via the tools repo.
const MAX_ATTACHED_TOOLS = 50;
async function parseTools(input: unknown, toolsRepo: ToolsRepo): Promise<{ ok: true; value: AttachedTool[] } | { ok: false; error: string }> {
  if (!Array.isArray(input)) return { ok: false, error: "Tools must be a list." };
  if (input.length > MAX_ATTACHED_TOOLS) return { ok: false, error: "Too many tools." };
  const seen = new Set<string>();
  const out: AttachedTool[] = [];
  for (const item of input) {
    if (item === null || typeof item !== "object") {
      return { ok: false, error: "Each attached tool must be an object." };
    }
    const t = item as { toolId?: unknown; operations?: unknown };
    if (typeof t.toolId !== "string" || !t.toolId) return { ok: false, error: "Each attached tool needs a toolId." };
    if (seen.has(t.toolId)) return { ok: false, error: "A tool is attached more than once." };
    seen.add(t.toolId);
    const tool = await toolsRepo.getTool(t.toolId);
    if (!tool) return { ok: false, error: "Unknown tool." };
    if (!Array.isArray(t.operations)) return { ok: false, error: "A tool's operations must be a list." };
    const offered = new Set(tool.operations.map((o) => o.name));
    const ops: string[] = [];
    for (const op of t.operations) {
      if (typeof op !== "string") return { ok: false, error: "An operation grant must be a name." };
      if (!offered.has(op)) return { ok: false, error: `Operation "${op}" isn't offered by tool "${tool.name}".` };
      if (!ops.includes(op)) ops.push(op); // de-dupe within a tool
    }
    out.push({ toolId: t.toolId, operations: ops });
  }
  return { ok: true, value: out };
}

// Per-agent memory config (Story 8.2). Operational config (NOT a published field) — saving it never
// makes an agent dirty. mode ∈ {inherit,on,off}; recall/reflect independent booleans; kinds ⊆ the three
// memory kinds (deduped). Enforcement of the resolved config is 8.3/8.4 (the run path); this only validates.
const MEMORY_MODES = new Set(["inherit", "on", "off"]);
function parseMemoryConfig(input: unknown): { ok: true; value: MemoryConfig } | { ok: false; error: string } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "Memory config must be an object." };
  const m = input as { mode?: unknown; recall?: unknown; reflect?: unknown; kinds?: unknown; requireApproval?: unknown };
  if (typeof m.mode !== "string" || !MEMORY_MODES.has(m.mode)) return { ok: false, error: "Memory mode must be inherit, on, or off." };
  if (typeof m.recall !== "boolean") return { ok: false, error: "recall must be true or false." };
  if (typeof m.reflect !== "boolean") return { ok: false, error: "reflect must be true or false." };
  if (m.requireApproval !== undefined && typeof m.requireApproval !== "boolean") return { ok: false, error: "requireApproval must be true or false." };
  if (!Array.isArray(m.kinds)) return { ok: false, error: "Memory kinds must be a list." };
  const allowed = new Set<string>(MEMORY_KINDS);
  const seen = new Set<MemoryKind>();
  for (const k of m.kinds) {
    if (typeof k !== "string" || !allowed.has(k)) return { ok: false, error: `Unknown memory kind "${String(k)}".` };
    seen.add(k as MemoryKind);
  }
  // Store in canonical MEMORY_KINDS order (kinds is a SET) — de-dupes AND keeps the stored order stable
  // so the editor's dirty check doesn't flag a re-ordered-but-equal set as an unsaved change (52f1c84).
  const kinds: MemoryKind[] = MEMORY_KINDS.filter((k) => seen.has(k));
  return { ok: true, value: { mode: m.mode as MemoryConfig["mode"], recall: m.recall, reflect: m.reflect, kinds, requireApproval: m.requireApproval ?? false } };
}

export function agentRoutes(repo: AgentsRepo, connectionsRepo: ConnectionsRepo, toolsRepo: ToolsRepo) {
  const app = new Hono<{ Variables: SessionVars }>();

  app.get("/agents", async (c) => c.json({ agents: await repo.list() }));

  app.post("/agents", async (c) => {
    // `?? {}` guards a body of literal `null` (valid JSON, so .catch never fires).
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { name?: unknown };
    const trimmed = typeof body.name === "string" ? body.name.trim() : "";
    const name = (trimmed || "Untitled agent").slice(0, MAX_NAME_LEN);
    const row: AgentRow = { id: ulid(Date.now()), name, description: "", state: "draft", model: null, instructions: "", variables: [], skills: [], attachedTools: [], costCap: { perRun: null, perDay: null }, memoryConfig: DEFAULT_MEMORY_CONFIG, publishedVersion: null, publishedAt: null, createdAt: new Date().toISOString() };
    await repo.create(row);
    // A brand-new agent has never been published, so everything about it is unpublished.
    return c.json({ agent: toView(row, null) }, 201);
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
      description?: unknown;
      model?: unknown;
      instructions?: unknown;
      variables?: unknown;
      skills?: unknown;
      attachedTools?: unknown;
      costCap?: unknown;
      memoryConfig?: unknown;
    };
    const patch: AgentPatch = {};

    if (body.name !== undefined) {
      if (typeof body.name !== "string" || !body.name.trim()) {
        return c.json({ error: "A name can't be empty." }, 400);
      }
      patch.name = body.name.trim().slice(0, MAX_NAME_LEN);
    }
    if (body.description !== undefined) {
      if (typeof body.description !== "string") {
        return c.json({ error: "A description must be text." }, 400);
      }
      patch.description = body.description.slice(0, MAX_DESCRIPTION_LEN); // empty is allowed
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
    if (body.attachedTools !== undefined) {
      const parsed = await parseTools(body.attachedTools, toolsRepo);
      if (!parsed.ok) return c.json({ error: parsed.error }, 400);
      patch.attachedTools = parsed.value;
    }
    if (body.costCap !== undefined) {
      const parsed = parseCostCap(body.costCap);
      if (!parsed.ok) return c.json({ error: parsed.error }, 400);
      patch.costCap = parsed.value;
    }
    if (body.memoryConfig !== undefined) {
      const parsed = parseMemoryConfig(body.memoryConfig);
      if (!parsed.ok) return c.json({ error: parsed.error }, 400);
      patch.memoryConfig = parsed.value; // operational — never sets `dirty` (not in PUBLISHED_FIELDS)
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

  // Snapshot the working draft as the next immutable version. Publishing is NOT gated the way
  // Activate is: a version is a record of what the definition said, and an incomplete definition
  // is still worth recording. The activation gate remains the thing that stops a broken agent
  // from going live. Republishing an unchanged draft is refused rather than silently no-op'd, so
  // the version numbers a user sees always correspond to a real change.
  app.post("/agents/:id/publish", async (c) => {
    // requireSession stashes the session email; it is always set on this route.
    const result = await repo.publish(c.req.param("id"), c.get("sessionEmail") ?? null);
    if (result.ok) return c.json({ agent: result.agent, version: result.version });
    if (result.reason === "not-found") return c.json({ error: "That agent doesn't exist." }, 404);
    return c.json({ error: "There are no unpublished changes to publish." }, 400);
  });

  // Publish history, newest first. Each entry carries the full snapshot, so a future
  // "restore this version" story can diff or re-apply without another round trip.
  app.get("/agents/:id/versions", async (c) => {
    const agent = await repo.get(c.req.param("id"));
    if (!agent) return c.json({ error: "That agent doesn't exist." }, 404);
    return c.json({ versions: await repo.listVersions(c.req.param("id")) });
  });

  // Copy a definition into a new, never-published draft. The copy never inherits Active state:
  // an agent going live is always a deliberate act on that agent.
  app.post("/agents/:id/duplicate", async (c) => {
    const source = await repo.get(c.req.param("id"));
    if (!source) return c.json({ error: "That agent doesn't exist." }, 404);
    // Trim the base first so the " copy" suffix always survives (a 200-char source name would
    // otherwise have the suffix sliced back off, making the copy name-identical to the source).
    const SUFFIX = " copy";
    const name = `${source.name.slice(0, MAX_NAME_LEN - SUFFIX.length)}${SUFFIX}`;
    const copy = await repo.duplicate(c.req.param("id"), ulid(Date.now()), name, new Date().toISOString());
    if (!copy) return c.json({ error: "That agent doesn't exist." }, 404);
    return c.json({ agent: copy }, 201);
  });

  return app;
}
