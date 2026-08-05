import { describe, it, expect } from "vitest";
import { createApp } from "../app.js";
import { memoryAuthRepo, type AuthRepo } from "../auth/repo.js";
import { memoryAgentsRepo } from "./repo.js";
import { memoryConnectionsRepo, type ConnectionsRepo } from "../connections/repo.js";
import { memoryToolsRepo, type ToolsRepo } from "../tools/repo.js";
import { hashPassword } from "../auth/password.js";
import { ulid } from "@turanga/domain";

const EMAIL = "admin@turanga.local";
const PW = "pw-for-tests-123456";
const jsonPost = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const jsonPatch = (body: unknown) => ({ method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function createAgent(app: Awaited<ReturnType<typeof appWithSession>>["app"], cookie: string, name?: string) {
  const res = await app.request("/agents", { ...jsonPost(name ? { name } : {}), headers: { "content-type": "application/json", cookie } });
  return ((await res.json()) as { agent: { id: string } }).agent;
}

// The login rate-limiter keys on x-forwarded-for (falling back to a shared "local" bucket),
// so give each test session a distinct client IP — otherwise many logins in one run trip the
// per-client limit (a real deployment sees distinct clients).
let clientSeq = 0;
async function appWithSession(opts: { connectionsRepo?: ConnectionsRepo; toolsRepo?: ToolsRepo } = {}) {
  const authRepo: AuthRepo = memoryAuthRepo();
  await authRepo.createUser({ id: ulid(1), email: EMAIL, passwordHash: await hashPassword(PW) });
  const agentsRepo = memoryAgentsRepo();
  const app = createApp({ authRepo, agentsRepo, connectionsRepo: opts.connectionsRepo, toolsRepo: opts.toolsRepo });
  const ip = `10.0.0.${clientSeq++}`;
  const login = await app.request("/auth/login", {
    ...jsonPost({ email: EMAIL, password: PW }),
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  return { app, cookie, agentsRepo };
}

// A tools repo with one connected tool exposing two operations (so per-operation grant validation
// has a real target — Story 6.3).
async function connectedTools(): Promise<ToolsRepo> {
  const repo = memoryToolsRepo();
  await repo.createTool({
    id: "tool-weather",
    name: "Weather",
    endpoint: "remote",
    status: "connected",
    lastError: null,
    url: "https://mcp.example/mcp",
    encCredential: null,
    operations: [{ name: "get_weather" }, { name: "get_forecast" }],
    createdAt: new Date().toISOString(),
  });
  return repo;
}

// A connections repo with one CONNECTED openai provider (so a model "openai/..." passes the
// provider-connected half of the Activate gate).
async function connectedProviders(): Promise<ConnectionsRepo> {
  const repo = memoryConnectionsRepo();
  await repo.createProvider({ id: ulid(2), provider: "openai", name: "OpenAI", baseUrl: null, keyLast4: "abcd", status: "connected", lastError: null, models: ["gpt-4o"], enabledModels: ["gpt-4o"], litellmModelIds: ["m1"] });
  return repo;
}
// Fully configure an agent (model + both caps) via the general PATCH.
async function configure(app: Awaited<ReturnType<typeof appWithSession>>["app"], cookie: string, id: string) {
  await app.request(`/agents/${id}`, {
    ...jsonPatch({ model: "openai/gpt-4o", costCap: { perRun: { minor: 50, currency: "USD" }, perDay: { minor: 500, currency: "USD" } } }),
    headers: { "content-type": "application/json", cookie },
  });
}

describe("agents guard", () => {
  it("rejects GET /agents without a session (401)", async () => {
    const { app } = await appWithSession();
    expect((await app.request("/agents")).status).toBe(401);
  });
  it("rejects POST /agents without a session (401)", async () => {
    const { app } = await appWithSession();
    expect((await app.request("/agents", jsonPost({}))).status).toBe(401);
  });
  it("allows GET /agents with a session (200, empty)", async () => {
    const { app, cookie } = await appWithSession();
    const res = await app.request("/agents", { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { agents: unknown[] }).agents).toEqual([]);
  });
});

describe("create an agent", () => {
  it("creates a Draft agent with the default name and no model (201)", async () => {
    const { app, cookie } = await appWithSession();
    const res = await app.request("/agents", { ...jsonPost({}), headers: { "content-type": "application/json", cookie } });
    expect(res.status).toBe(201);
    const a = ((await res.json()) as { agent: any }).agent;
    expect(a.state).toBe("draft");
    expect(a.name).toBe("Untitled agent");
    expect(a.model).toBeNull(); // no model until selected (Story 3.2)
    expect(a.instructions).toBe(""); // Story 3.3 defaults
    expect(a.variables).toEqual([]);
    expect(a.skills).toEqual([]); // Story 3.4 default
    expect(a.costCap).toEqual({ perRun: null, perDay: null }); // Story 3.5 default
    expect(a.id).toHaveLength(26); // ULID
    expect(a.createdAt).toBeTruthy();
  });

  it("treats a JSON body of literal null as no name (201, default) — no 500", async () => {
    const { app, cookie } = await appWithSession();
    const res = await app.request("/agents", { method: "POST", headers: { "content-type": "application/json", cookie }, body: "null" });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { agent: any }).agent.name).toBe("Untitled agent");
  });

  it("caps an oversized name at 200 chars", async () => {
    const { app, cookie } = await appWithSession();
    const res = await app.request("/agents", { ...jsonPost({ name: "x".repeat(5000) }), headers: { "content-type": "application/json", cookie } });
    expect(((await res.json()) as { agent: any }).agent.name).toHaveLength(200);
  });

  it("trims a provided name and falls back to the default when blank", async () => {
    const { app, cookie } = await appWithSession();
    const named = ((await (await app.request("/agents", { ...jsonPost({ name: "  Portfolio  " }), headers: { "content-type": "application/json", cookie } })).json()) as { agent: any }).agent;
    expect(named.name).toBe("Portfolio");
    const blank = ((await (await app.request("/agents", { ...jsonPost({ name: "   " }), headers: { "content-type": "application/json", cookie } })).json()) as { agent: any }).agent;
    expect(blank.name).toBe("Untitled agent");
  });

  it("lists created agents newest-first", async () => {
    const { app, cookie } = await appWithSession();
    await app.request("/agents", { ...jsonPost({ name: "first" }), headers: { "content-type": "application/json", cookie } });
    await app.request("/agents", { ...jsonPost({ name: "second" }), headers: { "content-type": "application/json", cookie } });
    const list = ((await (await app.request("/agents", { headers: { cookie } })).json()) as { agents: { name: string }[] }).agents;
    expect(list.map((a) => a.name)).toEqual(["second", "first"]);
  });

  it("exposes no write path from the web beyond POST /agents — the repo is the only writer (AD-7)", async () => {
    // The web has no direct DB access; the sole mutation surface is the guarded POST above.
    const { agentsRepo } = await appWithSession();
    expect(typeof agentsRepo.create).toBe("function");
    expect(await agentsRepo.list()).toEqual([]);
  });
});

describe("agent detail (GET /agents/:id)", () => {
  it("401 without a session", async () => {
    const { app } = await appWithSession();
    expect((await app.request("/agents/whatever")).status).toBe(401);
  });
  it("returns the agent with a session (200)", async () => {
    const { app, cookie } = await appWithSession();
    const created = await createAgent(app, cookie, "Portfolio");
    const res = await app.request(`/agents/${created.id}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const a = ((await res.json()) as { agent: any }).agent;
    expect(a.id).toBe(created.id);
    expect(a.name).toBe("Portfolio");
    expect(a.model).toBeNull();
  });
  it("404 for an unknown id", async () => {
    const { app, cookie } = await appWithSession();
    expect((await app.request("/agents/nope", { headers: { cookie } })).status).toBe(404);
  });
});

describe("agent autosave (PATCH /agents/:id)", () => {
  it("401 without a session", async () => {
    const { app } = await appWithSession();
    expect((await app.request("/agents/x", jsonPatch({ model: "openai/gpt-4o" }))).status).toBe(401);
  });

  it("persists a selected model and returns the updated agent (200)", async () => {
    const { app, cookie } = await appWithSession();
    const created = await createAgent(app, cookie);
    const res = await app.request(`/agents/${created.id}`, { ...jsonPatch({ model: "openai/gpt-4o" }), headers: { "content-type": "application/json", cookie } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { agent: any }).agent.model).toBe("openai/gpt-4o");
    // durable: a follow-up GET reflects it
    const got = ((await (await app.request(`/agents/${created.id}`, { headers: { cookie } })).json()) as { agent: any }).agent;
    expect(got.model).toBe("openai/gpt-4o");
  });

  it("trims and caps the model string; null clears it", async () => {
    const { app, cookie } = await appWithSession();
    const created = await createAgent(app, cookie);
    const trimmed = ((await (await app.request(`/agents/${created.id}`, { ...jsonPatch({ model: "  openai/gpt-4o  " }), headers: { "content-type": "application/json", cookie } })).json()) as { agent: any }).agent;
    expect(trimmed.model).toBe("openai/gpt-4o");
    const capped = ((await (await app.request(`/agents/${created.id}`, { ...jsonPatch({ model: "x".repeat(5000) }), headers: { "content-type": "application/json", cookie } })).json()) as { agent: any }).agent;
    expect(capped.model).toHaveLength(200);
    const cleared = ((await (await app.request(`/agents/${created.id}`, { ...jsonPatch({ model: null }), headers: { "content-type": "application/json", cookie } })).json()) as { agent: any }).agent;
    expect(cleared.model).toBeNull();
  });

  it("renames via autosave; trims and rejects an empty name (400)", async () => {
    const { app, cookie } = await appWithSession();
    const created = await createAgent(app, cookie);
    const renamed = ((await (await app.request(`/agents/${created.id}`, { ...jsonPatch({ name: "  Stocks  " }), headers: { "content-type": "application/json", cookie } })).json()) as { agent: any }).agent;
    expect(renamed.name).toBe("Stocks");
    const bad = await app.request(`/agents/${created.id}`, { ...jsonPatch({ name: "   " }), headers: { "content-type": "application/json", cookie } });
    expect(bad.status).toBe(400);
  });

  it("leaves omitted fields untouched (name-only patch keeps the model)", async () => {
    const { app, cookie } = await appWithSession();
    const created = await createAgent(app, cookie);
    await app.request(`/agents/${created.id}`, { ...jsonPatch({ model: "anthropic/claude-sonnet-5" }), headers: { "content-type": "application/json", cookie } });
    const after = ((await (await app.request(`/agents/${created.id}`, { ...jsonPatch({ name: "Renamed" }), headers: { "content-type": "application/json", cookie } })).json()) as { agent: any }).agent;
    expect(after.name).toBe("Renamed");
    expect(after.model).toBe("anthropic/claude-sonnet-5"); // untouched
  });

  it("404 patching an unknown id", async () => {
    const { app, cookie } = await appWithSession();
    expect((await app.request("/agents/nope", { ...jsonPatch({ model: "openai/gpt-4o" }), headers: { "content-type": "application/json", cookie } })).status).toBe(404);
  });
});

describe("agent instructions + variables (PATCH, Story 3.3)", () => {
  const patchReq = (app: Awaited<ReturnType<typeof appWithSession>>["app"], cookie: string, id: string, body: unknown) =>
    app.request(`/agents/${id}`, { ...jsonPatch(body), headers: { "content-type": "application/json", cookie } });

  it("persists instructions (empty allowed) and caps at 20000", async () => {
    const { app, cookie } = await appWithSession();
    const created = await createAgent(app, cookie);
    const set = ((await (await patchReq(app, cookie, created.id, { instructions: "Watch {portfolio}." })).json()) as { agent: any }).agent;
    expect(set.instructions).toBe("Watch {portfolio}.");
    const cleared = ((await (await patchReq(app, cookie, created.id, { instructions: "" })).json()) as { agent: any }).agent;
    expect(cleared.instructions).toBe(""); // empty is a valid value
    const capped = ((await (await patchReq(app, cookie, created.id, { instructions: "x".repeat(50000) })).json()) as { agent: any }).agent;
    expect(capped.instructions).toHaveLength(20000);
  });

  it("rejects non-string instructions (400)", async () => {
    const { app, cookie } = await appWithSession();
    const created = await createAgent(app, cookie);
    expect((await patchReq(app, cookie, created.id, { instructions: 42 })).status).toBe(400);
  });

  it("persists a valid variables array and returns it (durable)", async () => {
    const { app, cookie } = await appWithSession();
    const created = await createAgent(app, cookie);
    const vars = [{ name: "portfolio", value: "AAPL, MSFT" }, { name: "risk_level", value: "low" }];
    const set = ((await (await patchReq(app, cookie, created.id, { variables: vars })).json()) as { agent: any }).agent;
    expect(set.variables).toEqual(vars);
    const got = ((await (await app.request(`/agents/${created.id}`, { headers: { cookie } })).json()) as { agent: any }).agent;
    expect(got.variables).toEqual(vars);
  });

  it("rejects a bad name, a duplicate name, an over-cap array, a non-string value, and a non-array (400)", async () => {
    const { app, cookie } = await appWithSession();
    const created = await createAgent(app, cookie);
    expect((await patchReq(app, cookie, created.id, { variables: [{ name: "1bad", value: "x" }] })).status).toBe(400);
    expect((await patchReq(app, cookie, created.id, { variables: [{ name: "bad-dash", value: "x" }] })).status).toBe(400);
    expect((await patchReq(app, cookie, created.id, { variables: [{ name: "dup", value: "a" }, { name: "dup", value: "b" }] })).status).toBe(400);
    expect((await patchReq(app, cookie, created.id, { variables: [{ name: "ok", value: 5 }] })).status).toBe(400);
    const many = Array.from({ length: 51 }, (_, i) => ({ name: `v${i}`, value: "x" }));
    expect((await patchReq(app, cookie, created.id, { variables: many })).status).toBe(400);
    expect((await patchReq(app, cookie, created.id, { variables: "nope" })).status).toBe(400);
    expect((await patchReq(app, cookie, created.id, { variables: [null] })).status).toBe(400); // no 500
    expect((await patchReq(app, cookie, created.id, { variables: ["notobj"] })).status).toBe(400);
  });

  it("caps variable values at 2000 chars", async () => {
    const { app, cookie } = await appWithSession();
    const created = await createAgent(app, cookie);
    const set = ((await (await patchReq(app, cookie, created.id, { variables: [{ name: "big", value: "y".repeat(9000) }] })).json()) as { agent: any }).agent;
    expect(set.variables[0].value).toHaveLength(2000);
  });

  it("401 without a session", async () => {
    const { app } = await appWithSession();
    expect((await app.request("/agents/x", jsonPatch({ instructions: "hi" }))).status).toBe(401);
  });
});

describe("agent skills + permissions (PATCH, Story 3.4)", () => {
  const patchReq = (app: Awaited<ReturnType<typeof appWithSession>>["app"], cookie: string, id: string, body: unknown) =>
    app.request(`/agents/${id}`, { ...jsonPatch(body), headers: { "content-type": "application/json", cookie } });

  it("persists a valid skills array (durable)", async () => {
    const { app, cookie } = await appWithSession();
    const created = await createAgent(app, cookie);
    const skills = [
      { skill: "read-search", scope: "read", send: false },
      { skill: "draft-reply", scope: "read-write", send: true },
    ];
    const set = ((await (await patchReq(app, cookie, created.id, { skills })).json()) as { agent: any }).agent;
    expect(set.skills).toEqual(skills);
    const got = ((await (await app.request(`/agents/${created.id}`, { headers: { cookie } })).json()) as { agent: any }).agent;
    expect(got.skills).toEqual(skills);
  });

  it("defaults new agents to no skills", async () => {
    const { app, cookie } = await appWithSession();
    const created = await createAgent(app, cookie);
    const got = ((await (await app.request(`/agents/${created.id}`, { headers: { cookie } })).json()) as { agent: any }).agent;
    expect(got.skills).toEqual([]);
  });

  it("forces send off for a non-outbound skill, allows it on draft-reply", async () => {
    const { app, cookie } = await appWithSession();
    const created = await createAgent(app, cookie);
    const set = ((await (await patchReq(app, cookie, created.id, {
      skills: [
        { skill: "read-search", scope: "read", send: true }, // send requested on a non-outbound skill
        { skill: "draft-reply", scope: "none", send: true },
      ],
    })).json()) as { agent: any }).agent;
    expect(set.skills.find((s: any) => s.skill === "read-search").send).toBe(false); // normalized off
    expect(set.skills.find((s: any) => s.skill === "draft-reply").send).toBe(true); // outbound may send
  });

  it("rejects unknown skill / unknown scope / non-boolean send / duplicate / over-cap / non-array (400)", async () => {
    const { app, cookie } = await appWithSession();
    const created = await createAgent(app, cookie);
    expect((await patchReq(app, cookie, created.id, { skills: [{ skill: "nope", scope: "read", send: false }] })).status).toBe(400);
    expect((await patchReq(app, cookie, created.id, { skills: [{ skill: "read-search", scope: "admin", send: false }] })).status).toBe(400);
    expect((await patchReq(app, cookie, created.id, { skills: [{ skill: "read-search", scope: "read", send: "yes" }] })).status).toBe(400);
    expect((await patchReq(app, cookie, created.id, { skills: [{ skill: "read-search", scope: "read", send: false }, { skill: "read-search", scope: "none", send: false }] })).status).toBe(400);
    const many = ["read-search", "draft-reply", "flag-label", "summarize", "read-search"].map((skill) => ({ skill, scope: "none", send: false }));
    expect((await patchReq(app, cookie, created.id, { skills: many })).status).toBe(400);
    expect((await patchReq(app, cookie, created.id, { skills: [null] })).status).toBe(400);
    expect((await patchReq(app, cookie, created.id, { skills: "nope" })).status).toBe(400);
  });

  it("401 without a session", async () => {
    const { app } = await appWithSession();
    expect((await app.request("/agents/x", jsonPatch({ skills: [] }))).status).toBe(401);
  });
});

describe("agent attached tools + per-operation grants (PATCH, Story 6.3)", () => {
  const patchReq = (app: Awaited<ReturnType<typeof appWithSession>>["app"], cookie: string, id: string, body: unknown) =>
    app.request(`/agents/${id}`, { ...jsonPatch(body), headers: { "content-type": "application/json", cookie } });

  it("persists per-operation grants and round-trips them (durable, AD-7)", async () => {
    const { app, cookie } = await appWithSession({ toolsRepo: await connectedTools() });
    const created = await createAgent(app, cookie);
    const attachedTools = [{ toolId: "tool-weather", operations: ["get_weather"] }];
    const set = ((await (await patchReq(app, cookie, created.id, { attachedTools })).json()) as { agent: any }).agent;
    expect(set.attachedTools).toEqual(attachedTools);
    const got = ((await (await app.request(`/agents/${created.id}`, { headers: { cookie } })).json()) as { agent: any }).agent;
    expect(got.attachedTools).toEqual(attachedTools);
  });

  it("defaults new agents to no attached tools", async () => {
    const { app, cookie } = await appWithSession({ toolsRepo: await connectedTools() });
    const created = await createAgent(app, cookie);
    const got = ((await (await app.request(`/agents/${created.id}`, { headers: { cookie } })).json()) as { agent: any }).agent;
    expect(got.attachedTools).toEqual([]);
  });

  it("accepts an attached-but-ungranted tool (empty operations = default-deny)", async () => {
    const { app, cookie } = await appWithSession({ toolsRepo: await connectedTools() });
    const created = await createAgent(app, cookie);
    const res = await patchReq(app, cookie, created.id, { attachedTools: [{ toolId: "tool-weather", operations: [] }] });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { agent: any }).agent.attachedTools).toEqual([{ toolId: "tool-weather", operations: [] }]);
  });

  it("de-dupes repeated operation names within a tool", async () => {
    const { app, cookie } = await appWithSession({ toolsRepo: await connectedTools() });
    const created = await createAgent(app, cookie);
    const set = ((await (await patchReq(app, cookie, created.id, { attachedTools: [{ toolId: "tool-weather", operations: ["get_weather", "get_weather"] }] })).json()) as { agent: any }).agent;
    expect(set.attachedTools).toEqual([{ toolId: "tool-weather", operations: ["get_weather"] }]);
  });

  it("rejects unknown tool / unoffered operation / duplicate tool / non-array (400)", async () => {
    const { app, cookie } = await appWithSession({ toolsRepo: await connectedTools() });
    const created = await createAgent(app, cookie);
    // unknown toolId
    expect((await patchReq(app, cookie, created.id, { attachedTools: [{ toolId: "nope", operations: [] }] })).status).toBe(400);
    // an operation the tool doesn't offer
    expect((await patchReq(app, cookie, created.id, { attachedTools: [{ toolId: "tool-weather", operations: ["delete_everything"] }] })).status).toBe(400);
    // same tool attached twice
    expect((await patchReq(app, cookie, created.id, { attachedTools: [{ toolId: "tool-weather", operations: [] }, { toolId: "tool-weather", operations: ["get_weather"] }] })).status).toBe(400);
    // not a list / bad shapes
    expect((await patchReq(app, cookie, created.id, { attachedTools: "nope" })).status).toBe(400);
    expect((await patchReq(app, cookie, created.id, { attachedTools: [null] })).status).toBe(400);
    expect((await patchReq(app, cookie, created.id, { attachedTools: [{ toolId: "tool-weather", operations: "get_weather" }] })).status).toBe(400);
    // the failed patches persisted nothing
    const got = ((await (await app.request(`/agents/${created.id}`, { headers: { cookie } })).json()) as { agent: any }).agent;
    expect(got.attachedTools).toEqual([]);
  });
});

describe("agent cost caps (PATCH, Story 3.5)", () => {
  const patchReq = (app: Awaited<ReturnType<typeof appWithSession>>["app"], cookie: string, id: string, body: unknown) =>
    app.request(`/agents/${id}`, { ...jsonPatch(body), headers: { "content-type": "application/json", cookie } });

  it("persists a valid per-run + per-day cap (durable)", async () => {
    const { app, cookie } = await appWithSession();
    const created = await createAgent(app, cookie);
    const costCap = { perRun: { minor: 50, currency: "USD" }, perDay: { minor: 500, currency: "USD" } };
    const set = ((await (await patchReq(app, cookie, created.id, { costCap })).json()) as { agent: any }).agent;
    expect(set.costCap).toEqual(costCap);
    const got = ((await (await app.request(`/agents/${created.id}`, { headers: { cookie } })).json()) as { agent: any }).agent;
    expect(got.costCap).toEqual(costCap);
  });

  it("accepts a null side (an unset cap)", async () => {
    const { app, cookie } = await appWithSession();
    const created = await createAgent(app, cookie);
    const set = ((await (await patchReq(app, cookie, created.id, { costCap: { perRun: { minor: 100, currency: "USD" }, perDay: null } })).json()) as { agent: any }).agent;
    expect(set.costCap).toEqual({ perRun: { minor: 100, currency: "USD" }, perDay: null });
  });

  it("rejects a non-object, non-integer/negative/over-cap minor, and a bad currency (400)", async () => {
    const { app, cookie } = await appWithSession();
    const created = await createAgent(app, cookie);
    expect((await patchReq(app, cookie, created.id, { costCap: "nope" })).status).toBe(400);
    expect((await patchReq(app, cookie, created.id, { costCap: { perRun: { minor: 1.5, currency: "USD" }, perDay: null } })).status).toBe(400);
    expect((await patchReq(app, cookie, created.id, { costCap: { perRun: { minor: -1, currency: "USD" }, perDay: null } })).status).toBe(400);
    expect((await patchReq(app, cookie, created.id, { costCap: { perRun: { minor: 99_999_999_999, currency: "USD" }, perDay: null } })).status).toBe(400);
    expect((await patchReq(app, cookie, created.id, { costCap: { perRun: { minor: 50, currency: "usd" }, perDay: null } })).status).toBe(400);
    expect((await patchReq(app, cookie, created.id, { costCap: { perRun: { minor: 50, currency: "EUR" }, perDay: null } })).status).toBe(400); // MVP: USD only
    expect((await patchReq(app, cookie, created.id, { costCap: [] })).status).toBe(400); // array is not a valid cost-cap object
    expect((await patchReq(app, cookie, created.id, { costCap: { perRun: 5, perDay: null } })).status).toBe(400);
    expect((await patchReq(app, cookie, created.id, { costCap: { perRun: null } })).status).toBe(200); // perDay missing → treated as null
  });

  it("401 without a session", async () => {
    const { app } = await appWithSession();
    expect((await app.request("/agents/x", jsonPatch({ costCap: { perRun: null, perDay: null } }))).status).toBe(401);
  });
});

describe("activate / deactivate lifecycle (Story 5.1)", () => {
  const post = (cookie: string) => ({ method: "POST", headers: { cookie } });

  it("blocks Activate with a stated reason when the model / caps are missing (400)", async () => {
    const { app, cookie } = await appWithSession({ connectionsRepo: await connectedProviders() });
    const agent = await createAgent(app, cookie);
    const res = await app.request(`/agents/${agent.id}/activate`, post(cookie));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; blockers: string[] };
    expect(body.blockers).toContain("Select a model.");
    expect(body.blockers).toContain("Set a per-run cost cap.");
    expect(body.blockers).toContain("Set a per-day cost cap.");
  });

  it("blocks Activate when the model's provider isn't connected (400, stated reason)", async () => {
    const { app, cookie } = await appWithSession(); // no connected providers
    const agent = await createAgent(app, cookie);
    await configure(app, cookie, agent.id); // model + both caps, but provider not connected
    const res = await app.request(`/agents/${agent.id}/activate`, post(cookie));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/provider isn't connected/i);
  });

  it("activates a fully-configured Draft with a connected provider (200, state=active)", async () => {
    const { app, cookie } = await appWithSession({ connectionsRepo: await connectedProviders() });
    const agent = await createAgent(app, cookie);
    await configure(app, cookie, agent.id);
    const res = await app.request(`/agents/${agent.id}/activate`, post(cookie));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { agent: { state: string } }).agent.state).toBe("active");
  });

  it("Deactivate returns an Active agent to Draft (200, state=draft)", async () => {
    const { app, cookie } = await appWithSession({ connectionsRepo: await connectedProviders() });
    const agent = await createAgent(app, cookie);
    await configure(app, cookie, agent.id);
    await app.request(`/agents/${agent.id}/activate`, post(cookie));
    const res = await app.request(`/agents/${agent.id}/deactivate`, post(cookie));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { agent: { state: string } }).agent.state).toBe("draft");
  });

  it("the general PATCH cannot self-promote (state in the body is ignored)", async () => {
    const { app, cookie } = await appWithSession({ connectionsRepo: await connectedProviders() });
    const agent = await createAgent(app, cookie);
    await configure(app, cookie, agent.id);
    // A crafted PATCH with state: "active" must NOT flip the state.
    const res = await app.request(`/agents/${agent.id}`, { ...jsonPatch({ state: "active", name: "x" }), headers: { "content-type": "application/json", cookie } });
    expect(((await res.json()) as { agent: { state: string } }).agent.state).toBe("draft");
  });

  it("404 for activate/deactivate of a missing agent", async () => {
    const { app, cookie } = await appWithSession({ connectionsRepo: await connectedProviders() });
    expect((await app.request("/agents/nope/activate", post(cookie))).status).toBe(404);
    expect((await app.request("/agents/nope/deactivate", post(cookie))).status).toBe(404);
  });
});

describe("agent model validation against enabled models (Story 2.4)", () => {
  it("accepts an enabled model of a connected provider; rejects a non-enabled one (400)", async () => {
    const { app, cookie } = await appWithSession({ connectionsRepo: await connectedProviders() }); // openai connected, enabled: ["gpt-4o"]
    const agent = await createAgent(app, cookie);
    const ok = await app.request(`/agents/${agent.id}`, { ...jsonPatch({ model: "openai/gpt-4o" }), headers: { "content-type": "application/json", cookie } });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { agent: { model: string } }).agent.model).toBe("openai/gpt-4o");
    // gpt-4o-mini exists in the provider's catalog conceptually but is NOT enabled here → rejected.
    const bad = await app.request(`/agents/${agent.id}`, { ...jsonPatch({ model: "openai/gpt-4o-mini" }), headers: { "content-type": "application/json", cookie } });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/enabled model of the connected provider/i);
  });

  it("allows a model whose provider kind isn't connected (set-now, connect-later)", async () => {
    const { app, cookie } = await appWithSession({ connectionsRepo: await connectedProviders() }); // only openai connected
    const agent = await createAgent(app, cookie);
    const res = await app.request(`/agents/${agent.id}`, { ...jsonPatch({ model: "anthropic/claude-sonnet-4" }), headers: { "content-type": "application/json", cookie } });
    expect(res.status).toBe(200); // anthropic not connected → lenient; activation gate (5.1) catches it at go-live
    // Clearing to null always allowed.
    expect((await app.request(`/agents/${agent.id}`, { ...jsonPatch({ model: null }), headers: { "content-type": "application/json", cookie } })).status).toBe(200);
  });

  it("no connected providers → any model string is accepted (lenient, unchanged behavior)", async () => {
    const { app, cookie } = await appWithSession(); // no connected providers
    const agent = await createAgent(app, cookie);
    expect((await app.request(`/agents/${agent.id}`, { ...jsonPatch({ model: "openai/gpt-4o" }), headers: { "content-type": "application/json", cookie } })).status).toBe(200);
  });
});

// Draft → publish (the design's explicit save model). The agents row is always the working
// draft; publishing snapshots it into agent_versions and bumps published_version.
describe("publish", () => {
  const withCookie = (cookie: string) => ({ headers: { "content-type": "application/json", cookie } });

  it("a new agent is dirty with every publishable field unpublished", async () => {
    const { app, cookie } = await appWithSession();
    const agent = await createAgent(app, cookie, "Ops steward");
    const res = await app.request(`/agents/${agent.id}`, { headers: { cookie } });
    const body = (await res.json()) as { agent: { dirty: boolean; changedFields: string[]; publishedVersion: number | null } };
    expect(body.agent.publishedVersion).toBeNull();
    expect(body.agent.dirty).toBe(true);
    expect(body.agent.changedFields).toContain("name");
    expect(body.agent.changedFields).toContain("costCap");
  });

  it("publish creates v1 and clears dirty", async () => {
    const { app, cookie } = await appWithSession();
    const agent = await createAgent(app, cookie);
    const res = await app.request(`/agents/${agent.id}/publish`, { method: "POST", headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agent: { dirty: boolean; changedFields: string[]; publishedVersion: number }; version: { version: number; publishedBy: string | null } };
    expect(body.version.version).toBe(1);
    expect(body.version.publishedBy).toBe(EMAIL); // attributed to the session that published
    expect(body.agent.publishedVersion).toBe(1);
    expect(body.agent.dirty).toBe(false);
    expect(body.agent.changedFields).toEqual([]);
  });

  it("refuses to republish an unchanged draft", async () => {
    const { app, cookie } = await appWithSession();
    const agent = await createAgent(app, cookie);
    await app.request(`/agents/${agent.id}/publish`, { method: "POST", headers: { cookie } });
    const again = await app.request(`/agents/${agent.id}/publish`, { method: "POST", headers: { cookie } });
    expect(again.status).toBe(400);
    expect(((await again.json()) as { error: string }).error).toMatch(/no unpublished changes/i);
  });

  it("a PATCH after publish reports only the fields that actually changed", async () => {
    const { app, cookie } = await appWithSession();
    const agent = await createAgent(app, cookie);
    await app.request(`/agents/${agent.id}/publish`, { method: "POST", headers: { cookie } });

    const patched = await app.request(`/agents/${agent.id}`, { ...jsonPatch({ instructions: "Read before you write." }), ...withCookie(cookie) });
    const body = (await patched.json()) as { agent: { dirty: boolean; changedFields: string[] } };
    expect(body.agent.dirty).toBe(true);
    expect(body.agent.changedFields).toEqual(["instructions"]);

    // Publishing again lands v2 and clears it.
    const republished = await app.request(`/agents/${agent.id}/publish`, { method: "POST", headers: { cookie } });
    expect(((await republished.json()) as { version: { version: number } }).version.version).toBe(2);
  });

  it("writing a field back to its published value clears dirty again", async () => {
    const { app, cookie } = await appWithSession();
    const agent = await createAgent(app, cookie, "Steward");
    await app.request(`/agents/${agent.id}/publish`, { method: "POST", headers: { cookie } });
    await app.request(`/agents/${agent.id}`, { ...jsonPatch({ name: "Renamed" }), ...withCookie(cookie) });
    const back = await app.request(`/agents/${agent.id}`, { ...jsonPatch({ name: "Steward" }), ...withCookie(cookie) });
    expect(((await back.json()) as { agent: { dirty: boolean } }).agent.dirty).toBe(false);
  });

  it("lifecycle state is not part of a version — activating doesn't make an agent dirty", async () => {
    const { app, cookie } = await appWithSession({ connectionsRepo: await connectedProviders() });
    const agent = await createAgent(app, cookie);
    await app.request(`/agents/${agent.id}`, { ...jsonPatch({ model: "openai/gpt-4o", costCap: { perRun: { minor: 50, currency: "USD" }, perDay: { minor: 500, currency: "USD" } } }), ...withCookie(cookie) });
    await app.request(`/agents/${agent.id}/publish`, { method: "POST", headers: { cookie } });
    const activated = await app.request(`/agents/${agent.id}/activate`, { method: "POST", headers: { cookie } });
    expect(activated.status).toBe(200);
    expect(((await activated.json()) as { agent: { dirty: boolean; state: string } }).agent).toMatchObject({ state: "active", dirty: false });
  });

  it("lists versions newest first, each with its snapshot", async () => {
    const { app, cookie } = await appWithSession();
    const agent = await createAgent(app, cookie, "First");
    await app.request(`/agents/${agent.id}/publish`, { method: "POST", headers: { cookie } });
    await app.request(`/agents/${agent.id}`, { ...jsonPatch({ name: "Second" }), ...withCookie(cookie) });
    await app.request(`/agents/${agent.id}/publish`, { method: "POST", headers: { cookie } });

    const res = await app.request(`/agents/${agent.id}/versions`, { headers: { cookie } });
    const { versions } = (await res.json()) as { versions: { version: number; snapshot: { name: string } }[] };
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    expect(versions[0].snapshot.name).toBe("Second");
    expect(versions[1].snapshot.name).toBe("First"); // the published snapshot is immutable
  });

  it("404s publish/versions for an unknown agent", async () => {
    const { app, cookie } = await appWithSession();
    expect((await app.request("/agents/nope/publish", { method: "POST", headers: { cookie } })).status).toBe(404);
    expect((await app.request("/agents/nope/versions", { headers: { cookie } })).status).toBe(404);
  });

  it("requires a session", async () => {
    const { app } = await appWithSession();
    expect((await app.request("/agents/x/publish", { method: "POST" })).status).toBe(401);
    expect((await app.request("/agents/x/versions")).status).toBe(401);
    expect((await app.request("/agents/x/duplicate", { method: "POST" })).status).toBe(401);
  });
});

describe("duplicate", () => {
  it("copies the definition into a new, never-published draft", async () => {
    const { app, cookie } = await appWithSession({ connectionsRepo: await connectedProviders() });
    const agent = await createAgent(app, cookie, "Ops steward");
    await app.request(`/agents/${agent.id}`, {
      ...jsonPatch({ instructions: "Read before write.", model: "openai/gpt-4o" }),
      headers: { "content-type": "application/json", cookie },
    });
    await app.request(`/agents/${agent.id}/publish`, { method: "POST", headers: { cookie } });
    await app.request(`/agents/${agent.id}/activate`, { method: "POST", headers: { cookie } });

    const res = await app.request(`/agents/${agent.id}/duplicate`, { method: "POST", headers: { cookie } });
    expect(res.status).toBe(201);
    const copy = ((await res.json()) as { agent: { id: string; name: string; state: string; instructions: string; publishedVersion: number | null; dirty: boolean } }).agent;
    expect(copy.id).not.toBe(agent.id);
    expect(copy.name).toBe("Ops steward copy");
    expect(copy.instructions).toBe("Read before write.");
    expect(copy.state).toBe("draft"); // a copy never inherits Active
    expect(copy.publishedVersion).toBeNull();
    expect(copy.dirty).toBe(true);

    // Editing the copy leaves the original alone.
    await app.request(`/agents/${copy.id}`, { ...jsonPatch({ instructions: "Different." }), headers: { "content-type": "application/json", cookie } });
    const original = await app.request(`/agents/${agent.id}`, { headers: { cookie } });
    expect(((await original.json()) as { agent: { instructions: string } }).agent.instructions).toBe("Read before write.");
  });

  it("404s for an unknown agent", async () => {
    const { app, cookie } = await appWithSession();
    expect((await app.request("/agents/nope/duplicate", { method: "POST", headers: { cookie } })).status).toBe(404);
  });
});

describe("PATCH /agents/:id memoryConfig (Story 8.2)", () => {
  it("persists memoryConfig, returns it, and does NOT make the agent dirty (operational, not published)", async () => {
    const { app, cookie } = await appWithSession();
    const agent = await createAgent(app, cookie, "Rememberer");

    // A fresh agent ships inherit + all kinds. (A never-published agent is dirty for its published
    // fields — but memoryConfig is operational, so it is never among changedFields.)
    const before = ((await (await app.request(`/agents/${agent.id}`, { headers: { cookie } })).json()) as { agent: any }).agent;
    expect(before.memoryConfig).toEqual({ mode: "inherit", recall: true, reflect: true, kinds: ["episodic", "semantic", "procedure"] });
    expect(before.changedFields).not.toContain("memoryConfig");
    const changedBefore = before.changedFields;

    const res = await app.request(`/agents/${agent.id}`, {
      ...jsonPatch({ memoryConfig: { mode: "on", recall: true, reflect: false, kinds: ["semantic"] } }),
      headers: { "content-type": "application/json", cookie },
    });
    expect(res.status).toBe(200);
    const updated = ((await res.json()) as { agent: any }).agent;
    expect(updated.memoryConfig).toEqual({ mode: "on", recall: true, reflect: false, kinds: ["semantic"] });
    // Operational config — editing it never appears in changedFields and doesn't change the dirty set.
    expect(updated.changedFields).not.toContain("memoryConfig");
    expect(updated.changedFields).toEqual(changedBefore);
  });

  it("de-dupes kinds and rejects invalid memoryConfig 400 (bad mode / unknown kind / non-boolean)", async () => {
    const { app, cookie } = await appWithSession();
    const agent = await createAgent(app, cookie, "Validated");

    // de-dupe within kinds
    const dup = await app.request(`/agents/${agent.id}`, {
      ...jsonPatch({ memoryConfig: { mode: "on", recall: true, reflect: true, kinds: ["semantic", "semantic", "episodic"] } }),
      headers: { "content-type": "application/json", cookie },
    });
    expect(((await dup.json()) as { agent: any }).agent.memoryConfig.kinds).toEqual(["semantic", "episodic"]);

    for (const bad of [
      { mode: "sometimes", recall: true, reflect: true, kinds: [] },
      { mode: "on", recall: "yes", reflect: true, kinds: [] },
      { mode: "on", recall: true, reflect: true, kinds: ["semantic", "made-up"] },
      { mode: "on", recall: true, reflect: true, kinds: "semantic" },
      "not-an-object",
    ]) {
      const res = await app.request(`/agents/${agent.id}`, {
        ...jsonPatch({ memoryConfig: bad }),
        headers: { "content-type": "application/json", cookie },
      });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
  });
});
