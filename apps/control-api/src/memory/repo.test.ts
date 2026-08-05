import { describe, it, expect } from "vitest";
import { ulid, effectiveMemoryConfig, DEFAULT_MEMORY_CONFIG, DEFAULT_MEMORY_GLOBAL_CONFIG, type MemoryConfig } from "@turanga/domain";
import { createApp } from "../app.js";
import { memoryAuthRepo, type AuthRepo } from "../auth/repo.js";
import { hashPassword } from "../auth/password.js";
import { memoryMemoryRepo, type MemoryRow } from "./repo.js";

const EMAIL = "admin@turanga.local";
const PW = "pw-for-tests-123456";
let clientSeq = 0;
async function appWithSession() {
  const authRepo: AuthRepo = memoryAuthRepo();
  await authRepo.createUser({ id: ulid(1), email: EMAIL, passwordHash: await hashPassword(PW) });
  const memoryRepo = memoryMemoryRepo();
  const app = createApp({ authRepo, memoryRepo }); // Story 8.1 — the repo wires without error
  const login = await app.request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `10.8.0.${clientSeq++}` },
    body: JSON.stringify({ email: EMAIL, password: PW }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  return { app, cookie, memoryRepo };
}

const memRow = (over: Partial<MemoryRow> = {}): MemoryRow => ({
  id: ulid(1),
  agentId: "agent-A",
  kind: "semantic",
  content: "the user prefers concise replies",
  summary: "prefers concise",
  embedding: null, // populated by recall (8.3), not this story
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

describe("memory repo — agent-scoped store (Story 8.1)", () => {
  it("creates, lists, gets, and deletes a memory scoped to its agent", async () => {
    const repo = memoryMemoryRepo();
    const m = memRow({ id: "m1", agentId: "agent-A" });
    await repo.createMemory(m);

    expect(await repo.listForAgent("agent-A")).toHaveLength(1);
    expect(await repo.getMemory("agent-A", "m1")).toMatchObject({ id: "m1", content: m.content, embedding: null });

    await repo.deleteMemory("agent-A", "m1");
    expect(await repo.listForAgent("agent-A")).toHaveLength(0);
  });

  it("never leaks a memory across the agent boundary (FR-7)", async () => {
    const repo = memoryMemoryRepo();
    await repo.createMemory(memRow({ id: "mA", agentId: "agent-A" }));
    await repo.createMemory(memRow({ id: "mB", agentId: "agent-B" }));

    // A's list has only A's memory; B can neither list nor get A's memory.
    expect((await repo.listForAgent("agent-A")).map((r) => r.id)).toEqual(["mA"]);
    expect(await repo.getMemory("agent-B", "mA")).toBeNull();
    // A delete keyed to the wrong agent is a no-op — B cannot delete A's memory by guessing the id.
    await repo.deleteMemory("agent-B", "mA");
    expect(await repo.getMemory("agent-A", "mA")).not.toBeNull();
  });

  it("the repo exposes NO cross-agent read (no unscoped list method)", () => {
    const repo = memoryMemoryRepo();
    // Every accessor is agent-keyed; there is deliberately no `listAll`/unscoped query surface.
    const surface = repo as unknown as Record<string, unknown>;
    expect(surface.listAll).toBeUndefined();
    expect(surface.listAllMemories).toBeUndefined();
    expect(Object.keys(repo)).not.toContain("listAllMemories");
  });

  it("global config seeds OFF on first read and round-trips a patch", async () => {
    const repo = memoryMemoryRepo();
    const seeded = await repo.getGlobalConfig();
    expect(seeded).toEqual(DEFAULT_MEMORY_GLOBAL_CONFIG);
    expect(seeded.defaultEnabled).toBe(false); // OFF by default (AC3)
    expect(seeded.killSwitch).toBe(false);

    const updated = await repo.setGlobalConfig({ defaultEnabled: true });
    expect(updated.defaultEnabled).toBe(true);
    expect(updated.privacy).toBe("agent-scoped"); // privacy is pinned, never widened by a patch
    expect((await repo.getGlobalConfig()).defaultEnabled).toBe(true);
  });

  it("per-agent config defaults to inherit and round-trips", async () => {
    const repo = memoryMemoryRepo();
    const fresh = await repo.getAgentMemoryConfig("new-agent");
    expect(fresh).toEqual(DEFAULT_MEMORY_CONFIG);
    expect(fresh.mode).toBe("inherit");

    await repo.setAgentMemoryConfig("new-agent", { mode: "on", recall: true, reflect: false, kinds: ["semantic"] });
    expect(await repo.getAgentMemoryConfig("new-agent")).toEqual({ mode: "on", recall: true, reflect: false, kinds: ["semantic"] });
  });

  it("off by default, end-to-end: a fresh agent's inherit config resolves to disabled", async () => {
    const repo = memoryMemoryRepo();
    const global = await repo.getGlobalConfig(); // seeds OFF
    const perAgent = await repo.getAgentMemoryConfig("fresh"); // inherit
    expect(effectiveMemoryConfig(global, perAgent).enabled).toBe(false);
  });
});

describe("memory wiring — createApp boots + a new agent is off by default (Story 8.1)", () => {
  it("createApp({ memoryRepo }) wires, and a freshly created agent has inherit config that resolves disabled", async () => {
    const { app, cookie } = await appWithSession();

    const created = await app.request("/agents", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "memoryless" }),
    });
    expect(created.status).toBe(201);
    const { agent } = (await created.json()) as { agent: { memoryConfig: MemoryConfig; changedFields: string[] } };

    // A new agent ships inherit + all-kinds, and with the OFF global default that is effectively off.
    expect(agent.memoryConfig).toEqual(DEFAULT_MEMORY_CONFIG);
    expect(effectiveMemoryConfig(DEFAULT_MEMORY_GLOBAL_CONFIG, agent.memoryConfig).enabled).toBe(false);
    // memoryConfig is operational, NOT part of the published definition — it never shows as a dirty field.
    expect(agent.changedFields).not.toContain("memoryConfig");
  });
});
