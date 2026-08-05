import { and, desc, eq, or } from "drizzle-orm";
import {
  ulid,
  PUBLISHED_FIELDS,
  DEFAULT_MEMORY_CONFIG,
  type AgentVariable,
  type AttachedSkill,
  type AttachedTool,
  type CostCap,
  type LifecycleState,
  type MemoryConfig,
  type Money,
  type PublishedField,
} from "@turanga/domain";
import type { Db } from "../db/client.js";
import { agents, agentVersions } from "../db/schema.js";

export type { AgentVariable, AttachedSkill, AttachedTool, CostCap, MemoryConfig, Money };

export interface AgentRow {
  id: string;
  name: string;
  description: string; // one-line summary (identity block)
  state: LifecycleState;
  model: string | null; // "provider/model-id" (Story 3.2); null until selected
  instructions: string; // Story 3.3
  variables: AgentVariable[]; // Story 3.3
  skills: AttachedSkill[]; // Story 3.4
  attachedTools: AttachedTool[]; // Story 6.3 — per-operation tool grants (default-deny)
  costCap: CostCap; // Story 3.5 — sides default null until set
  memoryConfig: MemoryConfig; // Story 8.1 — operational; NOT in PUBLISHED_FIELDS (not part of the published definition)
  publishedVersion: number | null; // newest published version; null = never published
  publishedAt: string | null; // UTC ISO-8601 of that publish
  createdAt: string; // UTC ISO-8601
}

/** The publishable slice of a definition — what a version snapshots. */
export type AgentSnapshot = Pick<AgentRow, PublishedField>;

/** An agent as the API hands it out: the working draft plus how it differs from what's published. */
export interface AgentView extends AgentRow {
  dirty: boolean; // there is something to publish (always true before the first publish)
  changedFields: PublishedField[]; // which publishable fields differ from the published snapshot
}

export interface AgentVersionRow {
  version: number;
  publishedAt: string;
  publishedBy: string | null;
  snapshot: AgentSnapshot;
}

// Writable agent-definition fields. name+model (3.2) + instructions+variables (3.3) +
// skills (3.4) + costCap (3.5) — control-api is the sole writer (AD-7).
export interface AgentPatch {
  name?: string;
  description?: string;
  model?: string | null;
  instructions?: string;
  variables?: AgentVariable[];
  skills?: AttachedSkill[];
  attachedTools?: AttachedTool[]; // Story 6.3
  costCap?: CostCap;
  state?: LifecycleState; // Story 5.1 — written ONLY by the gated activate/deactivate routes, never the general PATCH
}

export type PublishResult =
  | { ok: true; agent: AgentView; version: AgentVersionRow }
  | { ok: false; reason: "not-found" | "no-changes" };

export interface AgentsRepo {
  list(): Promise<AgentView[]>; // newest first
  get(id: string): Promise<AgentView | null>;
  create(row: AgentRow): Promise<void>;
  update(id: string, patch: AgentPatch): Promise<AgentView | null>; // null if the id doesn't exist
  /** Snapshot the current draft as the next version. Rejects when nothing has changed. */
  publish(id: string, publishedBy: string | null): Promise<PublishResult>;
  /** Newest first. */
  listVersions(id: string): Promise<AgentVersionRow[]>;
  /** Copy a draft into a brand-new, never-published agent. Null if the source doesn't exist. */
  duplicate(id: string, newId: string, name: string, createdAt: string): Promise<AgentView | null>;
}

export function snapshotOf(row: AgentRow): AgentSnapshot {
  return {
    name: row.name,
    description: row.description,
    model: row.model,
    instructions: row.instructions,
    variables: row.variables,
    skills: row.skills,
    attachedTools: row.attachedTools,
    costCap: row.costCap,
  };
}

// Field-by-field structural comparison. Array order counts as a difference on purpose:
// reordering granted operations or variables is a real edit the user should be able to publish.
function diffFields(row: AgentRow, published: AgentSnapshot | null): PublishedField[] {
  if (!published) return [...PUBLISHED_FIELDS]; // never published — all of it is unpublished
  const current = snapshotOf(row);
  return PUBLISHED_FIELDS.filter((f) => JSON.stringify(current[f]) !== JSON.stringify(published[f]));
}

export function toView(row: AgentRow, published: AgentSnapshot | null): AgentView {
  const changedFields = diffFields(row, published);
  return { ...row, dirty: changedFields.length > 0, changedFields };
}

function toRow(r: typeof agents.$inferSelect): AgentRow {
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? "",
    state: r.state as LifecycleState,
    model: r.model,
    instructions: r.instructions,
    variables: r.variables,
    skills: r.skills as AttachedSkill[],
    attachedTools: (r.attachedTools ?? []) as AttachedTool[],
    costCap: r.costCap as CostCap,
    memoryConfig: (r.memoryConfig ?? DEFAULT_MEMORY_CONFIG) as MemoryConfig,
    publishedVersion: r.publishedVersion ?? null,
    publishedAt: r.publishedAt ? r.publishedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  };
}

// Only defined keys are applied — an omitted field is left untouched.
function applyPatch(row: AgentRow, patch: AgentPatch): AgentRow {
  return {
    ...row,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.model !== undefined ? { model: patch.model } : {}),
    ...(patch.instructions !== undefined ? { instructions: patch.instructions } : {}),
    ...(patch.variables !== undefined ? { variables: patch.variables } : {}),
    ...(patch.skills !== undefined ? { skills: patch.skills } : {}),
    ...(patch.attachedTools !== undefined ? { attachedTools: patch.attachedTools } : {}),
    ...(patch.costCap !== undefined ? { costCap: patch.costCap } : {}),
    ...(patch.state !== undefined ? { state: patch.state } : {}),
  };
}

export function drizzleAgentsRepo(db: Db): AgentsRepo {
  // The snapshot each agent's `publishedVersion` points at, for a batch of agents. Fetch ONLY each
  // agent's current published version (the exact (agentId, version) pair) — not its whole history —
  // so a `GET /agents` render doesn't materialize every past snapshot just to derive `dirty`.
  async function publishedSnapshots(rows: AgentRow[]): Promise<Map<string, AgentSnapshot>> {
    const withVersion = rows.filter((r) => r.publishedVersion !== null);
    if (withVersion.length === 0) return new Map();
    const found = await db
      .select({ agentId: agentVersions.agentId, snapshot: agentVersions.snapshot })
      .from(agentVersions)
      .where(or(...withVersion.map((r) => and(eq(agentVersions.agentId, r.id), eq(agentVersions.version, r.publishedVersion!)))));
    const out = new Map<string, AgentSnapshot>();
    for (const v of found) out.set(v.agentId, v.snapshot as AgentSnapshot);
    return out;
  }

  const repo: AgentsRepo = {
    async list() {
      // Newest first; id (a ULID) as a deterministic tiebreak for same-ms creates.
      const rows = (await db.select().from(agents).orderBy(desc(agents.createdAt), desc(agents.id))).map(toRow);
      const snaps = await publishedSnapshots(rows);
      return rows.map((r) => toView(r, snaps.get(r.id) ?? null));
    },
    async get(id) {
      const rows = await db.select().from(agents).where(eq(agents.id, id)).limit(1);
      if (!rows[0]) return null;
      const row = toRow(rows[0]);
      const snaps = await publishedSnapshots([row]);
      return toView(row, snaps.get(row.id) ?? null);
    },
    async create(row) {
      // Persist the caller's createdAt so the 201 response and later GETs agree
      // (rather than letting the DB default now() drift from the returned value).
      await db.insert(agents).values({
        id: row.id,
        name: row.name,
        description: row.description,
        state: row.state,
        model: row.model,
        instructions: row.instructions,
        variables: row.variables,
        skills: row.skills,
        attachedTools: row.attachedTools,
        costCap: row.costCap,
        memoryConfig: row.memoryConfig,
        publishedVersion: row.publishedVersion,
        publishedAt: row.publishedAt ? new Date(row.publishedAt) : null,
        createdAt: new Date(row.createdAt),
      });
    },
    async update(id, patch) {
      const set: Partial<typeof agents.$inferInsert> = {};
      if (patch.name !== undefined) set.name = patch.name;
      if (patch.description !== undefined) set.description = patch.description;
      if (patch.model !== undefined) set.model = patch.model;
      if (patch.instructions !== undefined) set.instructions = patch.instructions;
      if (patch.variables !== undefined) set.variables = patch.variables;
      if (patch.skills !== undefined) set.skills = patch.skills;
      if (patch.attachedTools !== undefined) set.attachedTools = patch.attachedTools;
      if (patch.costCap !== undefined) set.costCap = patch.costCap;
      if (patch.state !== undefined) set.state = patch.state;
      if (Object.keys(set).length === 0) return repo.get(id); // nothing to change
      const rows = await db.update(agents).set(set).where(eq(agents.id, id)).returning();
      if (!rows[0]) return null;
      const row = toRow(rows[0]);
      const snaps = await publishedSnapshots([row]);
      return toView(row, snaps.get(row.id) ?? null);
    },
    async publish(id, publishedBy) {
      const view = await repo.get(id);
      if (!view) return { ok: false, reason: "not-found" };
      if (!view.dirty) return { ok: false, reason: "no-changes" };
      const version = (view.publishedVersion ?? 0) + 1;
      const publishedAt = new Date();
      const snapshot = snapshotOf(view);
      // Atomic: the version row and the pointer bump commit together or not at all. A crash between
      // them would otherwise commit v=N+1 while `publishedVersion` stayed N, and every future publish
      // would recompute N+1 and hit the unique index forever (permanently un-republishable).
      await db.transaction(async (tx) => {
        await tx.insert(agentVersions).values({ id: ulid(publishedAt.getTime()), agentId: id, version, snapshot, publishedBy, publishedAt });
        await tx.update(agents).set({ publishedVersion: version, publishedAt }).where(eq(agents.id, id));
      });
      const after = await repo.get(id);
      if (!after) return { ok: false, reason: "not-found" }; // deleted mid-publish
      return { ok: true, agent: after, version: { version, publishedAt: publishedAt.toISOString(), publishedBy, snapshot } };
    },
    async listVersions(id) {
      const rows = await db.select().from(agentVersions).where(eq(agentVersions.agentId, id)).orderBy(desc(agentVersions.version));
      return rows.map((v) => ({
        version: v.version,
        publishedAt: v.publishedAt.toISOString(),
        publishedBy: v.publishedBy,
        snapshot: v.snapshot as AgentSnapshot,
      }));
    },
    async duplicate(id, newId, name, createdAt) {
      const source = await repo.get(id);
      if (!source) return null;
      const copy: AgentRow = {
        ...source,
        id: newId,
        name,
        state: "draft", // a copy always starts as a draft, whatever the original was doing
        publishedVersion: null,
        publishedAt: null,
        createdAt,
      };
      await repo.create(copy);
      return toView(copy, null);
    },
  };
  return repo;
}

export function memoryAgentsRepo(): AgentsRepo {
  const rows: { row: AgentRow; seq: number }[] = [];
  const versions: { agentId: string; version: number; publishedAt: string; publishedBy: string | null; snapshot: AgentSnapshot }[] = [];
  let seq = 0;

  function publishedSnapshot(row: AgentRow): AgentSnapshot | null {
    if (row.publishedVersion === null) return null;
    return versions.find((v) => v.agentId === row.id && v.version === row.publishedVersion)?.snapshot ?? null;
  }

  const repo: AgentsRepo = {
    async list() {
      // Newest first; insertion sequence breaks same-ms createdAt ties deterministically.
      return [...rows]
        .sort((a, b) => b.row.createdAt.localeCompare(a.row.createdAt) || b.seq - a.seq)
        .map((r) => toView(r.row, publishedSnapshot(r.row)));
    },
    async get(id) {
      const row = rows.find((r) => r.row.id === id)?.row;
      return row ? toView(row, publishedSnapshot(row)) : null;
    },
    async create(row) {
      rows.push({ row: { ...row }, seq: seq++ });
    },
    async update(id, patch) {
      const entry = rows.find((r) => r.row.id === id);
      if (!entry) return null;
      entry.row = applyPatch(entry.row, patch);
      return toView(entry.row, publishedSnapshot(entry.row));
    },
    async publish(id, publishedBy) {
      const entry = rows.find((r) => r.row.id === id);
      if (!entry) return { ok: false, reason: "not-found" };
      const before = toView(entry.row, publishedSnapshot(entry.row));
      if (!before.dirty) return { ok: false, reason: "no-changes" };
      const version = (entry.row.publishedVersion ?? 0) + 1;
      const publishedAt = new Date().toISOString();
      const snapshot = snapshotOf(entry.row);
      versions.push({ agentId: id, version, publishedAt, publishedBy, snapshot });
      entry.row = { ...entry.row, publishedVersion: version, publishedAt };
      return {
        ok: true,
        agent: toView(entry.row, snapshot),
        version: { version, publishedAt, publishedBy, snapshot },
      };
    },
    async listVersions(id) {
      return versions
        .filter((v) => v.agentId === id)
        .sort((a, b) => b.version - a.version)
        .map((v) => ({ version: v.version, publishedAt: v.publishedAt, publishedBy: v.publishedBy, snapshot: v.snapshot }));
    },
    async duplicate(id, newId, name, createdAt) {
      const source = rows.find((r) => r.row.id === id)?.row;
      if (!source) return null;
      const copy: AgentRow = { ...source, id: newId, name, state: "draft", publishedVersion: null, publishedAt: null, createdAt };
      rows.push({ row: copy, seq: seq++ });
      return toView(copy, null);
    },
  };
  return repo;
}
