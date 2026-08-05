import { describe, it, expect } from "vitest";
import { ulid } from "@turanga/domain";
import { createApp } from "../app.js";
import { memoryAuthRepo, type AuthRepo } from "../auth/repo.js";
import { hashPassword } from "../auth/password.js";
import { memoryConversationsRepo, type ConversationsRepo } from "./repo.js";
import type { AgentsRepo, AgentView } from "../agents/repo.js";
import type { RunOrchestrator } from "../runs/orchestrator.js";
import { memoryRunsRepo, type RunRow, type RunsRepo } from "../runs/repo.js";
import { CONTRACT_VERSION } from "@turanga/contracts";

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

async function appWithSession(agents: Record<string, number | null>, conversationsRepo: ConversationsRepo = memoryConversationsRepo(), orchestrator?: RunOrchestrator, runsRepo?: RunsRepo) {
  const authRepo: AuthRepo = memoryAuthRepo();
  await authRepo.createUser({ id: ulid(1), email: EMAIL, passwordHash: await hashPassword(PW) });
  const app = createApp({ authRepo, agentsRepo: stubAgentsRepo(agents), conversationsRepo, orchestrator, runsRepo });
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

describe("conversation routes — send a message / run a turn (Story 9.2)", () => {
  // A fake orchestrator: records the startChatTurn call and returns a canned running run (the snapshot/
  // history resolution is unit-tested in turn.test.ts; this is a routing test).
  function fakeOrchestrator(over: Partial<Awaited<ReturnType<RunOrchestrator["startChatTurn"]>>> = {}) {
    const calls: { conversationId: string; taskInput: string }[] = [];
    const run = { id: "run-1", agentId: "a1", conversationId: "conv-1", turnIndex: 0, status: "running", taskInput: "hi", transcript: [], reason: null, costMicros: 0, createdAt: "2026-08-05T00:00:00.000Z", endedAt: null } as RunRow;
    const orchestrator = {
      async startChatTurn(conversationId: string, taskInput: string) {
        calls.push({ conversationId, taskInput });
        return ("ok" in over ? over : { ok: true, run }) as Awaited<ReturnType<RunOrchestrator["startChatTurn"]>>;
      },
    } as unknown as RunOrchestrator;
    return { orchestrator, calls };
  }

  it("POST /conversations/:id/messages runs a turn and returns the created run (201)", async () => {
    const { orchestrator, calls } = fakeOrchestrator();
    const { app, cookie } = await appWithSession({ "agent-a": 1 }, memoryConversationsRepo(), orchestrator);
    const res = await app.request("/conversations/conv-1/messages", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ taskInput: "what's the weather?" }) });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { run: { id: string } }).run.id).toBe("run-1");
    expect(calls).toEqual([{ conversationId: "conv-1", taskInput: "what's the weather?" }]); // delegated to the orchestrator
  });

  it("relays the orchestrator's refusal (e.g. an unknown conversation → 404)", async () => {
    const { orchestrator } = fakeOrchestrator({ ok: false, error: "That conversation doesn't exist.", status: 404 });
    const { app, cookie } = await appWithSession({ "agent-a": 1 }, memoryConversationsRepo(), orchestrator);
    const res = await app.request("/conversations/nope/messages", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ taskInput: "hi" }) });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("That conversation doesn't exist.");
  });

  it("rejects an empty/whitespace message with a 400 (no run launched)", async () => {
    const { orchestrator, calls } = fakeOrchestrator();
    const { app, cookie } = await appWithSession({ "agent-a": 1 }, memoryConversationsRepo(), orchestrator);
    for (const bad of [{}, { taskInput: "" }, { taskInput: "   " }]) {
      const res = await app.request("/conversations/conv-1/messages", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(bad) });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect(calls).toHaveLength(0); // the orchestrator was never asked to launch a turn
  });

  it("is session-guarded (401 without a cookie)", async () => {
    const { app } = await appWithSession({ "agent-a": 1 });
    expect((await app.request("/conversations/conv-1/messages", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
  });
});

describe("conversation routes — GET /conversations/:id/runs (the thread, Story 9.3)", () => {
  const runRow = (over: Partial<RunRow> & { id: string; conversationId: string; turnIndex: number }): RunRow => ({
    agentId: "a1",
    status: "succeeded",
    taskInput: "",
    transcript: [],
    reason: null,
    costMicros: 0,
    createdAt: "2026-08-05T00:00:00.000Z",
    endedAt: null,
    ...over,
  });

  it("returns the conversation's runs turnIndex-ASC, with transcripts", async () => {
    const runsRepo = memoryRunsRepo();
    // Insert out of order; the endpoint sorts by turnIndex ascending.
    await runsRepo.create(runRow({ id: "t1", conversationId: "conv-1", turnIndex: 1, taskInput: "and tomorrow?", transcript: [{ type: "turn", v: CONTRACT_VERSION, role: "agent", text: "rain" }] }));
    await runsRepo.create(runRow({ id: "t0", conversationId: "conv-1", turnIndex: 0, taskInput: "hi", transcript: [{ type: "turn", v: CONTRACT_VERSION, role: "agent", text: "hello" }] }));
    await runsRepo.create(runRow({ id: "other", conversationId: "conv-2", turnIndex: 0 }));
    const conversationsRepo = memoryConversationsRepo();
    await conversationsRepo.create({ id: "conv-1", agentId: "a1", publishedVersion: 1, title: "", createdAt: "2026-08-05T00:00:00.000Z" });
    const { app, cookie } = await appWithSession({ a1: 1 }, conversationsRepo, undefined, runsRepo);

    const res = await app.request("/conversations/conv-1/runs", { headers: { cookie } });
    expect(res.status).toBe(200);
    const { runs } = (await res.json()) as { runs: { id: string; turnIndex: number; transcript: unknown[] }[] };
    expect(runs.map((r) => r.id)).toEqual(["t0", "t1"]); // turnIndex ASC, never conv-2's
    expect(runs[0].transcript).toHaveLength(1); // full transcript (the agent reply, for rendering)
  });

  it("404s for an unknown conversation; is session-guarded (401)", async () => {
    const conversationsRepo = memoryConversationsRepo();
    const { app, cookie } = await appWithSession({ a1: 1 }, conversationsRepo, undefined, memoryRunsRepo());
    expect((await app.request("/conversations/nope/runs", { headers: { cookie } })).status).toBe(404);
    expect((await app.request("/conversations/conv-1/runs")).status).toBe(401);
  });
});

describe("conversation routes — management: rename / delete / last-activity (Story 9.4)", () => {
  const runRow = (over: Partial<RunRow> & { id: string; conversationId: string; turnIndex: number }): RunRow => ({
    agentId: "a1",
    status: "succeeded",
    taskInput: "",
    transcript: [],
    reason: null,
    costMicros: 0,
    createdAt: "2026-08-05T00:00:00.000Z",
    endedAt: null,
    ...over,
  });

  it("PATCH renames a conversation; unknown id → 404; bad body → 400", async () => {
    const conversationsRepo = memoryConversationsRepo();
    await conversationsRepo.create({ id: "c1", agentId: "a1", publishedVersion: 1, title: "old", createdAt: "2026-08-05T00:00:00.000Z" });
    const { app, cookie } = await appWithSession({ a1: 1 }, conversationsRepo);

    const res = await app.request("/conversations/c1", { method: "PATCH", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ title: "Weekly digest" }) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { conversation: { title: string } }).conversation.title).toBe("Weekly digest");
    expect((await conversationsRepo.get("c1"))!.title).toBe("Weekly digest");

    expect((await app.request("/conversations/nope", { method: "PATCH", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ title: "x" }) })).status).toBe(404);
    expect((await app.request("/conversations/c1", { method: "PATCH", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ title: 5 }) })).status).toBe(400);

    // The title is trimmed + bounded server-side (code-review fix).
    const trimmed = await app.request("/conversations/c1", { method: "PATCH", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ title: "  padded  " }) });
    expect(((await trimmed.json()) as { conversation: { title: string } }).conversation.title).toBe("padded");
    const long = await app.request("/conversations/c1", { method: "PATCH", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ title: "x".repeat(500) }) });
    expect(((await long.json()) as { conversation: { title: string } }).conversation.title).toHaveLength(200);
  });

  it("DELETE removes the conversation AND cascades its turns; unknown id → 404", async () => {
    const conversationsRepo = memoryConversationsRepo();
    await conversationsRepo.create({ id: "c1", agentId: "a1", publishedVersion: 1, title: "", createdAt: "2026-08-05T00:00:00.000Z" });
    const runsRepo = memoryRunsRepo();
    await runsRepo.create(runRow({ id: "t0", conversationId: "c1", turnIndex: 0 }));
    await runsRepo.create(runRow({ id: "t1", conversationId: "c1", turnIndex: 1 }));
    await runsRepo.create(runRow({ id: "keep", conversationId: "c2", turnIndex: 0 })); // another conversation — untouched
    const { app, cookie } = await appWithSession({ a1: 1 }, conversationsRepo, undefined, runsRepo);

    const res = await app.request("/conversations/c1", { method: "DELETE", headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await conversationsRepo.get("c1")).toBeNull(); // the thread is gone
    expect(await runsRepo.listByConversation("c1")).toHaveLength(0); // its turns cascaded
    expect(await runsRepo.listByConversation("c2")).toHaveLength(1); // another conversation's turns survive

    expect((await app.request("/conversations/nope", { method: "DELETE", headers: { cookie } })).status).toBe(404);
  });

  it("GET /conversations/activity returns the { conversationId → last run createdAt } map", async () => {
    const runsRepo = memoryRunsRepo();
    await runsRepo.create(runRow({ id: "t0", conversationId: "c1", turnIndex: 0, createdAt: "2026-08-05T00:00:00.000Z" }));
    await runsRepo.create(runRow({ id: "t1", conversationId: "c1", turnIndex: 1, createdAt: "2026-08-06T00:00:00.000Z" })); // newer
    await runsRepo.create(runRow({ id: "b0", conversationId: "c2", turnIndex: 0, createdAt: "2026-08-04T00:00:00.000Z" }));
    await runsRepo.create({ id: "solo", agentId: "a1", status: "succeeded", taskInput: "", transcript: [], reason: null, createdAt: "2026-08-07T00:00:00.000Z", endedAt: null }); // standalone run (no conversation) — excluded
    const { app, cookie } = await appWithSession({ a1: 1 }, memoryConversationsRepo(), undefined, runsRepo);

    const res = await app.request("/conversations/activity?agentId=a1", { headers: { cookie } });
    expect(res.status).toBe(200);
    const { activity } = (await res.json()) as { activity: Record<string, string> };
    expect(activity["c1"]).toBe("2026-08-06T00:00:00.000Z"); // the NEWEST run's time
    expect(activity["c2"]).toBe("2026-08-04T00:00:00.000Z");
    expect(Object.keys(activity).sort()).toEqual(["c1", "c2"]); // the standalone run (no conversation) is excluded
    // A missing agentId is a 400; session-guarded.
    expect((await app.request("/conversations/activity", { headers: { cookie } })).status).toBe(400);
    expect((await app.request("/conversations/activity?agentId=a1")).status).toBe(401);
  });

  it("the management routes are session-guarded (401 without a cookie)", async () => {
    const { app } = await appWithSession({ a1: 1 });
    expect((await app.request("/conversations/c1", { method: "PATCH", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
    expect((await app.request("/conversations/c1", { method: "DELETE" })).status).toBe(401);
  });
});
