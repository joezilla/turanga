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
  model?: string; // "provider/model-id"
  instructions: string;
  variables?: AgentVariable[];
  skills: AttachedSkill[];
  attachedTools: AttachedTool[]; // Story 6.3 — tools granted to this agent, per-operation (default-deny)
  costCap: CostCap; // Story 3.5 — always present; sides default null until set
  state: LifecycleState;
  createdAt: string; // UTC ISO-8601
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
