import { desc, eq } from "drizzle-orm";
import type { AgentVariable, AttachedSkill, LifecycleState } from "@turanga/domain";
import type { Db } from "../db/client.js";
import { agents } from "../db/schema.js";

export type { AgentVariable, AttachedSkill };

export interface AgentRow {
  id: string;
  name: string;
  state: LifecycleState;
  model: string | null; // "provider/model-id" (Story 3.2); null until selected
  instructions: string; // Story 3.3
  variables: AgentVariable[]; // Story 3.3
  skills: AttachedSkill[]; // Story 3.4
  createdAt: string; // UTC ISO-8601
}

// Writable agent-definition fields. name+model (3.2) + instructions+variables (3.3) +
// skills (3.4); caps land in Story 3.5 and extend this shape (control-api is the sole writer, AD-7).
export interface AgentPatch {
  name?: string;
  model?: string | null;
  instructions?: string;
  variables?: AgentVariable[];
  skills?: AttachedSkill[];
}

export interface AgentsRepo {
  list(): Promise<AgentRow[]>; // newest first
  get(id: string): Promise<AgentRow | null>;
  create(row: AgentRow): Promise<void>;
  update(id: string, patch: AgentPatch): Promise<AgentRow | null>; // null if the id doesn't exist
}

function toRow(r: typeof agents.$inferSelect): AgentRow {
  return {
    id: r.id,
    name: r.name,
    state: r.state as LifecycleState,
    model: r.model,
    instructions: r.instructions,
    variables: r.variables,
    skills: r.skills as AttachedSkill[],
    createdAt: r.createdAt.toISOString(),
  };
}

// Only defined keys are applied — an omitted field is left untouched.
function applyPatch(row: AgentRow, patch: AgentPatch): AgentRow {
  return {
    ...row,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.model !== undefined ? { model: patch.model } : {}),
    ...(patch.instructions !== undefined ? { instructions: patch.instructions } : {}),
    ...(patch.variables !== undefined ? { variables: patch.variables } : {}),
    ...(patch.skills !== undefined ? { skills: patch.skills } : {}),
  };
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
      // Persist the caller's createdAt so the 201 response and later GETs agree
      // (rather than letting the DB default now() drift from the returned value).
      await db.insert(agents).values({
        id: row.id,
        name: row.name,
        state: row.state,
        model: row.model,
        instructions: row.instructions,
        variables: row.variables,
        skills: row.skills,
        createdAt: new Date(row.createdAt),
      });
    },
    async update(id, patch) {
      const set: Partial<typeof agents.$inferInsert> = {};
      if (patch.name !== undefined) set.name = patch.name;
      if (patch.model !== undefined) set.model = patch.model;
      if (patch.instructions !== undefined) set.instructions = patch.instructions;
      if (patch.variables !== undefined) set.variables = patch.variables;
      if (patch.skills !== undefined) set.skills = patch.skills;
      if (Object.keys(set).length === 0) return this.get(id); // nothing to change
      const rows = await db.update(agents).set(set).where(eq(agents.id, id)).returning();
      return rows[0] ? toRow(rows[0]) : null;
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
    async update(id, patch) {
      const entry = rows.find((r) => r.row.id === id);
      if (!entry) return null;
      entry.row = applyPatch(entry.row, patch);
      return entry.row;
    },
  };
}
