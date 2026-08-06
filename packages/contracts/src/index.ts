// @turanga/contracts — versioned contracts between control-api (producer) and the
// agent-harness (consumer). Owned by control-api (AD-9). Stub shapes for Story 1.1;
// they harden in Epic 4. The `v` field is the contract version — bump on any change.
import { z } from "zod";

// v9 (Story 12.1): tool loop — GuardModelRequest.tools/toolChoice + tool-role messages + tool_calls;
// GuardModelResponse.toolCalls/finishReason; JobTool.operations gains per-op argument schemas so the
// model can call with structured args. Secret-free — names + arg schemas only, no endpoint/credential
// (AD-10). The model-driven loop that consumes this lands in Story 12.4.
// v8 (Story 9.1): history — a sandbox-visible `JobSpec.history` of prior conversation turns (chat =
// threaded runs; each turn is a fresh run carrying the thread so far). Secret-free turn content like
// taskInput (AD-10); default [] keeps every non-chat spec valid. The harness folds it into the model
// context in Story 9.2.
// v7 (Story 8.3): recall — a sandbox-visible `JobSpec.memories` list folded into the model's system
// context, plus a `recall` transcript event recording which memories a run injected. Memories are
// secret-free distilled text (AD-10); recall is embedding-only (no LLM cost).
// v6 (Story 6.5): structured `tool` invocation records on the control channel — a recorded,
// per-tool observability event (outcome + latency); observed only, never metered/killed (AC2).
// v5 (Story 6.1): tools — a logical JobTool handle on the job spec + the harness↔Guard tool-invoke
// protocol (ToolCallRequest/Response). No endpoint/credential in either (AD-10).
// v4 (Story 4.5): metrics cost is real (micro-USD `costMicros`); the Guard→orchestrator event
// channel (metrics + kill) is defined here (E4-AD-10, out-of-band control-plane).
// v3 (Story 4.4): provider-agnostic connection ops (read | label | send), refusal `kind`, skill policy.
// v2 (Story 4.3): connection-read entries + logical connection handles.
export const CONTRACT_VERSION = 9 as const;

/** A logical connection handle the agent is configured to use. NO token, URL, or destination —
 *  the Guard holds the credential + allowlist per-run (AD-10); the sandbox names only the handle. */
export const JobConnectionSchema = z.object({
  id: z.string(),
  provider: z.literal("gmail"),
});
export type JobConnection = z.infer<typeof JobConnectionSchema>;

/** A logical tool handle the agent may invoke (Story 6.1). Names the tool + the operations granted —
 *  NO endpoint URL, NO credential (AD-10); the Guard resolves the endpoint + holds the credential.
 *  Story 12.1: each granted operation carries its ARGUMENT SCHEMA (`{ name, description?, inputSchema }`)
 *  so the model can call it with structured args. `inputSchema` is an opaque JSON-Schema record (no
 *  dialect hard-coded). 12.1 emits name-only; Story 12.2 fills real description + inputSchema from the
 *  registered tool. Still secret-free — a name + a schema, never an endpoint/credential (AD-10). */
export const JobToolOperationSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
});
export type JobToolOperation = z.infer<typeof JobToolOperationSchema>;

export const JobToolSchema = z.object({
  id: z.string(),
  name: z.string(),
  operations: z.array(JobToolOperationSchema),
});
export type JobTool = z.infer<typeof JobToolSchema>;

/** A memory recalled into a run (Story 8.3). Secret-free distilled text — `summary` is like an
 *  instructions fragment, NEVER a credential/endpoint (AD-10). Injected immutably at run start and
 *  folded into the model's system context by the harness. */
export const JobMemorySchema = z.object({
  id: z.string(),
  kind: z.enum(["episodic", "semantic", "procedure"]),
  summary: z.string(),
});
export type JobMemory = z.infer<typeof JobMemorySchema>;

/** A prior conversation turn injected into a chat run (Story 9.1). Chat is threaded runs: each turn is
 *  a fresh run whose spec carries the thread so far. `content` is secret-free turn text like taskInput
 *  (AD-10) — NEVER a credential/endpoint. The role literals mirror the `turn` control message. The
 *  harness folds these into the model context ahead of the current message (Story 9.2). */
export const JobHistoryTurnSchema = z.object({
  role: z.enum(["user", "agent"]),
  content: z.string(),
});
export type JobHistoryTurn = z.infer<typeof JobHistoryTurnSchema>;

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
  // Logical tool handles the harness may invoke (Story 6.1; no endpoint/secret — AD-10). Default
  // keeps older specs valid.
  tools: z.array(JobToolSchema).default([]),
  // Memories recalled for this run (Story 8.3; secret-free distilled text — AD-10). Default keeps
  // older specs valid; recall is off by default, so most specs carry [].
  memories: z.array(JobMemorySchema).default([]),
  // Prior conversation turns for a chat run (Story 9.1; secret-free content like taskInput — AD-10).
  // Default [] keeps every non-chat spec valid; the harness folds it into the model context in 9.2.
  history: z.array(JobHistoryTurnSchema).default([]),
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
  // A recorded tool invocation (Story 6.5) — observed ONLY: carries NO cost and never touches the
  // breach/kill path (AC2). `outcome` is ok (success) | error (tool isError / transport) | refused
  // (a Guard denial); `detail` is the refusal/error reason (never a secret — the Guard composed it).
  z.object({
    type: z.literal("tool"),
    v: z.literal(CONTRACT_VERSION),
    toolId: z.string(),
    toolName: z.string(),
    operation: z.string(),
    outcome: z.enum(["ok", "error", "refused"]),
    latencyMs: z.number(),
    detail: z.string().optional(),
  }),
  // Recall (Story 8.3) — an ORCHESTRATOR-authored transcript event (not a harness/Guard stream
  // message): records which memories recall injected into this run, for the auditable "learned →
  // recalled" causal chain (NFR-4). No cost, no kill path — recall is embedding-only.
  z.object({
    type: z.literal("recall"),
    v: z.literal(CONTRACT_VERSION),
    memoryIds: z.array(z.string()),
    count: z.number(),
  }),
  z.object({ type: z.literal("done"), v: z.literal(CONTRACT_VERSION), status: z.enum(["succeeded", "failed", "killed"]) }),
]);
export type ControlChannelMessage = z.infer<typeof ControlChannelMessageSchema>;

/** A tool the model may call, in OpenAI function-calling shape (Story 12.1). The Guard proxies it
 *  to LiteLLM, which normalizes function-calling across every provider. Secret-free: a name + a
 *  JSON-schema for the arguments — NO endpoint, NO credential (AD-10). `parameters` is a JSON Schema
 *  object; kept as an opaque record so the contract doesn't hard-code a schema dialect. */
export const GuardModelToolSchema = z.object({
  type: z.literal("function"),
  function: z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type GuardModelTool = z.infer<typeof GuardModelToolSchema>;

/** A tool call the model chose to make (OpenAI shape). `arguments` is a JSON STRING (the provider
 *  serializes the args) — the harness parses it before brokering the call through the Guard. */
export const GuardModelToolCallSchema = z.object({
  id: z.string(),
  type: z.literal("function"),
  function: z.object({ name: z.string(), arguments: z.string() }),
});
export type GuardModelToolCall = z.infer<typeof GuardModelToolCallSchema>;

/** One chat message on the model call. Widened for the tool loop: adds the `tool` role and the
 *  `tool_calls`/`tool_call_id` that carry the reason→act→observe thread across iterations. `content`
 *  is nullable (an assistant turn that ONLY calls tools carries null content). A plain string message
 *  (system/user/assistant) — every pre-tool-loop caller — still satisfies this schema unchanged. */
export const GuardModelMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string().nullable().optional(),
  tool_calls: z.array(GuardModelToolCallSchema).optional(),
  tool_call_id: z.string().optional(),
});
export type GuardModelMessage = z.infer<typeof GuardModelMessageSchema>;

/** The harness↔Guard logical-request protocol (E4-AD-9). A model call is the chat-completions
 *  shape the Guard proxies to LiteLLM. The harness never sees a URL, key, or token (AD-5/AD-10).
 *  Connection reads + plain egress are added in Story 4.3. `tools`/`toolChoice` (Story 12.1) are
 *  optional — a plain draft/skill model call omits them and behaves exactly as before. */
export const GuardModelRequestSchema = z.object({
  v: z.literal(CONTRACT_VERSION),
  runId: z.string(),
  model: z.string(),
  messages: z.array(GuardModelMessageSchema),
  tools: z.array(GuardModelToolSchema).optional(),
  toolChoice: z.unknown().optional(),
});
export type GuardModelRequest = z.infer<typeof GuardModelRequestSchema>;

export const GuardModelResponseSchema = z.object({
  v: z.literal(CONTRACT_VERSION),
  ok: z.boolean(),
  text: z.string().optional(),
  error: z.string().optional(),
  tokens: z.number().optional(),
  latencyMs: z.number().optional(),
  // Tool loop: the assistant's chosen tool calls + why the provider stopped. Absent on a plain text
  // answer; present (with finishReason "tool_calls") when the model wants to act before answering.
  toolCalls: z.array(GuardModelToolCallSchema).optional(),
  finishReason: z.string().optional(),
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

/** The harness↔Guard tool-invoke protocol (Story 6.1; brokered in 6.4). The harness names the
 *  LOGICAL tool + operation + arguments (maps to MCP `tools/call`) — never the endpoint URL or the
 *  credential (AD-10). The Guard resolves the endpoint, injects the held bearer token, performs the
 *  MCP call, and returns the result. */
export const ToolCallRequestSchema = z.object({
  v: z.literal(CONTRACT_VERSION),
  runId: z.string(),
  toolId: z.string(),
  operation: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional(),
});
export type ToolCallRequest = z.infer<typeof ToolCallRequestSchema>;

/** The Guard's response to a tool call. Maps to the MCP result: `content` blocks + `isError` (a
 *  tool-EXECUTION error, distinct from a Guard `refusal`). On a Guard denial: `ok:false` + `refusal`
 *  (`permission` for an ungranted op, `egress` for an off-allowlist/uncredentialed endpoint). No
 *  credential ever crosses this boundary (AD-10). */
export const ToolCallResponseSchema = z.object({
  v: z.literal(CONTRACT_VERSION),
  ok: z.boolean(),
  content: z.array(z.unknown()).optional(), // MCP content blocks (text/image/resource/…)
  isError: z.boolean().optional(), // MCP tool-execution error (inside a successful call — read this, not HTTP status)
  error: z.string().optional(),
  refusal: z.object({ kind: z.enum(["permission", "egress"]), detail: z.string() }).optional(),
  latencyMs: z.number().optional(),
});
export type ToolCallResponse = z.infer<typeof ToolCallResponseSchema>;

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
