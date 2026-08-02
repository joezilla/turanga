// @turanga/contracts — versioned contracts between control-api (producer) and the
// agent-harness (consumer). Owned by control-api (AD-9). Stub shapes for Story 1.1;
// they harden in Epic 4. The `v` field is the contract version — bump on any change.
import { z } from "zod";

// v2 (Story 4.3): the harness↔Guard protocol gains connection-read entries (E4-AD-9), and the
// job spec carries logical connection handles.
export const CONTRACT_VERSION = 2 as const;

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
    costMinor: z.number(),
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

/** A logical, read-only connection operation the harness issues over the per-run UDS (Story 4.3,
 *  E4-AD-9). The harness names an op + a connection handle — never a URL, key, or token. The Guard
 *  resolves the destination, checks the run's allowlist, attaches the held credential, and forwards
 *  (mode a, AD-5). `op` is a small read-only vocabulary; it grows as connections/skills land. */
export const GuardConnectionRequestSchema = z.object({
  v: z.literal(CONTRACT_VERSION),
  runId: z.string(),
  connectionId: z.string(),
  op: z.enum(["gmail.list"]),
  params: z.object({ maxResults: z.number().int().min(1).max(25) }).partial().optional(),
});
export type GuardConnectionRequest = z.infer<typeof GuardConnectionRequestSchema>;

/** The Guard's response to a connection read. On an allowlist/credential denial: `ok:false` +
 *  `refusal` (the Guard composes the human `detail`; the harness relays it as a `refusal` control
 *  message). `data` never carries the credential (AD-10). */
export const GuardConnectionResponseSchema = z.object({
  v: z.literal(CONTRACT_VERSION),
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
  refusal: z.object({ destination: z.string(), detail: z.string() }).optional(),
  latencyMs: z.number().optional(),
});
export type GuardConnectionResponse = z.infer<typeof GuardConnectionResponseSchema>;
