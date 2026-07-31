// @turanga/contracts — versioned contracts between control-api (producer) and the
// agent-harness (consumer). Owned by control-api (AD-9). Stub shapes for Story 1.1;
// they harden in Epic 4. The `v` field is the contract version — bump on any change.
import { z } from "zod";

export const CONTRACT_VERSION = 1 as const;

/** Immutable job spec injected into a sandbox at run start (AD-9). */
export const JobSpecSchema = z.object({
  v: z.literal(CONTRACT_VERSION),
  runId: z.string(),
  agentId: z.string(),
  model: z.string(),
  instructions: z.string(),
  skills: z.array(z.string()),
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
