import { describe, it, expect } from "vitest";
import { createApp } from "../app.js";
import { memoryAuthRepo, type AuthRepo } from "../auth/repo.js";
import { memoryConnectionsRepo } from "./repo.js";
import { fakeModelGateway } from "../litellm/gateway.js";
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
async function appWithSession(gateway = fakeModelGateway({ verifyOk: true })) {
  const authRepo = memoryAuthRepo();
  await seeded(authRepo);
  const connectionsRepo = memoryConnectionsRepo();
  const app = createApp({ authRepo, connectionsRepo, modelGateway: gateway });
  const login = await app.request("/auth/login", { ...jsonPost({ email: EMAIL, password: PW }), headers: { "content-type": "application/json", "x-forwarded-for": `10.1.0.${clientSeq++}` } });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  return { app, cookie, gateway, connectionsRepo };
}

describe("connections guard", () => {
  it("rejects /connections/providers without a session (401)", async () => {
    const { app } = await appWithSession();
    const res = await app.request("/connections/providers");
    expect(res.status).toBe(401);
  });
  it("allows it with a session (200)", async () => {
    const { app, cookie } = await appWithSession();
    const res = await app.request("/connections/providers", { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { providers: unknown[] }).providers).toEqual([]);
  });
});

describe("connect a model provider", () => {
  it("connects OpenAI with a valid key (masked, key never returned)", async () => {
    const { app, cookie, gateway } = await appWithSession(fakeModelGateway({ verifyOk: true }));
    const res = await app.request("/connections/providers", { ...jsonPost({ provider: "openai", apiKey: "sk-secret-abcd1234" }), headers: { "content-type": "application/json", cookie } });
    expect(res.status).toBe(201);
    const p = ((await res.json()) as { provider: any }).provider;
    expect(p.status).toBe("connected");
    expect(p.keyLast4).toBe("1234");
    expect(JSON.stringify(p)).not.toContain("sk-secret-abcd1234");
    expect(gateway.registered.length).toBe(1);
  });

  it("marks a bad key as error and does NOT register it in LiteLLM", async () => {
    const { app, cookie, gateway } = await appWithSession(fakeModelGateway({ verifyOk: false, verifyError: "The provider rejected the key (HTTP 401)." }));
    const res = await app.request("/connections/providers", { ...jsonPost({ provider: "openai", apiKey: "sk-bad" }), headers: { "content-type": "application/json", cookie } });
    const p = ((await res.json()) as { provider: any }).provider;
    expect(p.status).toBe("error");
    expect(p.lastError).toContain("401");
    expect(gateway.registered.length).toBe(0); // never registered a bad key
  });

  it("requires base URL + models for openai-compatible (400)", async () => {
    const { app, cookie } = await appWithSession();
    const res = await app.request("/connections/providers", { ...jsonPost({ provider: "openai-compatible", apiKey: "sk-x" }), headers: { "content-type": "application/json", cookie } });
    expect(res.status).toBe(400);
  });

  it("connects an openai-compatible provider with base URL + models", async () => {
    const { app, cookie, gateway } = await appWithSession();
    const res = await app.request("/connections/providers", {
      ...jsonPost({ provider: "openai-compatible", name: "router", apiKey: "sk-y-9999", baseUrl: "https://x.local/v1", models: "llama-3, mixtral" }),
      headers: { "content-type": "application/json", cookie },
    });
    const p = ((await res.json()) as { provider: any }).provider;
    expect(p.status).toBe("connected");
    expect(p.models).toEqual(["llama-3", "mixtral"]);
    expect(gateway.registered[0].length).toBe(2);
  });

  it("removes a provider (unregisters LiteLLM models)", async () => {
    const { app, cookie, gateway } = await appWithSession();
    const created = (await (await app.request("/connections/providers", { ...jsonPost({ provider: "anthropic", apiKey: "sk-a-4321" }), headers: { "content-type": "application/json", cookie } })).json()) as { provider: { id: string } };
    const id = created.provider.id;
    const del = await app.request(`/connections/providers/${id}`, { method: "DELETE", headers: { cookie } });
    expect(del.status).toBe(200);
    expect(gateway.unregistered.length).toBeGreaterThan(0);
    const list = (await (await app.request("/connections/providers", { headers: { cookie } })).json()) as { providers: unknown[] };
    expect(list.providers).toEqual([]);
  });
});

describe("provider dependents (GET /connections/providers/:id/dependents, Story 3.6)", () => {
  const jsonPatch = (body: unknown) => ({ method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  async function connectProvider(app: any, cookie: string, provider: string) {
    const r = (await (await app.request("/connections/providers", { ...jsonPost({ provider, apiKey: `sk-${provider}-1234` }), headers: { "content-type": "application/json", cookie } })).json()) as { provider: { id: string; provider: string } };
    return r.provider;
  }
  async function agentWithModel(app: any, cookie: string, name: string, model: string) {
    const created = (await (await app.request("/agents", { ...jsonPost({ name }), headers: { "content-type": "application/json", cookie } })).json()) as { agent: { id: string } };
    await app.request(`/agents/${created.agent.id}`, { ...jsonPatch({ model }), headers: { "content-type": "application/json", cookie } });
    return created.agent.id;
  }

  it("returns agents whose model matches the provider kind, excluding others", async () => {
    const { app, cookie } = await appWithSession();
    const openai = await connectProvider(app, cookie, "openai");
    await agentWithModel(app, cookie, "Portfolio", "openai/gpt-4o");
    await agentWithModel(app, cookie, "Inbox", "openai/gpt-4o-mini");
    await agentWithModel(app, cookie, "Other", "anthropic/claude-sonnet-5"); // different kind → excluded
    const res = await app.request(`/connections/providers/${openai.id}/dependents`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const names = ((await res.json()) as { agents: { name: string }[] }).agents.map((a) => a.name).sort();
    expect(names).toEqual(["Inbox", "Portfolio"]);
  });

  it("returns [] when no agent references the provider", async () => {
    const { app, cookie } = await appWithSession();
    const anthropic = await connectProvider(app, cookie, "anthropic");
    await agentWithModel(app, cookie, "Portfolio", "openai/gpt-4o");
    const res = await app.request(`/connections/providers/${anthropic.id}/dependents`, { headers: { cookie } });
    expect(((await res.json()) as { agents: unknown[] }).agents).toEqual([]);
  });

  it("404 for an unknown provider id", async () => {
    const { app, cookie } = await appWithSession();
    expect((await app.request("/connections/providers/nope/dependents", { headers: { cookie } })).status).toBe(404);
  });

  it("401 without a session", async () => {
    const { app } = await appWithSession();
    expect((await app.request("/connections/providers/x/dependents")).status).toBe(401);
  });
});
