import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { conversations } from "../db/schema.js";

// A chat conversation (Epic 9, Story 9.1) — a control-plane thread pinned to a PUBLISHED agent
// version. Written ONLY by control-api (AD-7). Agent-scoped reads. `publishedVersion` is pinned at
// creation (latest-at-conversation-start) and never null (chat runs a published snapshot, never the
// draft). Rename/delete land in Story 9.4.
export interface ConversationRow {
  id: string;
  agentId: string;
  publishedVersion: number;
  title: string;
  createdAt: string; // UTC ISO-8601
}

export interface ConversationsRepo {
  create(row: ConversationRow): Promise<void>;
  get(id: string): Promise<ConversationRow | null>;
  listForAgent(agentId: string): Promise<ConversationRow[]>; // newest first
  rename(id: string, title: string): Promise<void>; // Story 9.4
  delete(id: string): Promise<void>; // Story 9.4 — the conversation row only; the cascade of its runs is the route's job
}

function toRow(r: typeof conversations.$inferSelect): ConversationRow {
  return {
    id: r.id,
    agentId: r.agentId,
    publishedVersion: r.publishedVersion,
    title: r.title,
    createdAt: r.createdAt.toISOString(),
  };
}

export function drizzleConversationsRepo(db: Db): ConversationsRepo {
  return {
    async create(row) {
      await db.insert(conversations).values({
        id: row.id,
        agentId: row.agentId,
        publishedVersion: row.publishedVersion,
        title: row.title,
        createdAt: new Date(row.createdAt),
      });
    },
    async get(id) {
      const rows = await db.select().from(conversations).where(eq(conversations.id, id)).limit(1);
      return rows[0] ? toRow(rows[0]) : null;
    },
    async listForAgent(agentId) {
      const rows = await db
        .select()
        .from(conversations)
        .where(eq(conversations.agentId, agentId))
        .orderBy(desc(conversations.createdAt), desc(conversations.id));
      return rows.map(toRow);
    },
    async rename(id, title) {
      await db.update(conversations).set({ title }).where(eq(conversations.id, id));
    },
    async delete(id) {
      await db.delete(conversations).where(eq(conversations.id, id));
    },
  };
}

export function memoryConversationsRepo(): ConversationsRepo {
  const rows = new Map<string, ConversationRow>();
  const order: string[] = []; // newest first (unshift on create)
  return {
    async create(row) {
      rows.set(row.id, { ...row });
      order.unshift(row.id);
    },
    async get(id) {
      const r = rows.get(id);
      return r ? { ...r } : null;
    },
    async listForAgent(agentId) {
      return order
        .map((id) => rows.get(id)!)
        .filter((r) => r.agentId === agentId)
        .map((r) => ({ ...r }));
    },
    async rename(id, title) {
      const r = rows.get(id);
      if (r) r.title = title;
    },
    async delete(id) {
      rows.delete(id);
      const i = order.indexOf(id);
      if (i >= 0) order.splice(i, 1);
    },
  };
}
