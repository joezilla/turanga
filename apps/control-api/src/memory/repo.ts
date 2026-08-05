import { and, asc, cosineDistance, desc, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import {
  DEFAULT_MEMORY_CONFIG,
  DEFAULT_MEMORY_GLOBAL_CONFIG,
  type MemoryConfig,
  type MemoryKind,
  type MemoryGlobalConfig,
} from "@turanga/domain";
import type { Db } from "../db/client.js";
import { agentMemories, agents, memorySettings } from "../db/schema.js";

// The single settings row is keyed by this constant (one operator-wide config, Story 8.1).
const GLOBAL_ID = "global";

// An agent_memories row (Epic 8, Story 8.1). control-api is the sole writer (AD-7); every read is
// AGENT-SCOPED (FR-7 — no cross-agent/cross-run shared state). `embedding` is populated by recall
// (8.3); it's null here until then. Never holds a secret (AD-10) — memory is distilled run outcomes.
export interface MemoryRow {
  id: string;
  agentId: string;
  kind: MemoryKind;
  content: string;
  summary: string;
  embedding: number[] | null;
  topic: string | null;
  salience: number;
  sourceRunId: string | null;
  validFrom: string; // UTC ISO-8601
  validUntil: string | null; // null = still valid
  useCount: number;
  lastUsedAt: string | null; // UTC ISO-8601
  createdAt: string; // UTC ISO-8601
}

export interface MemoryRepo {
  // Agent memories — every accessor is scoped to a single agentId (FR-7); there is deliberately NO
  // "list all memories" method, so no code path can read across the agent boundary.
  listForAgent(agentId: string): Promise<MemoryRow[]>;
  getMemory(agentId: string, id: string): Promise<MemoryRow | null>; // agentId re-checked — a memory only resolves for its owner
  createMemory(row: MemoryRow): Promise<void>;
  deleteMemory(agentId: string, id: string): Promise<void>;
  // Recall (Story 8.3) — agent-scoped nearest-neighbor over the embedding column (cosine), excluding
  // null-embedding + expired rows, optionally filtered to `opts.kinds`, ordered nearest-first, `k` max.
  recall(agentId: string, queryEmbedding: number[], k: number, opts?: { kinds?: MemoryKind[] }): Promise<MemoryRow[]>;
  // Bump usage counters on the just-recalled rows (auditable causality; agent-scoped). No-op on [].
  markRecalled(agentId: string, ids: string[]): Promise<void>;
  // Operator-wide defaults (one singleton row). Reads return the OFF default when unset (no write on read).
  getGlobalConfig(): Promise<MemoryGlobalConfig>;
  setGlobalConfig(patch: Partial<MemoryGlobalConfig>): Promise<MemoryGlobalConfig>;
  // Per-agent config lives on the agents.memory_config column; the memory module is its mutation surface
  // (still control-api, AD-7). Reads return the `inherit` default for an unknown agent.
  getAgentMemoryConfig(agentId: string): Promise<MemoryConfig>;
  setAgentMemoryConfig(agentId: string, config: MemoryConfig): Promise<void>;
}

function toRow(r: typeof agentMemories.$inferSelect): MemoryRow {
  return {
    id: r.id,
    agentId: r.agentId,
    kind: r.kind as MemoryKind,
    content: r.content,
    summary: r.summary,
    embedding: r.embedding ?? null,
    topic: r.topic,
    salience: r.salience,
    sourceRunId: r.sourceRunId,
    validFrom: r.validFrom.toISOString(),
    validUntil: r.validUntil ? r.validUntil.toISOString() : null,
    useCount: r.useCount,
    lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  };
}

function toGlobal(r: typeof memorySettings.$inferSelect): MemoryGlobalConfig {
  return {
    defaultEnabled: r.defaultEnabled,
    killSwitch: r.killSwitch,
    embeddingModel: r.embeddingModel,
    retentionDays: r.retentionDays ?? null,
    privacy: "agent-scoped",
  };
}

export function drizzleMemoryRepo(db: Db): MemoryRepo {
  return {
    async listForAgent(agentId) {
      const rows = await db.select().from(agentMemories).where(eq(agentMemories.agentId, agentId));
      return rows.map(toRow);
    },
    async getMemory(agentId, id) {
      const rows = await db.select().from(agentMemories).where(eq(agentMemories.id, id)).limit(1);
      const r = rows[0];
      // Scope-guard: a memory resolves ONLY for the agent that owns it (FR-7).
      return r && r.agentId === agentId ? toRow(r) : null;
    },
    async createMemory(row) {
      await db.insert(agentMemories).values({
        id: row.id,
        agentId: row.agentId,
        kind: row.kind,
        content: row.content,
        summary: row.summary,
        embedding: row.embedding,
        topic: row.topic,
        salience: row.salience,
        sourceRunId: row.sourceRunId,
        validFrom: new Date(row.validFrom),
        validUntil: row.validUntil ? new Date(row.validUntil) : null,
        useCount: row.useCount,
        lastUsedAt: row.lastUsedAt ? new Date(row.lastUsedAt) : null,
        createdAt: new Date(row.createdAt),
      });
    },
    async deleteMemory(agentId, id) {
      // Both predicates so a caller can't delete another agent's memory by guessing an id (FR-7).
      await db.delete(agentMemories).where(and(eq(agentMemories.id, id), eq(agentMemories.agentId, agentId)));
    },
    async recall(agentId, queryEmbedding, k, opts) {
      // Distinguish "no kinds filter" (undefined) from "an explicit empty set" — the latter means the
      // agent enabled zero kinds, so recall NOTHING (an empty array must not be read as "no filter").
      if (opts?.kinds && opts.kinds.length === 0) return [];
      const filters = [
        eq(agentMemories.agentId, agentId), // FR-7 — never crosses the agent boundary
        isNotNull(agentMemories.embedding), // un-embedded rows can't be compared
        or(isNull(agentMemories.validUntil), gt(agentMemories.validUntil, new Date())), // temporal validity
      ];
      if (opts?.kinds) filters.push(inArray(agentMemories.kind, opts.kinds));
      const rows = await db
        .select()
        .from(agentMemories)
        .where(and(...filters))
        // nearest-first (matches the HNSW cosine index); salience desc then id break distance ties so
        // which top-k survive is DETERMINISTIC + matches the in-memory fake.
        .orderBy(cosineDistance(agentMemories.embedding, queryEmbedding), desc(agentMemories.salience), asc(agentMemories.id))
        .limit(k);
      return rows.map(toRow);
    },
    async markRecalled(agentId, ids) {
      if (ids.length === 0) return;
      await db
        .update(agentMemories)
        .set({ useCount: sql`${agentMemories.useCount} + 1`, lastUsedAt: new Date() })
        .where(and(eq(agentMemories.agentId, agentId), inArray(agentMemories.id, ids)));
    },
    async getGlobalConfig() {
      const rows = await db.select().from(memorySettings).where(eq(memorySettings.id, GLOBAL_ID)).limit(1);
      return rows[0] ? toGlobal(rows[0]) : { ...DEFAULT_MEMORY_GLOBAL_CONFIG };
    },
    async setGlobalConfig(patch) {
      const current = await this.getGlobalConfig();
      const next: MemoryGlobalConfig = { ...current, ...patch, privacy: "agent-scoped" };
      await db
        .insert(memorySettings)
        .values({
          id: GLOBAL_ID,
          defaultEnabled: next.defaultEnabled,
          killSwitch: next.killSwitch,
          embeddingModel: next.embeddingModel,
          retentionDays: next.retentionDays,
          privacy: next.privacy,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: memorySettings.id,
          set: {
            defaultEnabled: next.defaultEnabled,
            killSwitch: next.killSwitch,
            embeddingModel: next.embeddingModel,
            retentionDays: next.retentionDays,
            privacy: next.privacy,
            updatedAt: new Date(),
          },
        });
      return next;
    },
    async getAgentMemoryConfig(agentId) {
      const rows = await db.select({ memoryConfig: agents.memoryConfig }).from(agents).where(eq(agents.id, agentId)).limit(1);
      return (rows[0]?.memoryConfig ?? DEFAULT_MEMORY_CONFIG) as MemoryConfig;
    },
    async setAgentMemoryConfig(agentId, config) {
      await db.update(agents).set({ memoryConfig: config }).where(eq(agents.id, agentId));
    },
  };
}

// Cosine distance (1 - cosine similarity) for the in-memory fake — smaller = more similar, matching
// the drizzle `cosineDistance` order. A zero-magnitude vector sorts last.
function cosineDist(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 1;
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function memoryMemoryRepo(): MemoryRepo {
  const rows = new Map<string, MemoryRow>();
  const agentConfigs = new Map<string, MemoryConfig>();
  let global: MemoryGlobalConfig = { ...DEFAULT_MEMORY_GLOBAL_CONFIG };
  return {
    async listForAgent(agentId) {
      return [...rows.values()].filter((r) => r.agentId === agentId).map((r) => ({ ...r }));
    },
    async getMemory(agentId, id) {
      const r = rows.get(id);
      return r && r.agentId === agentId ? { ...r } : null;
    },
    async createMemory(row) {
      rows.set(row.id, { ...row, embedding: row.embedding ? [...row.embedding] : null });
    },
    async deleteMemory(agentId, id) {
      const r = rows.get(id);
      if (r && r.agentId === agentId) rows.delete(id);
    },
    async recall(agentId, queryEmbedding, k, opts) {
      const kinds = opts?.kinds;
      if (kinds && kinds.length === 0) return []; // explicit empty set → recall nothing (see drizzle impl)
      const now = Date.now();
      const candidates = [...rows.values()].filter(
        (r) =>
          r.agentId === agentId &&
          r.embedding != null &&
          (r.validUntil == null || Date.parse(r.validUntil) > now) &&
          (!kinds || kinds.includes(r.kind)),
      );
      // distance asc, then salience desc, then id asc — deterministic, matching the drizzle order.
      candidates.sort(
        (a, b) =>
          cosineDist(queryEmbedding, a.embedding!) - cosineDist(queryEmbedding, b.embedding!) ||
          b.salience - a.salience ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
      return candidates.slice(0, k).map((r) => ({ ...r }));
    },
    async markRecalled(agentId, ids) {
      for (const id of ids) {
        const r = rows.get(id);
        if (r && r.agentId === agentId) rows.set(id, { ...r, useCount: r.useCount + 1, lastUsedAt: new Date().toISOString() });
      }
    },
    async getGlobalConfig() {
      return { ...global };
    },
    async setGlobalConfig(patch) {
      global = { ...global, ...patch, privacy: "agent-scoped" };
      return { ...global };
    },
    async getAgentMemoryConfig(agentId) {
      const c = agentConfigs.get(agentId) ?? DEFAULT_MEMORY_CONFIG;
      return { ...c, kinds: [...c.kinds] };
    },
    async setAgentMemoryConfig(agentId, config) {
      agentConfigs.set(agentId, { ...config, kinds: [...config.kinds] });
    },
  };
}
