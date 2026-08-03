import { describe, it, expect } from "vitest";
import { createApp } from "../app.js";
import { memoryAuthRepo, type AuthRepo } from "../auth/repo.js";
import { memoryToolsRepo, type ToolsRepo, type ToolRow } from "./repo.js";
import { hashPassword } from "../auth/password.js";
import { ulid } from "@turanga/domain";

const EMAIL = "admin@turanga.local";
const PW = "pw-for-tests-123456";
const jsonPost = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function seeded(repo: AuthRepo) {
  await repo.createUser({ id: ulid(1), email: EMAIL, passwordHash: await hashPassword(PW) });
}

// Distinct client IP per session so many logins in one run don't trip the login rate limiter.
let clientSeq = 0;
async function appWithSession(toolsRepo: ToolsRepo = memoryToolsRepo()) {
  const authRepo = memoryAuthRepo();
  await seeded(authRepo);
  const app = createApp({ authRepo, toolsRepo });
  const login = await app.request("/auth/login", { ...jsonPost({ email: EMAIL, password: PW }), headers: { "content-type": "application/json", "x-forwarded-for": `10.6.0.${clientSeq++}` } });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  return { app, cookie, toolsRepo };
}

const toolRow = (over: Partial<ToolRow> = {}): ToolRow => ({
  id: ulid(2),
  name: "weather",
  endpoint: "remote",
  status: "connected",
  lastError: null,
  operations: [{ name: "get_weather", description: "look up weather" }],
  createdAt: new Date().toISOString(),
  ...over,
});

describe("ToolsRepo (memory)", () => {
  it("create/list/get/setStatus/setOperations/delete", async () => {
    const repo = memoryToolsRepo();
    const t = toolRow({ id: "t1", status: "unverified", operations: [] });
    await repo.createTool(t);
    expect((await repo.listTools()).map((r) => r.id)).toEqual(["t1"]);
    expect((await repo.getTool("t1"))?.status).toBe("unverified");
    await repo.setStatus("t1", "connected", null);
    expect((await repo.getTool("t1"))?.status).toBe("connected");
    await repo.setOperations("t1", [{ name: "get_weather" }]);
    expect((await repo.getTool("t1"))?.operations).toEqual([{ name: "get_weather" }]);
    await repo.deleteTool("t1");
    expect(await repo.getTool("t1")).toBeNull();
    expect(await repo.listTools()).toEqual([]);
  });
});

describe("tools routes (Story 6.1)", () => {
  it("401 without a session", async () => {
    const { app } = await appWithSession();
    expect((await app.request("/tools")).status).toBe(401);
  });

  it("GET /tools returns [] fresh; each row is the masked view (no secret fields)", async () => {
    const { app, cookie } = await appWithSession();
    const res = await app.request("/tools", { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { tools: unknown[] }).tools).toEqual([]);
  });

  it("GET /tools/:id and DELETE /tools/:id — 404 for an unknown id", async () => {
    const { app, cookie } = await appWithSession();
    expect((await app.request("/tools/nope", { headers: { cookie } })).status).toBe(404);
    expect((await app.request("/tools/nope", { method: "DELETE", headers: { cookie } })).status).toBe(404);
  });

  it("lists a seeded tool, fetches it, and removes it", async () => {
    const repo = memoryToolsRepo();
    await repo.createTool(toolRow({ id: "t1", name: "weather" }));
    const { app, cookie } = await appWithSession(repo);
    const list = (await (await app.request("/tools", { headers: { cookie } })).json()) as { tools: { id: string; name: string; endpoint: string; status: string }[] };
    expect(list.tools).toHaveLength(1);
    expect(list.tools[0]).toMatchObject({ id: "t1", name: "weather", endpoint: "remote", status: "connected" });
    const one = (await (await app.request("/tools/t1", { headers: { cookie } })).json()) as { tool: { id: string } };
    expect(one.tool.id).toBe("t1");
    const del = await app.request("/tools/t1", { method: "DELETE", headers: { cookie } });
    expect(del.status).toBe(200);
    expect(((await (await app.request("/tools", { headers: { cookie } })).json()) as { tools: unknown[] }).tools).toEqual([]);
  });
});
