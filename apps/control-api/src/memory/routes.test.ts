import { describe, it, expect } from "vitest";
import { ulid, DEFAULT_MEMORY_GLOBAL_CONFIG } from "@turanga/domain";
import { createApp } from "../app.js";
import { memoryAuthRepo, type AuthRepo } from "../auth/repo.js";
import { hashPassword } from "../auth/password.js";
import { memoryMemoryRepo, type MemoryRepo, type MemoryRow } from "./repo.js";
import { fakeEmbed } from "../litellm/gateway.js";

const EMAIL = "admin@turanga.local";
const PW = "pw-for-tests-123456";
let clientSeq = 0;

async function appWithSession(memoryRepo: MemoryRepo = memoryMemoryRepo()) {
  const authRepo: AuthRepo = memoryAuthRepo();
  await authRepo.createUser({ id: ulid(1), email: EMAIL, passwordHash: await hashPassword(PW) });
  const app = createApp({ authRepo, memoryRepo });
  const login = await app.request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `10.9.0.${clientSeq++}` },
    body: JSON.stringify({ email: EMAIL, password: PW }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  return { app, cookie, memoryRepo };
}

const memRow = (over: Partial<MemoryRow> = {}): MemoryRow => ({
  id: ulid(2),
  agentId: "agent-A",
  kind: "semantic",
  content: "x",
  summary: "",
  embedding: null,
  topic: null,
  salience: 0,
  pinned: false,
  status: "active",
  sourceRunId: null,
  validFrom: "2026-08-05T00:00:00.000Z",
  validUntil: null,
  useCount: 0,
  lastUsedAt: null,
  createdAt: "2026-08-05T00:00:00.000Z",
  ...over,
});

describe("memory routes — global config (Story 8.2)", () => {
  it("GET /memory/config returns the OFF defaults on a fresh app", async () => {
    const { app, cookie } = await appWithSession();
    const res = await app.request("/memory/config", { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(DEFAULT_MEMORY_GLOBAL_CONFIG);
  });

  it("PATCH /memory/config round-trips defaultEnabled + killSwitch + retentionDays", async () => {
    const { app, cookie } = await appWithSession();
    const res = await app.request("/memory/config", {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ defaultEnabled: true, killSwitch: true, retentionDays: 30 }),
    });
    expect(res.status).toBe(200);
    const cfg = (await res.json()) as { defaultEnabled: boolean; killSwitch: boolean; retentionDays: number | null; privacy: string };
    expect(cfg).toMatchObject({ defaultEnabled: true, killSwitch: true, retentionDays: 30, privacy: "agent-scoped" });

    // Persisted — a later GET reflects it.
    const after = await (await app.request("/memory/config", { headers: { cookie } })).json();
    expect(after).toMatchObject({ defaultEnabled: true, killSwitch: true, retentionDays: 30 });
  });

  it("PATCH accepts null retentionDays (keep indefinitely) and rejects a bad one", async () => {
    const { app, cookie } = await appWithSession();
    const ok = await app.request("/memory/config", {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ retentionDays: null }),
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { retentionDays: number | null }).retentionDays).toBeNull();

    for (const bad of [0, -5, 1.5, "30"]) {
      const res = await app.request("/memory/config", {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ retentionDays: bad }),
      });
      expect(res.status, `retentionDays=${bad}`).toBe(400);
    }
  });

  it("PATCH rejects a non-boolean flag 400", async () => {
    const { app, cookie } = await appWithSession();
    const res = await app.request("/memory/config", {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ defaultEnabled: "yes" }),
    });
    expect(res.status).toBe(400);
  });

  it("embeddingModel + privacy are read-only — sending them is ignored, not applied", async () => {
    const { app, cookie } = await appWithSession();
    const res = await app.request("/memory/config", {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ embeddingModel: "evil/model", privacy: "shared", defaultEnabled: true }),
    });
    expect(res.status).toBe(200);
    const cfg = (await res.json()) as { embeddingModel: string; privacy: string; defaultEnabled: boolean };
    expect(cfg.embeddingModel).toBe("text-embedding-3-small"); // unchanged
    expect(cfg.privacy).toBe("agent-scoped"); // unchanged
    expect(cfg.defaultEnabled).toBe(true); // the legit field still applied
  });

  it("is session-guarded — 401 without a cookie", async () => {
    const { app } = await appWithSession();
    expect((await app.request("/memory/config")).status).toBe(401);
    const patch = await app.request("/memory/config", { method: "PATCH", headers: { "content-type": "application/json" }, body: "{}" });
    expect(patch.status).toBe(401);
  });
});

describe("memory routes — agent-scoped purge (Story 8.2, FR-7)", () => {
  it("DELETE /memory/agents/:id purges ONLY that agent's memories", async () => {
    const repo = memoryMemoryRepo();
    await repo.createMemory(memRow({ id: "a1", agentId: "agent-A" }));
    await repo.createMemory(memRow({ id: "a2", agentId: "agent-A" }));
    await repo.createMemory(memRow({ id: "b1", agentId: "agent-B" }));
    const { app, cookie } = await appWithSession(repo);

    const res = await app.request("/memory/agents/agent-A", { method: "DELETE", headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ purged: 2 });

    // A is emptied; B is untouched (FR-7 — no cross-agent effect).
    expect(await repo.listForAgent("agent-A")).toHaveLength(0);
    expect(await repo.listForAgent("agent-B")).toHaveLength(1);
  });

  it("purge is session-guarded — 401 without a cookie", async () => {
    const { app } = await appWithSession();
    expect((await app.request("/memory/agents/agent-A", { method: "DELETE" })).status).toBe(401);
  });
});

describe("memory routes — observability + curation (Story 8.5)", () => {
  const embedded = (over: Partial<MemoryRow> & { id: string; agentId: string; content: string }) => memRow({ ...over, embedding: fakeEmbed(over.content) });

  it("GET /memory/agents/:id lists the agent's memories as a view (no embedding), pinned-first", async () => {
    const repo = memoryMemoryRepo();
    await repo.createMemory(embedded({ id: "m1", agentId: "A", content: "low", salience: 1 }));
    await repo.createMemory(embedded({ id: "m2", agentId: "A", content: "high", salience: 9 }));
    await repo.createMemory(embedded({ id: "m3", agentId: "A", content: "pinned", salience: 0, pinned: true }));
    await repo.createMemory(embedded({ id: "b1", agentId: "B", content: "other agent" }));
    const { app, cookie } = await appWithSession(repo);

    const res = await app.request("/memory/agents/A", { headers: { cookie } });
    expect(res.status).toBe(200);
    const { memories } = (await res.json()) as { memories: { id: string; pinned: boolean }[] };
    expect(memories.map((m) => m.id)).toEqual(["m3", "m2", "m1"]); // pinned first, then salience desc; B never appears (FR-7)
    expect(memories[0]).not.toHaveProperty("embedding"); // the vector is dropped from the view
  });

  it("PATCH edits content (re-embeds) + summary + pinned; unknown id 404; bad body 400", async () => {
    const repo = memoryMemoryRepo();
    await repo.createMemory(embedded({ id: "m1", agentId: "A", content: "old content", summary: "old" }));
    const { app, cookie } = await appWithSession(repo);

    const res = await app.request("/memory/agents/A/m1", {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ content: "new content", summary: "new", pinned: true }),
    });
    expect(res.status).toBe(200);
    const { memory } = (await res.json()) as { memory: { summary: string; pinned: boolean } };
    expect(memory).toMatchObject({ summary: "new", pinned: true });
    // content changed → re-embedded to the new vector.
    expect((await repo.getMemory("A", "m1"))!.embedding).toEqual(fakeEmbed("new content"));

    expect((await app.request("/memory/agents/A/nope", { method: "PATCH", headers: { "content-type": "application/json", cookie }, body: "{}" })).status).toBe(404);
    expect((await app.request("/memory/agents/A/m1", { method: "PATCH", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ pinned: "yes" }) })).status).toBe(400);
  });

  it("DELETE /memory/agents/:id/:memId forgets ONE (404 unknown); agent-scoped (FR-7)", async () => {
    const repo = memoryMemoryRepo();
    await repo.createMemory(embedded({ id: "m1", agentId: "A", content: "x" }));
    await repo.createMemory(embedded({ id: "b1", agentId: "B", content: "y" }));
    const { app, cookie } = await appWithSession(repo);

    // Agent A cannot forget B's memory (scoped by the URL agentId → 404, and B's row survives).
    expect((await app.request("/memory/agents/A/b1", { method: "DELETE", headers: { cookie } })).status).toBe(404);
    expect(await repo.getMemory("B", "b1")).not.toBeNull();

    const ok = await app.request("/memory/agents/A/m1", { method: "DELETE", headers: { cookie } });
    expect(ok.status).toBe(200);
    expect(await repo.getMemory("A", "m1")).toBeNull();
    expect((await app.request("/memory/agents/A/m1", { method: "DELETE", headers: { cookie } })).status).toBe(404); // already gone
  });

  it("the curation routes are session-guarded (401 without a cookie)", async () => {
    const { app } = await appWithSession();
    expect((await app.request("/memory/agents/A")).status).toBe(401);
    expect((await app.request("/memory/agents/A/m1", { method: "PATCH", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
    expect((await app.request("/memory/agents/A/m1", { method: "DELETE" })).status).toBe(401);
  });
});

describe("memory routes — oversight: staged approval + quarantine + changelog (Story 8.6)", () => {
  it("PATCH /memory/config validates requireApprovalDefault (bool round-trips; non-bool 400)", async () => {
    const { app, cookie } = await appWithSession();
    const ok = await app.request("/memory/config", {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ requireApprovalDefault: true }),
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { requireApprovalDefault: boolean }).requireApprovalDefault).toBe(true);

    const bad = await app.request("/memory/config", {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ requireApprovalDefault: "yes" }),
    });
    expect(bad.status).toBe(400);
  });

  it("POST accept moves a PENDING memory → active and logs 'accepted'; a non-pending accept is 400", async () => {
    const repo = memoryMemoryRepo();
    await repo.createMemory(memRow({ id: "p", agentId: "A", status: "pending" }));
    await repo.createMemory(memRow({ id: "a", agentId: "A", status: "active" }));
    const { app, cookie } = await appWithSession(repo);

    const res = await app.request("/memory/agents/A/p/accept", { method: "POST", headers: { cookie } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { memory: { status: string } }).memory.status).toBe("active");
    expect((await repo.getMemory("A", "p"))!.status).toBe("active");
    // Accepting an already-active memory is a no-op error (guarded transition).
    expect((await app.request("/memory/agents/A/a/accept", { method: "POST", headers: { cookie } })).status).toBe(400);
    // 404 for an unknown memory.
    expect((await app.request("/memory/agents/A/nope/accept", { method: "POST", headers: { cookie } })).status).toBe(404);

    const events = await repo.listMemoryEvents("A", 10);
    expect(events[0]).toMatchObject({ kind: "accepted", memoryId: "p" });
  });

  it("POST quarantine (active→quarantined) then unquarantine (→active); each logs; bad transitions 400", async () => {
    const repo = memoryMemoryRepo();
    await repo.createMemory(memRow({ id: "m", agentId: "A", status: "active" }));
    const { app, cookie } = await appWithSession(repo);

    const q = await app.request("/memory/agents/A/m/quarantine", { method: "POST", headers: { cookie } });
    expect(q.status).toBe(200);
    expect((await repo.getMemory("A", "m"))!.status).toBe("quarantined");
    // Quarantining an already-quarantined memory isn't a valid transition.
    expect((await app.request("/memory/agents/A/m/quarantine", { method: "POST", headers: { cookie } })).status).toBe(400);

    const u = await app.request("/memory/agents/A/m/unquarantine", { method: "POST", headers: { cookie } });
    expect(u.status).toBe(200);
    expect((await repo.getMemory("A", "m"))!.status).toBe("active");
    // Un-quarantining an active memory isn't valid either.
    expect((await app.request("/memory/agents/A/m/unquarantine", { method: "POST", headers: { cookie } })).status).toBe(400);

    // Both transitions are recorded (their relative order is timestamp-based; assert membership, not order).
    expect((await repo.listMemoryEvents("A", 10)).map((e) => e.kind).sort()).toEqual(["quarantined", "unquarantined"]);
  });

  it("DELETE of a PENDING memory logs 'rejected'; of an active one logs 'forgotten'", async () => {
    const repo = memoryMemoryRepo();
    await repo.createMemory(memRow({ id: "p", agentId: "A", status: "pending" }));
    await repo.createMemory(memRow({ id: "a", agentId: "A", status: "active" }));
    const { app, cookie } = await appWithSession(repo);

    await app.request("/memory/agents/A/p", { method: "DELETE", headers: { cookie } });
    await app.request("/memory/agents/A/a", { method: "DELETE", headers: { cookie } });
    // The pending delete is a reject; the active delete is a forget (order is timestamp-based).
    expect((await repo.listMemoryEvents("A", 10)).map((e) => e.kind).sort()).toEqual(["forgotten", "rejected"]);
  });

  it("GET /memory/agents/:id/events returns the changelog newest-first, agent-scoped (FR-7)", async () => {
    const repo = memoryMemoryRepo();
    await repo.logMemoryEvent({ id: ulid(1), agentId: "A", memoryId: "m1", kind: "learned", summary: "s1", sourceRunId: "run-1", at: "2026-08-05T00:00:01.000Z" });
    await repo.logMemoryEvent({ id: ulid(2), agentId: "A", memoryId: "m1", kind: "accepted", summary: "s1", sourceRunId: null, at: "2026-08-05T00:00:02.000Z" });
    await repo.logMemoryEvent({ id: ulid(3), agentId: "B", memoryId: "b1", kind: "learned", summary: "other", sourceRunId: null, at: "2026-08-05T00:00:03.000Z" });
    const { app, cookie } = await appWithSession(repo);

    const res = await app.request("/memory/agents/A/events", { headers: { cookie } });
    expect(res.status).toBe(200);
    const { events } = (await res.json()) as { events: { kind: string; agentId: string }[] };
    expect(events.map((e) => e.kind)).toEqual(["accepted", "learned"]); // newest first
    expect(events.every((e) => e.agentId === "A")).toBe(true); // never another agent's history
  });

  it("the oversight routes are session-guarded (401 without a cookie)", async () => {
    const { app } = await appWithSession();
    expect((await app.request("/memory/agents/A/m/accept", { method: "POST" })).status).toBe(401);
    expect((await app.request("/memory/agents/A/m/quarantine", { method: "POST" })).status).toBe(401);
    expect((await app.request("/memory/agents/A/m/unquarantine", { method: "POST" })).status).toBe(401);
    expect((await app.request("/memory/agents/A/events")).status).toBe(401);
  });
});
