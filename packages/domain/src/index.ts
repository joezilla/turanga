// @turanga/domain — Glossary entities + cross-cutting conventions shared across TS apps.
// Types only for Story 1.1 (no logic beyond the id/money helpers that seed conventions).
// [Source: ARCHITECTURE-SPINE.md Consistency-Conventions; prd.md#3-Glossary]

export type Ulid = string; // opaque, ULID-shaped (26 chars, Crockford base32)

/** Money as integer minor units + ISO-4217 currency (never floats). */
export interface Money {
  minor: number;
  currency: string; // e.g. "USD"
}

export type LifecycleState = "draft" | "active";
export type RunStatus = "created" | "running" | "succeeded" | "failed" | "killed";
export type ConnectionKind = "model-provider" | "data";
export type ConnectionStatus = "connected" | "error" | "unconfigured";
export type BuiltinSkill = "read-search" | "draft-reply" | "flag-label" | "summarize";

/** Spend ceilings (Story 3.5). Each side is independently settable in Draft; "both required"
 *  is enforced only at the Activate gate (Story 5.1). Enforcement (LiteLLM 429s) is Epic 4. */
export interface CostCap {
  perRun: Money | null;
  perDay: Money | null;
}

/** The Activate gate (Story 5.1, FR-5). Returns the human reasons an agent can't be promoted to
 *  Active, in a stable order — `[]` means it's activatable. The single source of truth shared by the
 *  server enforcement (control-api, authoritative) and the disabled-with-reason UI, so they can't
 *  drift. `modelProviderConnected` is computed by the caller from its providers list. */
export function activationBlockers(agent: { model: string | null; costCap: CostCap }, modelProviderConnected: boolean): string[] {
  const reasons: string[] = [];
  if (!agent.model) reasons.push("Select a model.");
  else if (!modelProviderConnected) reasons.push("The selected model's provider isn't connected — reconnect it in Settings.");
  if (!agent.costCap.perRun) reasons.push("Set a per-run cost cap.");
  if (!agent.costCap.perDay) reasons.push("Set a per-day cost cap.");
  return reasons;
}

/** A named, reusable parameter referenced from instructions as `{name}` (Story 3.3). */
export interface AgentVariable {
  name: string;
  value: string;
}

/** Per-skill permission scope (Story 3.4). Default-deny (`none`); widened explicitly (FR-3).
 *  Concrete per-skill semantics + enforcement land in Epic 4 (the Guard / harness). */
export type SkillScope = "none" | "read" | "read-write";

/** A built-in skill attached to an agent with its permission scope + send-gate (Story 3.4).
 *  `send` is a distinct, off-by-default grant (FR-18), meaningful only for outbound skills. */
export interface AttachedSkill {
  skill: BuiltinSkill;
  scope: SkillScope;
  send: boolean;
}

export interface Agent {
  id: Ulid;
  name: string;
  description?: string; // one-line summary shown in the editor's identity block
  model?: string; // "provider/model-id"
  instructions: string;
  variables?: AgentVariable[];
  skills: AttachedSkill[];
  attachedTools: AttachedTool[]; // Story 6.3 — tools granted to this agent, per-operation (default-deny)
  costCap: CostCap; // Story 3.5 — always present; sides default null until set
  memoryConfig: MemoryConfig; // Story 8.1 — per-agent memory toggle (operational, NOT part of the published definition)
  state: LifecycleState;
  publishedVersion?: number | null; // newest published version; null/absent = never published
  publishedAt?: string | null; // UTC ISO-8601 of that publish
  createdAt: string; // UTC ISO-8601
}

// The agent-definition fields a publish snapshots. `state` is deliberately absent: lifecycle
// (Activate/Deactivate) is orthogonal to publishing, and a run must be sandboxed regardless.
export const PUBLISHED_FIELDS = [
  "name",
  "description",
  "model",
  "instructions",
  "variables",
  "skills",
  "attachedTools",
  "costCap",
] as const;
export type PublishedField = (typeof PUBLISHED_FIELDS)[number];

/** An immutable published snapshot of an agent's definition. */
export interface AgentVersion {
  version: number; // 1-based, per agent
  publishedAt: string; // UTC ISO-8601
  publishedBy: string | null;
  snapshot: Pick<Agent, PublishedField>;
}

export interface Connection {
  id: Ulid;
  kind: ConnectionKind;
  name: string;
  status: ConnectionStatus;
  destinations: string[]; // declared allowlist destinations
}

/** A tool an agent can invoke at runtime — an MCP server, either a remote endpoint or a
 *  self-deployed container (Epic 6). The endpoint type is an ADAPTER behind one contract; the common
 *  core is here. Endpoint-specific config (remote url/credential, container image/manifest) is added
 *  by later stories (6.2 / Epic 7). */
export type ToolEndpointType = "remote" | "container";
export type ToolStatus = "unverified" | "connected" | "error";

/** A discovered MCP tool descriptor (from `tools/list`) — an operation a tool exposes. Populated by
 *  discovery (Story 6.2); the type is defined here. */
export interface ToolOperation {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown; // JSON Schema (MCP defaults to 2020-12)
}

export interface Tool {
  id: Ulid;
  name: string;
  endpoint: ToolEndpointType;
  status: ToolStatus;
  operations: ToolOperation[];
  createdAt: string; // UTC ISO-8601
}

/** A tool attached to an agent with the operations it may call (Story 6.3) — the AttachedSkill
 *  analogue; default-deny (an empty `operations` grants nothing). */
export interface AttachedTool {
  toolId: Ulid;
  operations: string[]; // granted operation names
}

// ── Agent memory (Epic 8) ─────────────────────────────────────────────────────────────────────────
// A self-improving loop: reflect on runs → store durable memories → recall them next run. Control-plane
// only; agent-scoped; OFF by default; never holds a secret (AD-10). Story 8.1 lands the MODEL + store +
// config; recall (8.3) populates `embedding` + reads, reflection (8.4) writes.
export type MemoryKind = "episodic" | "semantic" | "procedure";
export const MEMORY_KINDS: readonly MemoryKind[] = ["episodic", "semantic", "procedure"] as const;

/** A learned memory record. `embedding` is populated by recall (Story 8.3); the record + store are 8.1. */
export interface Memory {
  id: Ulid;
  agentId: Ulid; // agent-scoped — no cross-agent read (FR-7)
  kind: MemoryKind;
  content: string; // verbatim
  summary: string;
  embedding: number[] | null; // populated in Story 8.3 (recall); the column exists now
  topic: string | null;
  salience: number;
  sourceRunId: Ulid | null;
  validFrom: string; // UTC ISO-8601
  validUntil: string | null; // null = still valid; a superseded fact closes its window (8.4)
  useCount: number;
  lastUsedAt: string | null;
  createdAt: string; // UTC ISO-8601
}

/** A memory's lifecycle state (Story 8.6). Only `active` is recalled; `pending` awaits staged approval;
 *  `quarantined` is a non-destructive rollback (excluded from recall, not deleted). */
export type MemoryStatus = "active" | "pending" | "quarantined";
export const MEMORY_STATUSES: readonly MemoryStatus[] = ["active", "pending", "quarantined"] as const;

/** A learning-changelog event kind (Story 8.6) — the "git-log for the agent's mind". */
export type MemoryEventKind =
  | "learned"
  | "reinforced"
  | "superseded"
  | "forgotten"
  | "accepted"
  | "rejected"
  | "quarantined"
  | "unquarantined"
  | "edited"
  | "pinned"
  | "unpinned";

/** Per-agent memory configuration (Story 8.1). `inherit` follows the global default — which ships OFF —
 *  so a new agent is effectively memory-off until deliberately enabled. */
export interface MemoryConfig {
  mode: "inherit" | "on" | "off";
  recall: boolean; // inject relevant memories at run start (8.3)
  reflect: boolean; // distill the run into memories afterward (8.4)
  kinds: MemoryKind[]; // which kinds this agent may learn/recall
  requireApproval: boolean; // Story 8.6 — hold new memories PENDING until the builder accepts them
}

/** The per-agent config a NEW agent gets: inherit + all capabilities on — effectively OFF while the
 *  global default is off (the operator turns memory on globally or per-agent). */
export const DEFAULT_MEMORY_CONFIG: MemoryConfig = { mode: "inherit", recall: true, reflect: true, kinds: [...MEMORY_KINDS], requireApproval: false };

/** Operator-wide memory defaults (Story 8.1). Ships OFF: memory is a privacy-sensitive, opt-in surface.
 *  `embeddingModel` drives compute in 8.3; the pgvector column dimension is fixed at build time. */
export interface MemoryGlobalConfig {
  defaultEnabled: boolean; // the effective value for a new agent's `inherit`
  killSwitch: boolean; // master off — overrides every agent
  embeddingModel: string;
  retentionDays: number | null; // null = keep indefinitely
  privacy: "agent-scoped"; // "shared across a builder's agents" is a deliberate later opt-in
  requireApprovalDefault: boolean; // Story 8.6 — a platform-wide staged-approval floor (OR'd with per-agent)
}

export const DEFAULT_MEMORY_GLOBAL_CONFIG: MemoryGlobalConfig = {
  defaultEnabled: false,
  killSwitch: false,
  embeddingModel: "text-embedding-3-small",
  retentionDays: null,
  privacy: "agent-scoped",
  requireApprovalDefault: false,
};

/** The single source of truth for whether + how memory runs for an agent (Story 8.1). Pure — the
 *  orchestrator (recall 8.3 / reflect 8.4) and the web (8.2) both read it; the harness never decides
 *  (AD-7/AD-9). `killSwitch` wins over everything; `inherit` follows the global default (OFF). */
export function effectiveMemoryConfig(
  global: MemoryGlobalConfig,
  perAgent: MemoryConfig,
): { enabled: boolean; recall: boolean; reflect: boolean; kinds: MemoryKind[]; requireApproval: boolean } {
  if (global.killSwitch) return { enabled: false, recall: false, reflect: false, kinds: [], requireApproval: false };
  const enabled = perAgent.mode === "on" ? true : perAgent.mode === "off" ? false : global.defaultEnabled;
  return {
    enabled,
    recall: enabled && perAgent.recall,
    reflect: enabled && perAgent.reflect,
    kinds: enabled ? perAgent.kinds : [],
    // Story 8.6 — OR: the operator can mandate approval platform-wide; an agent can additionally opt in.
    requireApproval: enabled && (global.requireApprovalDefault || perAgent.requireApproval),
  };
}

export interface Run {
  id: Ulid;
  agentId: Ulid;
  status: RunStatus;
  createdAt: string;
}

/** Structured refusal record — never silent (NFR-4). */
export interface Refusal {
  kind: "egress" | "permission";
  detail: string; // e.g. destination attempted, or skill/scope
  at: string; // UTC ISO-8601
}

// Minimal ULID generator (monotonic-enough for a single-machine skeleton; not crypto).
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function ulid(nowMs: number, rand: () => number = Math.random): Ulid {
  let ts = nowMs;
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[ts % 32] + time;
    ts = Math.floor(ts / 32);
  }
  let rnd = "";
  for (let i = 0; i < 16; i++) rnd += CROCKFORD[Math.min(31, Math.floor(rand() * 32))];
  return time + rnd;
}
