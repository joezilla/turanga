// run-orchestrator (E4-AD-4): a control-api module, the sole writer of Run state (AD-7). Launch
// follows the deterministic, fail-closed establish order (E4-AD-8) — any step failing fails the
// Run with a stated reason and NEVER falls through to unsandboxed execution (NFR-1). A run has a
// wall-clock deadline; a hung sandbox is killed. The per-run cost key + kill-on-429 is Story 4.5.
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
  sandboxVolume: string; // shared volume; the run's own subpath is mounted at /guard
  maxConcurrent?: number; // admission cap (default 5); rejects over the cap
  runTimeoutMs?: number; // wall-clock deadline per run (default 120s)
}

export type LaunchResult = { ok: true; run: RunRow } | { ok: false; error: string; status: 400 | 404 | 429 };

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
  const maxConcurrent = deps.maxConcurrent ?? 5;
  const runTimeoutMs = deps.runTimeoutMs ?? 120_000;
  let active = 0;

  async function finish(runId: string, status: RunStatus, reason?: string): Promise<RunRow> {
    await runsRepo.setStatus(runId, status, { reason: reason ?? null, endedAt: new Date().toISOString() });
    return (await runsRepo.get(runId))!;
  }

  return {
    async launch(agentId: string, taskInput: string): Promise<LaunchResult> {
      const agent = await agentsRepo.get(agentId);
      if (!agent) return { ok: false, error: "That agent doesn't exist.", status: 404 };
      if (!agent.model) return { ok: false, error: "An agent needs a model to run.", status: 400 };
      if (active >= maxConcurrent) return { ok: false, error: "Too many runs in progress. Try again in a moment.", status: 429 };

      // 1. Run=created + snapshot the immutable job spec (AD-9). skills=[] until Story 4.4.
      const runId = ulid(Date.now());
      const now = new Date().toISOString();
      const jobSpec: JobSpec = { v: 1, runId, agentId, model: agent.model, instructions: agent.instructions, skills: [], taskInput };
      await runsRepo.create({ id: runId, agentId, status: "created", taskInput, transcript: [], reason: null, createdAt: now, endedAt: null });

      // 2. Register the run with the guard (provisions the per-run UDS). Fail-closed.
      try {
        await guard.registerRun(runId);
      } catch (e) {
        await guard.teardownRun(runId); // in case a socket was half-provisioned
        return { ok: true, run: await finish(runId, "failed", `Couldn't prepare the guard: ${msg(e)}`) };
      }

      // 3. Establish the sandbox. Any failure → Run=failed with a stated reason; NEVER unsandboxed.
      let handle;
      try {
        handle = await runtime.establish({ runId, image, jobSpecJson: JSON.stringify(jobSpec), guardVolume: sandboxVolume });
      } catch (e) {
        await guard.teardownRun(runId);
        return { ok: true, run: await finish(runId, "failed", `Sandbox couldn't be established: ${msg(e)}`) };
      }

      // 4. Consume the control channel under a wall-clock deadline; ALWAYS reap + tear down.
      active++;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        void handle.kill(); // force-remove → the stream ends → the loop below exits
      }, runTimeoutMs);
      try {
        await runsRepo.setStatus(runId, "running");
        let terminal: RunStatus | null = null;
        for await (const line of handle.lines) {
          const parsed = ControlChannelMessageSchema.safeParse(safeJson(line));
          if (!parsed.success) continue; // ignore malformed control lines
          await runsRepo.appendMessage(runId, parsed.data);
          if (parsed.data.type === "done") {
            terminal = parsed.data.status; // first terminal wins
            break;
          }
        }
        // On a timeout we've already force-killed; don't block on `done` (it may never resolve).
        if (timedOut) return { ok: true, run: await finish(runId, "killed", `Run exceeded the ${Math.round(runTimeoutMs / 1000)}s time limit.`) };
        const { exitCode } = await handle.done;
        if (timedOut) return { ok: true, run: await finish(runId, "killed", `Run exceeded the ${Math.round(runTimeoutMs / 1000)}s time limit.`) };
        if (!terminal) terminal = exitCode === 0 ? "succeeded" : "failed";
        return { ok: true, run: await finish(runId, terminal, terminal === "failed" && exitCode !== 0 ? `Sandbox exited ${exitCode} without a done message.` : undefined) };
      } catch (e) {
        return { ok: true, run: await finish(runId, timedOut ? "killed" : "failed", timedOut ? "Run exceeded the time limit." : `Run stream error: ${msg(e)}`) };
      } finally {
        clearTimeout(timer);
        await handle.kill().catch(() => {});
        await guard.teardownRun(runId);
        active--;
      }
    },
  };
}

export type RunOrchestrator = ReturnType<typeof runOrchestrator>;
