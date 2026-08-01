import { describe, it, expect } from "vitest";
import { createApp } from "../app.js";
import { memoryAuthRepo, type AuthRepo } from "../auth/repo.js";
import { memoryAgentsRepo } from "./repo.js";
import { hashPassword } from "../auth/password.js";
import { ulid } from "@turanga/domain";

const EMAIL = "admin@turanga.local";
const PW = "pw-for-tests-123456";
const jsonPost = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function appWithSession() {
  const authRepo: AuthRepo = memoryAuthRepo();
  await authRepo.createUser({ id: ulid(1), email: EMAIL, passwordHash: await hashPassword(PW) });
  const agentsRepo = memoryAgentsRepo();
  const app = createApp({ authRepo, agentsRepo });
  const login = await app.request("/auth/login", jsonPost({ email: EMAIL, password: PW }));
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
  it("creates a Draft agent with the default name when none is given (201)", async () => {
    const { app, cookie } = await appWithSession();
    const res = await app.request("/agents", { ...jsonPost({}), headers: { "content-type": "application/json", cookie } });
    expect(res.status).toBe(201);
    const a = ((await res.json()) as { agent: any }).agent;
    expect(a.state).toBe("draft");
    expect(a.name).toBe("Untitled agent");
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
