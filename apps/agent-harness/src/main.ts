// agent-harness — runs INSIDE a per-run gVisor sandbox (AD-1, AD-4). No server, no DB,
// no direct network. It reads an immutable job spec (AD-9), runs the agent loop through
// the egress-guard, and emits control-channel messages. Story 1.1: entry stub only —
// it validates that it can parse a job spec. The real loop lands in Epic 4.
import { JobSpecSchema } from "@turanga/contracts";

export function readJobSpec(raw: unknown) {
  return JobSpecSchema.parse(raw);
}

if (process.env.NODE_ENV !== "test") {
  console.log("[agent-harness] stub — awaiting a job spec (Epic 4)");
}
