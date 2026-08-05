import { describe, it, expect } from "vitest";
import { ulid, DEFAULT_MEMORY_GLOBAL_CONFIG } from "@turanga/domain";
import { createApp } from "../app.js";
import { memoryAuthRepo, type AuthRepo } from "../auth/repo.js";
import { hashPassword } from "../auth/password.js";
import { memoryMemoryRepo, type MemoryRepo, type MemoryRow } from "./repo.js";

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
