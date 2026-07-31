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

export interface CostCap {
  perRun: Money;
  perDay: Money;
}

export interface Agent {
  id: Ulid;
  name: string;
  model?: string; // "provider/model-id"
  instructions: string;
  skills: BuiltinSkill[];
  costCap?: CostCap;
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
