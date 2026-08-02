import { desc, eq } from "drizzle-orm";
import type { ControlChannelMessage } from "@turanga/contracts";
import type { Db } from "../db/client.js";
import { runs } from "../db/schema.js";

export type RunStatus = "created" | "running" | "succeeded" | "failed" | "killed";

export interface RunRow {
  id: string;
  agentId: string;
  status: RunStatus;
  taskInput: string;
  transcript: ControlChannelMessage[];
  reason: string | null;
  createdAt: string; // UTC ISO-8601
  endedAt: string | null;
}

// Written only by the run-orchestrator (AD-7). No `update(patch)` surface beyond these.
export interface RunsRepo {
  create(row: RunRow): Promise<void>;
  get(id: string): Promise<RunRow | null>;
  list(agentId?: string): Promise<RunRow[]>; // newest first
  setStatus(id: string, status: RunStatus, patch?: { reason?: string | null; endedAt?: string }): Promise<void>;
  appendMessage(id: string, msg: ControlChannelMessage): Promise<void>;
}

function toRow(r: typeof runs.$inferSelect): RunRow {
  return {
    id: r.id,
    agentId: r.agentId,
    status: r.status as RunStatus,
    taskInput: r.taskInput,
    transcript: r.transcript as ControlChannelMessage[],
    reason: r.reason,
    createdAt: r.createdAt.toISOString(),
    endedAt: r.endedAt ? r.endedAt.toISOString() : null,
  };
}

export function drizzleRunsRepo(db: Db): RunsRepo {
  return {
    async create(row) {
      await db.insert(runs).values({
        id: row.id,
        agentId: row.agentId,
        status: row.status,
        taskInput: row.taskInput,
        transcript: row.transcript,
        reason: row.reason,
        createdAt: new Date(row.createdAt),
        endedAt: row.endedAt ? new Date(row.endedAt) : null,
      });
    },
    async get(id) {
      const rows = await db.select().from(runs).where(eq(runs.id, id)).limit(1);
      return rows[0] ? toRow(rows[0]) : null;
    },
    async list(agentId) {
      const base = db.select().from(runs).orderBy(desc(runs.createdAt), desc(runs.id));
      const rows = agentId ? await db.select().from(runs).where(eq(runs.agentId, agentId)).orderBy(desc(runs.createdAt), desc(runs.id)) : await base;
      return rows.map(toRow);
    },
    async setStatus(id, status, patch) {
      const set: Partial<typeof runs.$inferInsert> = { status };
      if (patch && "reason" in patch) set.reason = patch.reason ?? null;
      if (patch?.endedAt) set.endedAt = new Date(patch.endedAt);
      await db.update(runs).set(set).where(eq(runs.id, id));
    },
    async appendMessage(id, msg) {
      // Read-modify-write; a single orchestrator writes a given run, so no contention (AD-7).
      const cur = await this.get(id);
      if (!cur) return;
      await db.update(runs).set({ transcript: [...cur.transcript, msg] }).where(eq(runs.id, id));
    },
  };
}

export function memoryRunsRepo(): RunsRepo {
  const rows = new Map<string, RunRow>();
  const order: string[] = [];
  return {
    async create(row) {
      rows.set(row.id, { ...row, transcript: [...row.transcript] });
      order.unshift(row.id);
    },
    async get(id) {
      const r = rows.get(id);
      return r ? { ...r, transcript: [...r.transcript] } : null;
    },
    async list(agentId) {
      return order.map((id) => rows.get(id)!).filter((r) => (agentId ? r.agentId === agentId : true)).map((r) => ({ ...r, transcript: [...r.transcript] }));
    },
    async setStatus(id, status, patch) {
      const r = rows.get(id);
      if (!r) return;
      r.status = status;
      if (patch && "reason" in patch) r.reason = patch.reason ?? null;
      if (patch?.endedAt) r.endedAt = patch.endedAt;
    },
    async appendMessage(id, msg) {
      rows.get(id)?.transcript.push(msg);
    },
  };
}
