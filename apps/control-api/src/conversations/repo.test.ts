import { describe, it, expect } from "vitest";
import { memoryConversationsRepo, type ConversationRow } from "./repo.js";

const row = (over: Partial<ConversationRow> & { id: string; agentId: string }): ConversationRow => ({
  publishedVersion: 1,
  title: "",
  createdAt: "2026-08-05T00:00:00.000Z",
  ...over,
});

describe("conversations repo — control-plane store (Story 9.1)", () => {
  it("creates, gets, and lists a conversation scoped to its agent", async () => {
    const repo = memoryConversationsRepo();
    await repo.create(row({ id: "c1", agentId: "A", publishedVersion: 3, title: "digest" }));
    expect(await repo.get("c1")).toMatchObject({ id: "c1", agentId: "A", publishedVersion: 3, title: "digest" });
    expect((await repo.listForAgent("A")).map((c) => c.id)).toEqual(["c1"]);
    expect(await repo.get("missing")).toBeNull();
  });

  it("listForAgent is agent-scoped and newest-first", async () => {
    const repo = memoryConversationsRepo();
    await repo.create(row({ id: "a1", agentId: "A" }));
    await repo.create(row({ id: "a2", agentId: "A" }));
    await repo.create(row({ id: "b1", agentId: "B" }));

    expect((await repo.listForAgent("A")).map((c) => c.id)).toEqual(["a2", "a1"]); // newest first (create order)
    expect((await repo.listForAgent("B")).map((c) => c.id)).toEqual(["b1"]); // never A's
    expect(await repo.listForAgent("nobody")).toEqual([]);
  });
});
