import { and, desc, eq, gte, sql } from "drizzle-orm";
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
  costMicros: number; // persisted run-cost summary in micro-USD (Story 4.5) = summed metrics (no drift)
  createdAt: string; // UTC ISO-8601
  endedAt: string | null;
}

// Written only by the run-orchestrator (AD-7). No `update(patch)` surface beyond these. LiteLLM owns
// spend; this `costMicros` summary is the summed run metrics the Guard reported (AD-7 — read, not recomputed).
export interface RunsRepo {
  create(row: Omit<RunRow, "costMicros"> & { costMicros?: number }): Promise<void>;
  get(id: string): Promise<RunRow | null>;
  list(agentId?: string, limit?: number): Promise<RunRow[]>; // newest first, bounded
  setStatus(id: string, status: RunStatus, patch?: { reason?: string | null; endedAt?: string; costMicros?: number }): Promise<void>;
  appendMessage(id: string, msg: ControlChannelMessage): Promise<void>;
  sumTodayMicros(agentId: string): Promise<number>; // agent's summed run cost since UTC midnight (daily meter)
  sumTodayMicrosByAgent(): Promise<Record<string, number>>; // every agent's summed run cost since UTC midnight (agents-list meter, Story 5.2) — same window/source as sumTodayMicros
}

const DEFAULT_LIST_LIMIT = 100;
const startOfUtcToday = (): Date => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
};

function toRow(r: typeof runs.$inferSelect): RunRow {
  return {
    id: r.id,
    agentId: r.agentId,
    status: r.status as RunStatus,
    taskInput: r.taskInput,
    transcript: r.transcript as ControlChannelMessage[],
    reason: r.reason,
    costMicros: r.costMicros ?? 0,
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
        costMicros: row.costMicros ?? 0,
        createdAt: new Date(row.createdAt),
        endedAt: row.endedAt ? new Date(row.endedAt) : null,
      });
    },
    async get(id) {
      const rows = await db.select().from(runs).where(eq(runs.id, id)).limit(1);
      return rows[0] ? toRow(rows[0]) : null;
    },
    async list(agentId, limit = DEFAULT_LIST_LIMIT) {
      const q = db.select().from(runs).orderBy(desc(runs.createdAt), desc(runs.id)).limit(limit);
      const rows = agentId ? await q.where(eq(runs.agentId, agentId)) : await q;
      return rows.map(toRow);
    },
    async setStatus(id, status, patch) {
      const set: Partial<typeof runs.$inferInsert> = { status };
      if (patch && "reason" in patch) set.reason = patch.reason ?? null;
      if (patch?.endedAt) set.endedAt = new Date(patch.endedAt);
      if (patch?.costMicros !== undefined) set.costMicros = patch.costMicros;
      await db.update(runs).set(set).where(eq(runs.id, id));
    },
    async appendMessage(id, msg) {
      // DB-level jsonb append (avoids an O(n²) read-modify-write and a lost-update race).
      await db
        .update(runs)
        .set({ transcript: sql`${runs.transcript} || ${JSON.stringify([msg])}::jsonb` })
        .where(eq(runs.id, id));
    },
    async sumTodayMicros(agentId) {
      const rows = await db
        .select({ total: sql<number>`coalesce(sum(${runs.costMicros}), 0)` })
        .from(runs)
        .where(and(eq(runs.agentId, agentId), gte(runs.createdAt, startOfUtcToday())));
      return Number(rows[0]?.total ?? 0);
    },
    async sumTodayMicrosByAgent() {
      const rows = await db
        .select({ agentId: runs.agentId, total: sql<number>`coalesce(sum(${runs.costMicros}), 0)` })
        .from(runs)
        .where(gte(runs.createdAt, startOfUtcToday()))
        .groupBy(runs.agentId);
      const out: Record<string, number> = {};
      for (const r of rows) out[r.agentId] = Number(r.total);
      return out;
    },
  };
}

export function memoryRunsRepo(): RunsRepo {
  const rows = new Map<string, RunRow>();
  const order: string[] = [];
  return {
    async create(row) {
      rows.set(row.id, { costMicros: 0, ...row, transcript: [...row.transcript] });
      order.unshift(row.id);
    },
    async get(id) {
      const r = rows.get(id);
      return r ? { ...r, transcript: [...r.transcript] } : null;
    },
    async list(agentId, limit = DEFAULT_LIST_LIMIT) {
      return order
        .map((id) => rows.get(id)!)
        .filter((r) => (agentId ? r.agentId === agentId : true))
        .slice(0, limit)
        .map((r) => ({ ...r, transcript: [...r.transcript] }));
    },
    async setStatus(id, status, patch) {
      const r = rows.get(id);
      if (!r) return;
      r.status = status;
      if (patch && "reason" in patch) r.reason = patch.reason ?? null;
      if (patch?.endedAt) r.endedAt = patch.endedAt;
      if (patch?.costMicros !== undefined) r.costMicros = patch.costMicros;
    },
    async appendMessage(id, msg) {
      rows.get(id)?.transcript.push(msg);
    },
    async sumTodayMicros(agentId) {
      const midnight = startOfUtcToday().toISOString();
      return [...rows.values()].filter((r) => r.agentId === agentId && r.createdAt >= midnight).reduce((s, r) => s + r.costMicros, 0);
    },
    async sumTodayMicrosByAgent() {
      const midnight = startOfUtcToday().toISOString();
      const out: Record<string, number> = {};
      for (const r of rows.values()) {
        if (r.createdAt >= midnight) out[r.agentId] = (out[r.agentId] ?? 0) + r.costMicros;
      }
      return out;
    },
  };
}
