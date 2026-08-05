import { describe, it, expect } from "vitest";
import { ulid } from "@turanga/domain";
import { createApp } from "../app.js";
import { memoryAuthRepo, type AuthRepo } from "../auth/repo.js";
import { hashPassword } from "../auth/password.js";
import { memoryConversationsRepo, type ConversationsRepo } from "./repo.js";
import type { AgentsRepo, AgentView } from "../agents/repo.js";

const EMAIL = "admin@turanga.local";
const PW = "pw-for-tests-123456";
let clientSeq = 0;

// A minimal AgentsRepo whose only exercised method is get() — the conversations routes read just
// `agent.id` + `agent.publishedVersion`. `agents` maps an id → its publishedVersion (null = never
// published). Other methods are never called by the /conversations surface.
function stubAgentsRepo(agents: Record<string, number | null>): AgentsRepo {
  return {
    async get(id: string) {
      if (!(id in agents)) return null;
      return { id, publishedVersion: agents[id] } as AgentView;
    },
  } as unknown as AgentsRepo;
}

async function appWithSession(agents: Record<string, number | null>, conversationsRepo: ConversationsRepo = memoryConversationsRepo()) {
  const authRepo: AuthRepo = memoryAuthRepo();
  await authRepo.createUser({ id: ulid(1), email: EMAIL, passwordHash: await hashPassword(PW) });
  const app = createApp({ authRepo, agentsRepo: stubAgentsRepo(agents), conversationsRepo });
  const login = await app.request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `10.11.0.${clientSeq++}` },
    body: JSON.stringify({ email: EMAIL, password: PW }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  return { app, cookie, conversationsRepo };
}

const post = (app: ReturnType<typeof createApp>, cookie: string, body: unknown) =>
  app.request("/conversations", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) });

describe("conversation routes — create + publish-first refusal + version pin (Story 9.1)", () => {
  it("creating a conversation for a PUBLISHED agent pins the current published version", async () => {
    const { app, cookie, conversationsRepo } = await appWithSession({ "agent-pub": 3 });
    const res = await post(app, cookie, { agentId: "agent-pub", title: "Weekly digest" });
    expect(res.status).toBe(201);
    const { conversation } = (await res.json()) as { conversation: { id: string; agentId: string; publishedVersion: number; title: string } };
    expect(conversation).toMatchObject({ agentId: "agent-pub", publishedVersion: 3, title: "Weekly digest" });
    // Persisted (control-api sole writer, AD-7) — it shows up in the agent's list.
    expect((await conversationsRepo.listForAgent("agent-pub")).map((c) => c.id)).toContain(conversation.id);
  });

  it("creating a conversation for a NEVER-published agent is refused with the stated cause", async () => {
    const { app, cookie, conversationsRepo } = await appWithSession({ "agent-draft": null });
    const res = await post(app, cookie, { agentId: "agent-draft" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("Publish this agent to chat with it.");
    // Nothing was written.
    expect(await conversationsRepo.listForAgent("agent-draft")).toHaveLength(0);
  });

  it("an unknown agent is a 404; a missing agentId is a 400", async () => {
    const { app, cookie } = await appWithSession({ "agent-pub": 1 });
    expect((await post(app, cookie, { agentId: "nope" })).status).toBe(404);
    expect((await post(app, cookie, {})).status).toBe(400);
  });

  it("defaults an omitted title to empty", async () => {
    const { app, cookie } = await appWithSession({ "agent-pub": 2 });
    const { conversation } = (await (await post(app, cookie, { agentId: "agent-pub" })).json()) as { conversation: { title: string } };
    expect(conversation.title).toBe("");
  });
});

describe("conversation routes — list + get (agent-scoped, Story 9.1)", () => {
  it("lists an agent's conversations newest-first; never another agent's", async () => {
    const repo = memoryConversationsRepo();
    const { app, cookie } = await appWithSession({ "agent-a": 1, "agent-b": 1 }, repo);
    await post(app, cookie, { agentId: "agent-a", title: "first" });
    await post(app, cookie, { agentId: "agent-a", title: "second" });
    await post(app, cookie, { agentId: "agent-b", title: "other agent" });

    const res = await app.request("/conversations?agentId=agent-a", { headers: { cookie } });
    expect(res.status).toBe(200);
    const { conversations } = (await res.json()) as { conversations: { title: string; agentId: string }[] };
    expect(conversations.map((c) => c.title)).toEqual(["second", "first"]); // newest first
    expect(conversations.every((c) => c.agentId === "agent-a")).toBe(true); // never agent-b's

    // A missing agentId is a 400.
    expect((await app.request("/conversations", { headers: { cookie } })).status).toBe(400);
  });

  it("GET /conversations/:id returns the conversation; unknown id → 404", async () => {
    const { app, cookie } = await appWithSession({ "agent-a": 5 });
    const { conversation } = (await (await post(app, cookie, { agentId: "agent-a" })).json()) as { conversation: { id: string } };
    const got = await app.request(`/conversations/${conversation.id}`, { headers: { cookie } });
    expect(got.status).toBe(200);
    expect(((await got.json()) as { conversation: { id: string } }).conversation.id).toBe(conversation.id);
    expect((await app.request("/conversations/nope", { headers: { cookie } })).status).toBe(404);
  });

  it("the conversation routes are session-guarded (401 without a cookie)", async () => {
    const { app } = await appWithSession({ "agent-a": 1 });
    expect((await app.request("/conversations", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
    expect((await app.request("/conversations?agentId=agent-a")).status).toBe(401);
    expect((await app.request("/conversations/x")).status).toBe(401);
  });
});
