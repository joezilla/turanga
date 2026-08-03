import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createApp } from "../app.js";
import { memoryAuthRepo, type AuthRepo } from "../auth/repo.js";
import { memoryToolsRepo, type ToolsRepo, type ToolRow } from "./repo.js";
import { fakeMcpVerifier } from "./mcp.js";
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
async function appWithSession(opts: { toolsRepo?: ToolsRepo; mcpVerifier?: ReturnType<typeof fakeMcpVerifier> } = {}) {
  const authRepo = memoryAuthRepo();
  await seeded(authRepo);
  const toolsRepo = opts.toolsRepo ?? memoryToolsRepo();
  const app = createApp({ authRepo, toolsRepo, mcpVerifier: opts.mcpVerifier });
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
  url: "https://mcp.example/mcp",
  encCredential: null,
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

  it("lists a seeded tool, fetches it, and removes it (view masks encCredential)", async () => {
    const repo = memoryToolsRepo();
    await repo.createTool(toolRow({ id: "t1", name: "weather", encCredential: "enc-blob-should-not-leak" }));
    const { app, cookie } = await appWithSession({ toolsRepo: repo });
    const listRes = await app.request("/tools", { headers: { cookie } });
    const list = (await listRes.json()) as { tools: { id: string; name: string; endpoint: string; status: string; credentialSet: boolean }[] };
    expect(list.tools).toHaveLength(1);
    expect(list.tools[0]).toMatchObject({ id: "t1", name: "weather", endpoint: "remote", status: "connected", credentialSet: true });
    expect(JSON.stringify(list.tools[0])).not.toContain("enc-blob-should-not-leak"); // AD-10: encCredential never in view()
    const one = (await (await app.request("/tools/t1", { headers: { cookie } })).json()) as { tool: { id: string } };
    expect(one.tool.id).toBe("t1");
    const del = await app.request("/tools/t1", { method: "DELETE", headers: { cookie } });
    expect(del.status).toBe(200);
    expect(((await (await app.request("/tools", { headers: { cookie } })).json()) as { tools: unknown[] }).tools).toEqual([]);
  });
});

describe("connect a remote MCP tool (Story 6.2)", () => {
  const OLD_KEY = process.env.TOKEN_ENC_KEY;
  beforeAll(() => {
    process.env.TOKEN_ENC_KEY = "test-token-enc-key";
  });
  afterAll(() => {
    if (OLD_KEY === undefined) delete process.env.TOKEN_ENC_KEY;
    else process.env.TOKEN_ENC_KEY = OLD_KEY;
  });

  it("verifies + discovers, persists a connected tool with its operations; the credential is encrypted, never echoed (AD-10)", async () => {
    const { app, cookie, toolsRepo } = await appWithSession({ mcpVerifier: fakeMcpVerifier({ operations: [{ name: "echo" }, { name: "get_time" }] }) });
    const res = await app.request("/tools", { ...jsonPost({ name: "My MCP", url: "https://mcp.example/mcp", credential: "sk-secret-token" }), headers: { "content-type": "application/json", cookie } });
    expect(res.status).toBe(201);
    const tool = ((await res.json()) as { tool: { id: string; status: string; url: string; credentialSet: boolean; operations: { name: string }[] } }).tool;
    expect(tool.status).toBe("connected");
    expect(tool.url).toBe("https://mcp.example/mcp");
    expect(tool.credentialSet).toBe(true);
    expect(tool.operations.map((o) => o.name)).toEqual(["echo", "get_time"]);
    // The raw credential is NEVER in the response (AD-10)…
    expect(JSON.stringify(tool)).not.toContain("sk-secret-token");
    // …and it's stored ENCRYPTED (the persisted blob is not the plaintext).
    const row = await toolsRepo.getTool(tool.id);
    expect(row?.encCredential).toBeTruthy();
    expect(row?.encCredential).not.toBe("sk-secret-token");
  });

  it("connects a no-auth server (no credential) → credentialSet false", async () => {
    const { app, cookie } = await appWithSession({ mcpVerifier: fakeMcpVerifier() });
    const res = await app.request("/tools", { ...jsonPost({ name: "Open MCP", url: "https://open.example/mcp" }), headers: { "content-type": "application/json", cookie } });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { tool: { credentialSet: boolean } }).tool.credentialSet).toBe(false);
  });

  it("fail-closed: a verify failure returns the stated cause and persists NOTHING", async () => {
    const { app, cookie, toolsRepo } = await appWithSession({ mcpVerifier: fakeMcpVerifier({ ok: false, error: "Couldn't connect to the MCP server — check the URL." }) });
    const res = await app.request("/tools", { ...jsonPost({ name: "Bad", url: "https://nope.example/mcp", credential: "x" }), headers: { "content-type": "application/json", cookie } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/couldn't connect/i);
    expect(await toolsRepo.listTools()).toEqual([]); // no orphan error row
  });

  it("requires a name and a URL (400)", async () => {
    const { app, cookie } = await appWithSession();
    expect((await app.request("/tools", { ...jsonPost({ url: "https://x/mcp" }), headers: { "content-type": "application/json", cookie } })).status).toBe(400);
    expect((await app.request("/tools", { ...jsonPost({ name: "x" }), headers: { "content-type": "application/json", cookie } })).status).toBe(400);
  });
});
