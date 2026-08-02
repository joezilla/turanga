// run-orchestrator (E4-AD-4): a control-api module, the sole writer of Run state (AD-7). Launch
// follows the deterministic, fail-closed establish order (E4-AD-8) — any step failing fails the
// Run with a stated reason and NEVER falls through to unsandboxed execution (NFR-1). The per-run
// cost key + kill-on-429 is Story 4.5; the transcript here is store-and-return (SSE is 4.2).
import { ulid, type LifecycleState } from "@turanga/domain";
import { ControlChannelMessageSchema, type JobSpec } from "@turanga/contracts";
import type { RunsRepo, RunRow, RunStatus } from "./repo.js";
import type { SandboxRuntime } from "./runtime.js";
import type { RunGuard } from "./guardClient.js";

interface AgentLike {
  id: string;
  model: string | null;
  instructions: string;
  state: LifecycleState;
}
interface AgentsReader {
  get(id: string): Promise<AgentLike | null>;
}

export interface OrchestratorDeps {
  runsRepo: RunsRepo;
  agentsRepo: AgentsReader;
  runtime: SandboxRuntime;
  guard: RunGuard;
  image: string; // the agent-harness image tag
  sandboxVolume: string; // named volume bound to /guard in the sandbox (holds the per-run UDS)
}

export type LaunchResult = { ok: true; run: RunRow } | { ok: false; error: string; status: 400 | 404 };

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
function safeJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export function runOrchestrator(deps: OrchestratorDeps) {
  const { runsRepo, agentsRepo, runtime, guard, image, sandboxVolume } = deps;

  async function finish(runId: string, status: RunStatus, reason?: string): Promise<RunRow> {
    await runsRepo.setStatus(runId, status, { reason: reason ?? null, endedAt: new Date().toISOString() });
    return (await runsRepo.get(runId))!;
  }

  return {
    async launch(agentId: string, taskInput: string): Promise<LaunchResult> {
      const agent = await agentsRepo.get(agentId);
      if (!agent) return { ok: false, error: "That agent doesn't exist.", status: 404 };
      if (!agent.model) return { ok: false, error: "An agent needs a model to run.", status: 400 };

      // 1. Run=created + snapshot the immutable job spec (AD-9). skills=[] until Story 4.4.
      const runId = ulid(Date.now());
      const now = new Date().toISOString();
      const jobSpec: JobSpec = { v: 1, runId, agentId, model: agent.model, instructions: agent.instructions, skills: [], taskInput };
      await runsRepo.create({ id: runId, agentId, status: "created", taskInput, transcript: [], reason: null, createdAt: now, endedAt: null });

      // 2. Register the run with the guard (provisions the per-run UDS). Fail-closed.
      try {
        await guard.registerRun(runId);
      } catch (e) {
        return { ok: true, run: await finish(runId, "failed", `Couldn't prepare the guard: ${msg(e)}`) };
      }

      // 3. Establish the sandbox (configured runtime, --network=none, UDS, job spec on stdin).
      //    Any failure → Run=failed with a stated reason; NEVER an unsandboxed fallback.
      let handle;
      try {
        handle = await runtime.establish({ runId, image, jobSpecJson: JSON.stringify(jobSpec), guardSocketDir: sandboxVolume });
      } catch (e) {
        await guard.teardownRun(runId);
        return { ok: true, run: await finish(runId, "failed", `Sandbox couldn't be established: ${msg(e)}`) };
      }

      // 4. Run=running; consume the control channel; always reap + tear down the guard.
      await runsRepo.setStatus(runId, "running");
      let terminal: RunStatus | null = null;
      try {
        for await (const line of handle.lines) {
          const parsed = ControlChannelMessageSchema.safeParse(safeJson(line));
          if (!parsed.success) continue; // ignore malformed control lines
          await runsRepo.appendMessage(runId, parsed.data);
          if (parsed.data.type === "done") terminal = parsed.data.status;
        }
        const { exitCode } = await handle.done;
        if (!terminal) terminal = exitCode === 0 ? "succeeded" : "failed";
        return { ok: true, run: await finish(runId, terminal, terminal === "failed" && exitCode !== 0 ? `Sandbox exited ${exitCode} without a done message.` : undefined) };
      } catch (e) {
        return { ok: true, run: await finish(runId, "failed", `Run stream error: ${msg(e)}`) };
      } finally {
        await handle.kill().catch(() => {});
        await guard.teardownRun(runId);
      }
    },
  };
}

export type RunOrchestrator = ReturnType<typeof runOrchestrator>;
