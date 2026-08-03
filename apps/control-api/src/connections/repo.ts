import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { connections } from "../db/schema.js";

export type ProviderStatus = "connected" | "error" | "unconfigured";

export interface ProviderRow {
  id: string;
  provider: string;
  name: string;
  baseUrl: string | null;
  keyLast4: string | null;
  status: ProviderStatus;
  lastError: string | null;
  models: string[]; // the provider's available catalog (Story 2.4)
  enabledModels: string[]; // the curated subset selectable in the agent picker (Story 2.4)
  litellmModelIds: string[];
}

export interface ConnectionsRepo {
  listProviders(): Promise<ProviderRow[]>;
  getProvider(id: string): Promise<ProviderRow | null>;
  createProvider(row: ProviderRow): Promise<void>;
  setStatus(id: string, status: ProviderStatus, lastError: string | null, keyLast4?: string | null): Promise<void>;
  setModelIds(id: string, ids: string[]): Promise<void>;
  setModels(id: string, models: string[], enabledModels: string[]): Promise<void>; // Story 2.4 — refresh the catalog + reconciled enabled set
  setEnabled(id: string, enabledModels: string[]): Promise<void>; // Story 2.4 — toggle which models are selectable
  deleteProvider(id: string): Promise<void>;
}

const KIND = "model-provider";

function toRow(r: typeof connections.$inferSelect): ProviderRow {
  return {
    id: r.id,
    provider: r.provider,
    name: r.name,
    baseUrl: r.baseUrl,
    keyLast4: r.keyLast4,
    status: r.status as ProviderStatus,
    lastError: r.lastError,
    models: r.models ?? [],
    enabledModels: r.enabledModels ?? [],
    litellmModelIds: r.litellmModelIds ?? [],
  };
}

export function drizzleConnectionsRepo(db: Db): ConnectionsRepo {
  return {
    async listProviders() {
      const rows = await db.select().from(connections).where(eq(connections.kind, KIND));
      return rows.map(toRow);
    },
    async getProvider(id) {
      const rows = await db.select().from(connections).where(eq(connections.id, id)).limit(1);
      return rows[0] ? toRow(rows[0]) : null;
    },
    async createProvider(row) {
      await db.insert(connections).values({
        id: row.id,
        kind: KIND,
        provider: row.provider,
        name: row.name,
        baseUrl: row.baseUrl,
        keyLast4: row.keyLast4,
        status: row.status,
        lastError: row.lastError,
        models: row.models,
        enabledModels: row.enabledModels,
        litellmModelIds: row.litellmModelIds,
      });
    },
    async setStatus(id, status, lastError, keyLast4) {
      await db
        .update(connections)
        .set({ status, lastError, ...(keyLast4 !== undefined ? { keyLast4 } : {}) })
        .where(eq(connections.id, id));
    },
    async setModelIds(id, ids) {
      await db.update(connections).set({ litellmModelIds: ids }).where(eq(connections.id, id));
    },
    async setModels(id, models, enabledModels) {
      await db.update(connections).set({ models, enabledModels }).where(eq(connections.id, id));
    },
    async setEnabled(id, enabledModels) {
      await db.update(connections).set({ enabledModels }).where(eq(connections.id, id));
    },
    async deleteProvider(id) {
      await db.delete(connections).where(eq(connections.id, id));
    },
  };
}

export function memoryConnectionsRepo(): ConnectionsRepo {
  const rows = new Map<string, ProviderRow>();
  return {
    async listProviders() {
      return [...rows.values()];
    },
    async getProvider(id) {
      return rows.get(id) ?? null;
    },
    async createProvider(row) {
      rows.set(row.id, { ...row });
    },
    async setStatus(id, status, lastError, keyLast4) {
      const r = rows.get(id);
      if (r) rows.set(id, { ...r, status, lastError, ...(keyLast4 !== undefined ? { keyLast4 } : {}) });
    },
    async setModelIds(id, ids) {
      const r = rows.get(id);
      if (r) rows.set(id, { ...r, litellmModelIds: ids });
    },
    async setModels(id, models, enabledModels) {
      const r = rows.get(id);
      if (r) rows.set(id, { ...r, models, enabledModels });
    },
    async setEnabled(id, enabledModels) {
      const r = rows.get(id);
      if (r) rows.set(id, { ...r, enabledModels });
    },
    async deleteProvider(id) {
      rows.delete(id);
    },
  };
}
