import { and, eq } from "drizzle-orm";
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
