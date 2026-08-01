import { desc, eq } from "drizzle-orm";
import type { LifecycleState } from "@turanga/domain";
import type { Db } from "../db/client.js";
import { agents } from "../db/schema.js";

export interface AgentRow {
  id: string;
  name: string;
  state: LifecycleState;
  createdAt: string; // UTC ISO-8601
}

export interface AgentsRepo {
  list(): Promise<AgentRow[]>; // newest first
  get(id: string): Promise<AgentRow | null>;
  create(row: AgentRow): Promise<void>;
}

function toRow(r: typeof agents.$inferSelect): AgentRow {
  return { id: r.id, name: r.name, state: r.state as LifecycleState, createdAt: r.createdAt.toISOString() };
}

export function drizzleAgentsRepo(db: Db): AgentsRepo {
  return {
    async list() {
      // Newest first; id (a ULID) as a deterministic tiebreak for same-ms creates.
      return (await db.select().from(agents).orderBy(desc(agents.createdAt), desc(agents.id))).map(toRow);
    },
    async get(id) {
      const rows = await db.select().from(agents).where(eq(agents.id, id)).limit(1);
      return rows[0] ? toRow(rows[0]) : null;
    },
    async create(row) {
      await db.insert(agents).values({ id: row.id, name: row.name, state: row.state });
    },
  };
}

export function memoryAgentsRepo(): AgentsRepo {
  const rows: { row: AgentRow; seq: number }[] = [];
  let seq = 0;
  return {
    async list() {
      // Newest first; insertion sequence breaks same-ms createdAt ties deterministically.
      return [...rows]
        .sort((a, b) => b.row.createdAt.localeCompare(a.row.createdAt) || b.seq - a.seq)
        .map((r) => r.row);
    },
    async get(id) {
      return rows.find((r) => r.row.id === id)?.row ?? null;
    },
    async create(row) {
      rows.push({ row: { ...row }, seq: seq++ });
    },
  };
}
