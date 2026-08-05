import { and, asc, desc, eq, gte, isNotNull, sql } from "drizzle-orm";
import type { ControlChannelMessage } from "@turanga/contracts";
import type { Db } from "../db/client.js";
import { runs } from "../db/schema.js";

export type RunStatus = "created" | "running" | "succeeded" | "failed" | "killed";

export interface RunRow {
  id: string;
  agentId: string;
  // Story 9.1 — the run↔conversation link. NULL for a standalone/test-console run; a chat turn
  // (Story 9.2) sets both (its conversation + its 0-based position in the thread).
  conversationId: string | null;
  turnIndex: number | null;
  status: RunStatus;
  taskInput: string;
  transcript: ControlChannelMessage[];
  reason: string | null;
  costMicros: number; // persisted run-cost summary in micro-USD (Story 4.5) = summed metrics (no drift)
  createdAt: string; // UTC ISO-8601
  endedAt: string | null;
}

// A run WITHOUT its (potentially large) transcript — the run-history list projection (Story 5.3).
// The review view fetches the full RunRow (with transcript) via get(id).
export type RunSummary = Omit<RunRow, "transcript">;

// Per-tool invocation statistics for an agent (Story 6.5) — derived from the `tool` control messages
// recorded on the agent's run transcripts. Observed only: NO cost here (AC2). `lastUsedAt` is the
// run's createdAt (per-run granularity — the tool message carries no timestamp of its own).
export interface ToolStat {
  toolId: string;
  toolName: string;
  invocations: number;
  ok: number;
  errors: number;
  refusals: number;
  avgLatencyMs: number;
  lastUsedAt: string | null;
}

// Reduce `tool` control messages across runs into per-tool stats (pure — shared by both repo impls).
export function reduceToolStats(runs: { transcript: ControlChannelMessage[]; createdAt: string }[]): ToolStat[] {
  const acc = new Map<string, { toolName: string; invocations: number; ok: number; errors: number; refusals: number; totalLatency: number; lastUsedAt: string | null }>();
  for (const run of runs) {
    for (const m of run.transcript) {
      if (m.type !== "tool") continue;
      // Runs are scanned newest-first, so the FIRST message seen for a toolId (the `?? {...}` default)
      // captures the freshest display name; don't overwrite it with older runs' names.
      const e = acc.get(m.toolId) ?? { toolName: m.toolName, invocations: 0, ok: 0, errors: 0, refusals: 0, totalLatency: 0, lastUsedAt: null };
      e.invocations++;
      if (m.outcome === "ok") e.ok++;
      else if (m.outcome === "refused") e.refusals++;
      else e.errors++;
      e.totalLatency += m.latencyMs;
      if (!e.lastUsedAt || run.createdAt > e.lastUsedAt) e.lastUsedAt = run.createdAt;
      acc.set(m.toolId, e);
    }
  }
  return [...acc.entries()].map(([toolId, e]) => ({
    toolId,
    toolName: e.toolName,
    invocations: e.invocations,
    ok: e.ok,
    errors: e.errors,
    refusals: e.refusals,
    avgLatencyMs: e.invocations ? Math.round(e.totalLatency / e.invocations) : 0,
    lastUsedAt: e.lastUsedAt,
  }));
}

// Run LIFECYCLE (create/status/cost/append) is written only by the run-orchestrator (AD-7). LiteLLM
// owns spend; this `costMicros` summary is the summed run metrics the Guard reported (AD-7 — read, not
// recomputed). The one sanctioned exception is `deleteByConversation` (Story 9.4): a control-plane
// CLEANUP of a deleted conversation's turns, initiated by control-api — not a lifecycle write.
export interface RunsRepo {
  // conversationId/turnIndex default null (a standalone/test-console run has no conversation); a chat
  // turn (Story 9.2) passes both. costMicros defaults 0 (filled from the summed metrics later).
  create(row: Omit<RunRow, "costMicros" | "conversationId" | "turnIndex"> & { costMicros?: number; conversationId?: string | null; turnIndex?: number | null }): Promise<void>;
  get(id: string): Promise<RunRow | null>;
  list(agentId?: string, limit?: number): Promise<RunRow[]>; // newest first, bounded
  listSummary(agentId?: string, limit?: number): Promise<RunSummary[]>; // newest first, bounded — run history (Story 5.3), no transcript
  listByConversation(conversationId: string): Promise<RunRow[]>; // a conversation's turns, turnIndex ASC, WITH transcript (chat history, Story 9.2)
  deleteByConversation(conversationId: string): Promise<void>; // cascade a deleted conversation's turns (Story 9.4)
  lastActivityByAgent(agentId: string): Promise<Record<string, string>>; // { conversationId → newest run createdAt (ISO) } for the agent (Story 9.4)

  setStatus(id: string, status: RunStatus, patch?: { reason?: string | null; endedAt?: string; costMicros?: number }): Promise<void>;
  appendMessage(id: string, msg: ControlChannelMessage): Promise<void>;
  sumTodayMicros(agentId: string): Promise<number>; // agent's summed run cost since UTC midnight (daily meter)
  sumTodayMicrosByAgent(): Promise<Record<string, number>>; // every agent's summed run cost since UTC midnight (agents-list meter, Story 5.2) — same window/source as sumTodayMicros
  aggregateToolStats(agentId: string): Promise<ToolStat[]>; // per-tool invocation stats from the agent's run transcripts (Story 6.5, observed only)
}

const TOOL_STATS_RUN_WINDOW = 500; // bound the aggregation to recent runs (tool messages are sparse)

const DEFAULT_LIST_LIMIT = 100;
const startOfUtcToday = (): Date => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
};

function toRow(r: typeof runs.$inferSelect): RunRow {
  return {
    id: r.id,
    agentId: r.agentId,
    conversationId: r.conversationId,
    turnIndex: r.turnIndex,
    status: r.status as RunStatus,
    taskInput: r.taskInput,
    transcript: r.transcript as ControlChannelMessage[],
    reason: r.reason,
    costMicros: r.costMicros ?? 0,
    createdAt: r.createdAt.toISOString(),
    endedAt: r.endedAt ? r.endedAt.toISOString() : null,
  };
}

// The summary column selection (everything except the transcript) for the run-history list projection.
const summaryCols = {
  id: runs.id,
  agentId: runs.agentId,
  conversationId: runs.conversationId,
  turnIndex: runs.turnIndex,
  status: runs.status,
  taskInput: runs.taskInput,
  reason: runs.reason,
  costMicros: runs.costMicros,
  createdAt: runs.createdAt,
  endedAt: runs.endedAt,
} as const;
type SummarySelect = { [K in keyof typeof summaryCols]: (typeof runs.$inferSelect)[K] };
function toSummary(r: SummarySelect): RunSummary {
  return {
    id: r.id,
    agentId: r.agentId,
    conversationId: r.conversationId,
    turnIndex: r.turnIndex,
    status: r.status as RunStatus,
    taskInput: r.taskInput,
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
        conversationId: row.conversationId ?? null,
        turnIndex: row.turnIndex ?? null,
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
    async listByConversation(conversationId) {
      const rows = await db.select().from(runs).where(eq(runs.conversationId, conversationId)).orderBy(asc(runs.turnIndex));
      return rows.map(toRow);
    },
    async deleteByConversation(conversationId) {
      await db.delete(runs).where(eq(runs.conversationId, conversationId));
    },
    async lastActivityByAgent(agentId) {
      const rows = await db
        .select({ conversationId: runs.conversationId, last: sql<Date>`max(${runs.createdAt})` })
        .from(runs)
        .where(and(eq(runs.agentId, agentId), isNotNull(runs.conversationId)))
        .groupBy(runs.conversationId);
      const out: Record<string, string> = {};
      for (const r of rows) if (r.conversationId && r.last) out[r.conversationId] = new Date(r.last).toISOString();
      return out;
    },
    async listSummary(agentId, limit = DEFAULT_LIST_LIMIT) {
      const q = db.select(summaryCols).from(runs).orderBy(desc(runs.createdAt), desc(runs.id)).limit(limit);
      const rows = agentId ? await q.where(eq(runs.agentId, agentId)) : await q;
      return rows.map(toSummary);
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
    async aggregateToolStats(agentId) {
      // Read the agent's recent run transcripts + times, reduce the `tool` messages in JS (they're
      // sparse; a windowed scan is fine — no cost, no write, observed only). Story 6.5.
      const rows = await db
        .select({ transcript: runs.transcript, createdAt: runs.createdAt })
        .from(runs)
        .where(eq(runs.agentId, agentId))
        .orderBy(desc(runs.createdAt), desc(runs.id))
        .limit(TOOL_STATS_RUN_WINDOW);
      return reduceToolStats(rows.map((r) => ({ transcript: (r.transcript as ControlChannelMessage[]) ?? [], createdAt: r.createdAt.toISOString() })));
    },
  };
}

export function memoryRunsRepo(): RunsRepo {
  const rows = new Map<string, RunRow>();
  const order: string[] = [];
  return {
    async create(row) {
      rows.set(row.id, { costMicros: 0, conversationId: null, turnIndex: null, ...row, transcript: [...row.transcript] });
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
    async listByConversation(conversationId) {
      return [...rows.values()]
        .filter((r) => r.conversationId === conversationId)
        .sort((a, b) => (a.turnIndex ?? 0) - (b.turnIndex ?? 0)) // turnIndex ASC
        .map((r) => ({ ...r, transcript: [...r.transcript] }));
    },
    async deleteByConversation(conversationId) {
      for (const [id, r] of [...rows.entries()]) {
        if (r.conversationId === conversationId) {
          rows.delete(id);
          const i = order.indexOf(id);
          if (i >= 0) order.splice(i, 1);
        }
      }
    },
    async lastActivityByAgent(agentId) {
      const out: Record<string, string> = {};
      for (const r of rows.values()) {
        if (r.agentId !== agentId || !r.conversationId) continue;
        if (!out[r.conversationId] || r.createdAt > out[r.conversationId]) out[r.conversationId] = r.createdAt;
      }
      return out;
    },
    async listSummary(agentId, limit = DEFAULT_LIST_LIMIT) {
      return order
        .map((id) => rows.get(id)!)
        .filter((r) => (agentId ? r.agentId === agentId : true))
        .slice(0, limit)
        .map((r): RunSummary => ({
          id: r.id,
          agentId: r.agentId,
          conversationId: r.conversationId,
          turnIndex: r.turnIndex,
          status: r.status,
          taskInput: r.taskInput,
          reason: r.reason,
          costMicros: r.costMicros,
          createdAt: r.createdAt,
          endedAt: r.endedAt,
        })); // drop the transcript — summary projection
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
    async aggregateToolStats(agentId) {
      const agentRuns = order
        .map((id) => rows.get(id)!)
        .filter((r) => r.agentId === agentId)
        .slice(0, TOOL_STATS_RUN_WINDOW);
      return reduceToolStats(agentRuns.map((r) => ({ transcript: r.transcript, createdAt: r.createdAt })));
    },
  };
}
