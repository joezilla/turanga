import { eq } from "drizzle-orm";
import type { ToolEndpointType, ToolStatus, ToolOperation } from "@turanga/domain";
import type { Db } from "../db/client.js";
import { tools } from "../db/schema.js";

// A Tool row (Epic 6, Story 6.1). control-api is the sole writer (AD-7). No credential/endpoint URL
// lives here — a Tool's credential is held Guard-side (AD-10); remote endpoint config lands in 6.2.
export interface ToolRow {
  id: string;
  name: string;
  endpoint: ToolEndpointType;
  status: ToolStatus;
  lastError: string | null;
  url: string | null; // the remote MCP endpoint (Story 6.2)
  encCredential: string | null; // the bearer token ENCRYPTED at rest (Story 6.2) — internal only, NEVER in view()
  operations: ToolOperation[];
  createdAt: string; // UTC ISO-8601
}

export interface ToolsRepo {
  listTools(): Promise<ToolRow[]>;
  getTool(id: string): Promise<ToolRow | null>;
  createTool(row: ToolRow): Promise<void>;
  setStatus(id: string, status: ToolStatus, lastError: string | null): Promise<void>;
  setOperations(id: string, operations: ToolOperation[]): Promise<void>; // Story 6.2 (discovery) populates
  deleteTool(id: string): Promise<void>;
}

function toRow(r: typeof tools.$inferSelect): ToolRow {
  return {
    id: r.id,
    name: r.name,
    endpoint: r.endpoint as ToolEndpointType,
    status: r.status as ToolStatus,
    lastError: r.lastError,
    url: r.url,
    encCredential: r.encCredential,
    operations: (r.operations ?? []) as ToolOperation[],
    createdAt: r.createdAt.toISOString(),
  };
}

export function drizzleToolsRepo(db: Db): ToolsRepo {
  return {
    async listTools() {
      const rows = await db.select().from(tools);
      return rows.map(toRow);
    },
    async getTool(id) {
      const rows = await db.select().from(tools).where(eq(tools.id, id)).limit(1);
      return rows[0] ? toRow(rows[0]) : null;
    },
    async createTool(row) {
      await db.insert(tools).values({
        id: row.id,
        name: row.name,
        endpoint: row.endpoint,
        status: row.status,
        lastError: row.lastError,
        url: row.url,
        encCredential: row.encCredential,
        operations: row.operations,
        createdAt: new Date(row.createdAt),
      });
    },
    async setStatus(id, status, lastError) {
      await db.update(tools).set({ status, lastError }).where(eq(tools.id, id));
    },
    async setOperations(id, operations) {
      await db.update(tools).set({ operations }).where(eq(tools.id, id));
    },
    async deleteTool(id) {
      await db.delete(tools).where(eq(tools.id, id));
    },
  };
}

export function memoryToolsRepo(): ToolsRepo {
  const rows = new Map<string, ToolRow>();
  return {
    async listTools() {
      return [...rows.values()];
    },
    async getTool(id) {
      return rows.get(id) ?? null;
    },
    async createTool(row) {
      rows.set(row.id, { ...row, operations: [...row.operations] });
    },
    async setStatus(id, status, lastError) {
      const r = rows.get(id);
      if (r) rows.set(id, { ...r, status, lastError });
    },
    async setOperations(id, operations) {
      const r = rows.get(id);
      if (r) rows.set(id, { ...r, operations: [...operations] });
    },
    async deleteTool(id) {
      rows.delete(id);
    },
  };
}
