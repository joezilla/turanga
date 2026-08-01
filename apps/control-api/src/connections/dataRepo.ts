import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { dataConnections } from "../db/schema.js";

export type DataStatus = "connected" | "error" | "unconfigured";

export interface DataConnRow {
  id: string;
  provider: string; // 'gmail'
  name: string;
  accountEmail: string | null;
  scopes: string[];
  destinations: string[];
  status: DataStatus;
  lastError: string | null;
  encRefreshToken: string | null; // encrypted; NEVER exposed
}

export interface DataConnectionsRepo {
  list(): Promise<DataConnRow[]>;
  get(id: string): Promise<DataConnRow | null>;
  upsertGmail(row: DataConnRow): Promise<void>; // one Gmail connection at a time
  delete(id: string): Promise<void>;
}

function toRow(r: typeof dataConnections.$inferSelect): DataConnRow {
  return {
    id: r.id,
    provider: r.provider,
    name: r.name,
    accountEmail: r.accountEmail,
    scopes: r.scopes ?? [],
    destinations: r.destinations ?? [],
    status: r.status as DataStatus,
    lastError: r.lastError,
    encRefreshToken: r.encRefreshToken,
  };
}

export function drizzleDataConnectionsRepo(db: Db): DataConnectionsRepo {
  return {
    async list() {
      return (await db.select().from(dataConnections)).map(toRow);
    },
    async get(id) {
      const rows = await db.select().from(dataConnections).where(eq(dataConnections.id, id)).limit(1);
      return rows[0] ? toRow(rows[0]) : null;
    },
    async upsertGmail(row) {
      await db.delete(dataConnections).where(eq(dataConnections.provider, "gmail"));
      await db.insert(dataConnections).values({
        id: row.id,
        provider: row.provider,
        name: row.name,
        accountEmail: row.accountEmail,
        scopes: row.scopes,
        destinations: row.destinations,
        status: row.status,
        lastError: row.lastError,
        encRefreshToken: row.encRefreshToken,
      });
    },
    async delete(id) {
      await db.delete(dataConnections).where(eq(dataConnections.id, id));
    },
  };
}

export function memoryDataConnectionsRepo(): DataConnectionsRepo {
  const rows = new Map<string, DataConnRow>();
  return {
    async list() {
      return [...rows.values()];
    },
    async get(id) {
      return rows.get(id) ?? null;
    },
    async upsertGmail(row) {
      for (const [k, v] of rows) if (v.provider === "gmail") rows.delete(k);
      rows.set(row.id, { ...row });
    },
    async delete(id) {
      rows.delete(id);
    },
  };
}
