import { pgTable, text, timestamp, jsonb, integer, boolean, uniqueIndex, index, vector } from "drizzle-orm/pg-core";

// users + sessions — the first control-api tables (AD-7: control-api owns this state).
export const users = pgTable("users", {
  id: text("id").primaryKey(), // ULID (@turanga/domain)
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(), // sha256(raw token) — never store the raw token
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Connections — model providers (Story 2.1) and later data connections (Story 2.2).
// The real provider API key lives ENCRYPTED in LiteLLM (AD-10), never here; we keep
// only key_last4 for the masked display.
export const connections = pgTable("connections", {
  id: text("id").primaryKey(), // ULID
  kind: text("kind").notNull(), // 'model-provider' (| 'data' later)
  provider: text("provider").notNull(), // 'openai' | 'anthropic' | 'openai-compatible'
  name: text("name").notNull(),
  baseUrl: text("base_url"),
  keyLast4: text("key_last4"),
  status: text("status").notNull(), // 'connected' | 'error' | 'unconfigured'
  lastError: text("last_error"),
  models: jsonb("models").$type<string[]>().notNull().default([]), // the provider's available catalog (Story 2.4)
  enabledModels: jsonb("enabled_models").$type<string[]>().notNull().default([]), // the curated subset selectable in the agent picker (Story 2.4)
  litellmModelIds: jsonb("litellm_model_ids").$type<string[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Data connections (Story 2.2). The OAuth refresh token is stored ENCRYPTED at rest
// (enc_refresh_token, AES-256-GCM) — never returned to the browser; the egress-guard
// reads+decrypts it for credential injection in Epic 4 (AD-10 realization).
export const dataConnections = pgTable("data_connections", {
  id: text("id").primaryKey(), // ULID
  provider: text("provider").notNull(), // 'gmail'
  name: text("name").notNull(),
  accountEmail: text("account_email"),
  scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
  destinations: jsonb("destinations").$type<string[]>().notNull().default([]),
  status: text("status").notNull(), // 'connected' | 'error' | 'unconfigured'
  lastError: text("last_error"),
  encRefreshToken: text("enc_refresh_token"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Agents (Story 3.1). Minimal now — create + list + lifecycle state; model/instructions/
// skills/cost-caps land in Stories 3.2-3.5. control-api is the only writer (AD-7).
export const agents = pgTable("agents", {
  id: text("id").primaryKey(), // ULID
  name: text("name").notNull(),
  description: text("description").notNull().default(""), // one-line summary shown in the editor's identity block
  state: text("state").notNull(), // 'draft' | 'active' (LifecycleState)
  model: text("model"), // "provider/model-id" (Story 3.2); null until a model is selected
  instructions: text("instructions").notNull().default(""), // Story 3.3
  variables: jsonb("variables").$type<{ name: string; value: string }[]>().notNull().default([]), // Story 3.3
  skills: jsonb("skills").$type<{ skill: string; scope: string; send: boolean }[]>().notNull().default([]), // Story 3.4
  attachedTools: jsonb("attached_tools").$type<{ toolId: string; operations: string[] }[]>().notNull().default([]), // Story 6.3 — per-operation grants (default-deny)
  costCap: jsonb("cost_cap")
    .$type<{ perRun: { minor: number; currency: string } | null; perDay: { minor: number; currency: string } | null }>()
    .notNull()
    .default({ perRun: null, perDay: null }), // Story 3.5
  // Story 8.1 — per-agent memory toggle (OPERATIONAL config, NOT part of the published definition;
  // deliberately absent from PUBLISHED_FIELDS). Default `inherit` + a global default of OFF = memory off.
  memoryConfig: jsonb("memory_config")
    .$type<{ mode: "inherit" | "on" | "off"; recall: boolean; reflect: boolean; kinds: ("episodic" | "semantic" | "procedure")[] }>()
    .notNull()
    .default({ mode: "inherit", recall: true, reflect: true, kinds: ["episodic", "semantic", "procedure"] }),
  // The row above is always the WORKING DRAFT. These two point at the newest immutable snapshot
  // in agent_versions; null means the agent has never been published.
  publishedVersion: integer("published_version"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Immutable published snapshots of an agent's definition. Written only by POST /agents/:id/publish
// (AD-7). The draft lives on `agents`; publishing copies the publishable fields here and bumps
// agents.published_version. Nothing ever updates a row in this table.
export const agentVersions = pgTable(
  "agent_versions",
  {
    id: text("id").primaryKey(), // ULID
    agentId: text("agent_id").notNull(),
    version: integer("version").notNull(), // 1-based, per agent
    snapshot: jsonb("snapshot")
      .$type<{
        name: string;
        description: string;
        model: string | null;
        instructions: string;
        variables: { name: string; value: string }[];
        skills: { skill: string; scope: string; send: boolean }[];
        attachedTools: { toolId: string; operations: string[] }[];
        costCap: { perRun: { minor: number; currency: string } | null; perDay: { minor: number; currency: string } | null };
      }>()
      .notNull(),
    publishedBy: text("published_by"), // user email at publish time; null for system publishes
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("agent_versions_agent_version_idx").on(t.agentId, t.version)],
);

// Runs (Epic 4). Written ONLY by the run-orchestrator (AD-7). The transcript is the merged
// control-channel event stream; spend + refusal detail fill in as Stories 4.4/4.5 land.
export const runs = pgTable("runs", {
  id: text("id").primaryKey(), // ULID
  agentId: text("agent_id").notNull(),
  status: text("status").notNull(), // created | running | succeeded | failed | killed
  taskInput: text("task_input").notNull().default(""),
  transcript: jsonb("transcript").$type<unknown[]>().notNull().default([]), // ControlChannelMessage[]
  reason: text("reason"), // the stated fail/kill reason
  costMicros: integer("cost_micros").notNull().default(0), // summed run cost in micro-USD (Story 4.5)
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
});

// Tools (Epic 6, Story 6.1). A first-class MCP tool an agent can invoke. Dedicated table (like
// data_connections). control-api is the only writer (AD-7). The endpoint TYPE is an adapter (remote
// now, container in Epic 7); endpoint-specific config (remote url/credential, container image) is
// added by later stories. Any credential lives Guard-side, NEVER here (AD-10).
export const tools = pgTable("tools", {
  id: text("id").primaryKey(), // ULID
  name: text("name").notNull(),
  endpoint: text("endpoint").notNull(), // 'remote' | 'container' (ToolEndpointType)
  status: text("status").notNull(), // 'unverified' | 'connected' | 'error' (ToolStatus)
  lastError: text("last_error"),
  url: text("url"), // the remote MCP endpoint (Story 6.2); null for a container tool
  // The MCP bearer token, ENCRYPTED at rest (AES-256-GCM, Story 6.2) — mirrors enc_refresh_token;
  // NEVER returned by the route view(); decrypted only at run time to hand to the Guard (AD-10, 6.4).
  encCredential: text("enc_credential"),
  operations: jsonb("operations").$type<{ name: string; title?: string; description?: string; inputSchema?: unknown }[]>().notNull().default([]), // discovered MCP tools/list (Story 6.2 populates)
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Agent memory (Epic 8, Story 8.1). Control-plane store; agent-scoped; OFF by default; never holds a
// secret (AD-10). control-api is the sole writer (AD-7). `embedding` is populated by reflect (8.4); the
// vector column is fixed at 1536 dims (text-embedding-3-small) — see the story's embedding-dimension
// decision. Story 8.3 adds the HNSW cosine index for recall (nearest-neighbor via `<=>`).
export const agentMemories = pgTable(
  "agent_memories",
  {
    id: text("id").primaryKey(), // ULID
    agentId: text("agent_id").notNull(),
    kind: text("kind").notNull(), // 'episodic' | 'semantic' | 'procedure' (MemoryKind)
    content: text("content").notNull(), // verbatim
    summary: text("summary").notNull().default(""),
    embedding: vector("embedding", { dimensions: 1536 }), // nullable until 8.3 computes it
    topic: text("topic"),
    salience: integer("salience").notNull().default(0),
    pinned: boolean("pinned").notNull().default(false), // Story 8.5 — protect from the reflect prune / decay
    status: text("status").notNull().default("active"), // Story 8.6 — 'active' | 'pending' | 'quarantined'; only 'active' is recalled
    sourceRunId: text("source_run_id"),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull().defaultNow(),
    validUntil: timestamp("valid_until", { withTimezone: true }), // null = still valid
    useCount: integer("use_count").notNull().default(0),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("agent_memories_agent_idx").on(t.agentId), // recall filters by agent (FR-7)
    // Story 8.3 — HNSW cosine index for recall's nearest-neighbor (`embedding <=> query`). Must match
    // the cosine distance used by MemoryRepo.recall. drizzle-kit may not emit the opclass cleanly →
    // the generated migration is hand-verified/edited (mirrors the hand-added CREATE EXTENSION in 0015).
    index("agent_memories_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);

// Operator-wide memory defaults (Epic 8, Story 8.1) — a single row keyed "global". Ships OFF: memory
// is a privacy-sensitive, opt-in surface. The Settings UI (8.2) edits it; control-api is the sole writer.
export const memorySettings = pgTable("memory_settings", {
  id: text("id").primaryKey(), // always 'global'
  defaultEnabled: boolean("default_enabled").notNull().default(false),
  killSwitch: boolean("kill_switch").notNull().default(false),
  embeddingModel: text("embedding_model").notNull().default("text-embedding-3-small"),
  retentionDays: integer("retention_days"), // null = keep indefinitely
  privacy: text("privacy").notNull().default("agent-scoped"),
  requireApprovalDefault: boolean("require_approval_default").notNull().default(false), // Story 8.6 — staged-approval floor
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// The per-agent learning changelog (Epic 8, Story 8.6) — an append-only "git-log for the agent's mind".
// control-api is the sole writer (AD-7); reads are agent-scoped (FR-7). Each row snapshots the memory
// `summary` at event time so the log reads even after the memory is forgotten/rejected (its row gone).
export const memoryEvents = pgTable(
  "memory_events",
  {
    id: text("id").primaryKey(), // ULID
    agentId: text("agent_id").notNull(),
    memoryId: text("memory_id"), // nullable — a forgotten memory's row may be gone
    kind: text("kind").notNull(), // learned | reinforced | superseded | forgotten | accepted | rejected | quarantined | unquarantined | edited | pinned | unpinned
    summary: text("summary").notNull().default(""), // snapshot at event time
    sourceRunId: text("source_run_id"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("memory_events_agent_idx").on(t.agentId)],
);
