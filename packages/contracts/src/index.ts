// @turanga/contracts — versioned contracts between control-api (producer) and the
// agent-harness (consumer). Owned by control-api (AD-9). Stub shapes for Story 1.1;
// they harden in Epic 4. The `v` field is the contract version — bump on any change.
import { z } from "zod";

// v4 (Story 4.5): metrics cost is real (micro-USD `costMicros`); the Guard→orchestrator event
// channel (metrics + kill) is defined here (E4-AD-10, out-of-band control-plane).
// v3 (Story 4.4): provider-agnostic connection ops (read | label | send), refusal `kind`, skill policy.
// v2 (Story 4.3): connection-read entries + logical connection handles.
export const CONTRACT_VERSION = 4 as const;

/** A logical connection handle the agent is configured to use. NO token, URL, or destination —
 *  the Guard holds the credential + allowlist per-run (AD-10); the sandbox names only the handle. */
export const JobConnectionSchema = z.object({
  id: z.string(),
  provider: z.literal("gmail"),
});
export type JobConnection = z.infer<typeof JobConnectionSchema>;

/** Immutable job spec injected into a sandbox at run start (AD-9). */
export const JobSpecSchema = z.object({
  v: z.literal(CONTRACT_VERSION),
  runId: z.string(),
  agentId: z.string(),
  model: z.string(),
  instructions: z.string(),
  skills: z.array(z.string()),
  // Logical connection handles the harness may read from (no secret — AD-10). Default keeps older
  // construction that omits it valid.
  connections: z.array(JobConnectionSchema).default([]),
  // Runtime data ingress is proxy-mediated (AD-9); the spec carries only the task input.
  taskInput: z.string(),
});
export type JobSpec = z.infer<typeof JobSpecSchema>;

/** Structured events the harness emits on the single control channel (AD-9). */
export const ControlChannelMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("turn"), v: z.literal(CONTRACT_VERSION), role: z.enum(["user", "agent"]), text: z.string() }),
  z.object({
    type: z.literal("metrics"),
    v: z.literal(CONTRACT_VERSION),
    latencyMs: z.number(),
    tokens: z.number(),
    costMicros: z.number(), // cost in micro-USD (1e-6 USD) — fine enough for sub-cent per-call costs
  }),
  z.object({ type: z.literal("refusal"), v: z.literal(CONTRACT_VERSION), kind: z.enum(["egress", "permission"]), detail: z.string() }),
  z.object({ type: z.literal("done"), v: z.literal(CONTRACT_VERSION), status: z.enum(["succeeded", "failed", "killed"]) }),
]);
export type ControlChannelMessage = z.infer<typeof ControlChannelMessageSchema>;

/** The harness↔Guard logical-request protocol (E4-AD-9). A model call is the chat-completions
 *  shape the Guard proxies to LiteLLM. The harness never sees a URL, key, or token (AD-5/AD-10).
 *  Connection reads + plain egress are added in Story 4.3. */
export const GuardModelRequestSchema = z.object({
  v: z.literal(CONTRACT_VERSION),
  runId: z.string(),
  model: z.string(),
  messages: z.array(z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string() })),
});
export type GuardModelRequest = z.infer<typeof GuardModelRequestSchema>;

export const GuardModelResponseSchema = z.object({
  v: z.literal(CONTRACT_VERSION),
  ok: z.boolean(),
  text: z.string().optional(),
  error: z.string().optional(),
  tokens: z.number().optional(),
  latencyMs: z.number().optional(),
});
export type GuardModelResponse = z.infer<typeof GuardModelResponseSchema>;

/** A logical connection operation the harness issues over the per-run UDS (Story 4.3/4.4, E4-AD-9).
 *  The op is PROVIDER-AGNOSTIC (SM-4) — the connection (by handle → provider) resolves the
 *  destination + adapter; the harness names an op + a connection handle, never a URL, key, or token.
 *  The Guard authorizes the op against the run's skill grants (4.4), checks the allowlist + held
 *  credential (4.3), then forwards (mode a, AD-5). */
export const ConnectionOpSchema = z.enum(["read", "label", "send"]);
export type ConnectionOp = z.infer<typeof ConnectionOpSchema>;

export const GuardConnectionRequestSchema = z.object({
  v: z.literal(CONTRACT_VERSION),
  runId: z.string(),
  connectionId: z.string(),
  op: ConnectionOpSchema,
  params: z.record(z.string(), z.unknown()).optional(),
});
export type GuardConnectionRequest = z.infer<typeof GuardConnectionRequestSchema>;

/** The Guard's response to a connection op. On a denial: `ok:false` + `refusal` (the Guard composes
 *  the human `detail` and the `kind` — `permission` for an out-of-scope/ungranted op, `egress` for
 *  an off-allowlist/uncredentialed one; the harness relays both). `data` never carries the
 *  credential (AD-10). */
export const GuardConnectionResponseSchema = z.object({
  v: z.literal(CONTRACT_VERSION),
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
  refusal: z.object({ destination: z.string(), detail: z.string(), kind: z.enum(["egress", "permission"]) }).optional(),
  latencyMs: z.number().optional(),
});
export type GuardConnectionResponse = z.infer<typeof GuardConnectionResponseSchema>;

// ── Skill → connection-op permission policy (Story 4.4) ──────────────────────────────────────────
// Provider-agnostic and Guard-enforced. This is the ONLY place the skill/scope/op relationship
// lives; the skill code, the harness, and the orchestrator all read it, and no email specifics
// appear here (SM-4). A skill's authoring model (scope + send) is in @turanga/domain; these are the
// same literals, kept here so the harness↔Guard contract is self-contained.
export type SkillScope = "none" | "read" | "read-write";

/** What each connection op requires: a minimum permission scope, and whether it needs the send grant. */
export const OP_REQUIREMENTS: Record<ConnectionOp, { requiredScope: "read" | "read-write"; requiresSend: boolean }> = {
  read: { requiredScope: "read", requiresSend: false },
  label: { requiredScope: "read-write", requiresSend: false },
  send: { requiredScope: "read-write", requiresSend: true },
};

/** Which ops each built-in skill performs (drives the harness's deterministic run). A drafted reply
 *  is the model's turn; `send` is the gated outbound op. */
export const SKILL_OPS: Record<string, ConnectionOp[]> = {
  "read-search": ["read"],
  summarize: ["read"],
  "flag-label": ["label"],
  "draft-reply": ["send"],
};

export function scopeRank(scope: SkillScope): number {
  return scope === "read-write" ? 2 : scope === "read" ? 1 : 0;
}

/** The single enforcement predicate: is `op` authorized by ANY of the agent's skill grants? An op is
 *  allowed only if some granted skill meets its required scope AND (when the op sends) carries the
 *  send grant. Default-deny — no grant authorizes anything (FR-3/FR-18). */
export function authorizes(grants: { scope: SkillScope; send: boolean }[], op: ConnectionOp): boolean {
  const req = OP_REQUIREMENTS[op];
  return grants.some((g) => scopeRank(g.scope) >= scopeRank(req.requiredScope) && (!req.requiresSend || g.send));
}

/** The Guard→orchestrator control-plane event channel (Story 4.5, E4-AD-10). The Guard reports cost
 *  and a budget breach to the orchestrator OUT OF BAND (not via the sandbox), so cost/kill truth is
 *  the Guard/LiteLLM, never the harness. Delivered over a token-authenticated control-api callback,
 *  never the harness UDS. (Refusals move here in a later story; harness-relayed for now.) */
export const GuardRunEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("metrics"), v: z.literal(CONTRACT_VERSION), latencyMs: z.number(), tokens: z.number(), costMicros: z.number() }),
  z.object({ type: z.literal("kill"), v: z.literal(CONTRACT_VERSION), scope: z.enum(["run", "day"]), detail: z.string().optional() }),
]);
export type GuardRunEvent = z.infer<typeof GuardRunEventSchema>;
