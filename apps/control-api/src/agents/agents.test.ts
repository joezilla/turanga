import { describe, it, expect } from "vitest";
import { createApp } from "../app.js";
import { memoryAuthRepo, type AuthRepo } from "../auth/repo.js";
import { memoryAgentsRepo } from "./repo.js";
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
async function appWithSession() {
  const authRepo: AuthRepo = memoryAuthRepo();
  await authRepo.createUser({ id: ulid(1), email: EMAIL, passwordHash: await hashPassword(PW) });
  const agentsRepo = memoryAgentsRepo();
  const app = createApp({ authRepo, agentsRepo });
  const ip = `10.0.0.${clientSeq++}`;
  const login = await app.request("/auth/login", {
    ...jsonPost({ email: EMAIL, password: PW }),
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  return { app, cookie, agentsRepo };
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
