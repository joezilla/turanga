// run-orchestrator (E4-AD-4): a control-api module, the sole writer of Run state (AD-7). Launch
// follows the deterministic, fail-closed establish order (E4-AD-8) — any step failing fails the
// Run with a stated reason and NEVER falls through to unsandboxed execution (NFR-1). Each control
// message is published to the RunHub so the SSE endpoint can stream it live (E4-AD-7). The per-run
// cost key + kill-on-429 is Story 4.5.
import { ulid, type LifecycleState } from "@turanga/domain";
import { CONTRACT_VERSION, ControlChannelMessageSchema, type JobSpec, type JobConnection } from "@turanga/contracts";
import type { RunsRepo, RunRow, RunStatus } from "./repo.js";
import type { SandboxRuntime, SandboxHandle } from "./runtime.js";
import type { RunGuard, RunProvision, ProvisionConnection } from "./guardClient.js";
import type { RunHub } from "./hub.js";
import { decryptSecret } from "../secrets/crypto.js";
import type { GoogleOAuth } from "../oauth/google.js";

interface AgentLike {
  id: string;
  model: string | null;
  instructions: string;
  state: LifecycleState;
  skills?: { scope: string }[]; // Story 4.3: a scoped skill (scope !== "none") means the agent uses Gmail
}
interface AgentsReader {
  get(id: string): Promise<AgentLike | null>;
}

// Minimal reader over data connections (Story 4.3 — resolve the run's Gmail connection + credential).
interface DataConnectionLike {
  id: string;
  provider: string;
  status: string;
  destinations: string[];
  encRefreshToken: string | null;
}
interface DataConnectionsReader {
  list(): Promise<DataConnectionLike[]>;
}

export interface OrchestratorDeps {
  runsRepo: RunsRepo;
  agentsRepo: AgentsReader;
  runtime: SandboxRuntime;
  guard: RunGuard;
  hub: RunHub;
  image: string;
  sandboxVolume: string;
  dataConnectionsRepo?: DataConnectionsReader; // Story 4.3 — absent ⇒ no connections (empty allowlist)
  googleOAuth?: GoogleOAuth; // Story 4.3 — mints the short-lived access token handed to the Guard
  maxConcurrent?: number;
  runTimeoutMs?: number;
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
  const { runsRepo, agentsRepo, runtime, guard, hub, image, sandboxVolume, dataConnectionsRepo, googleOAuth } = deps;
  const maxConcurrent = deps.maxConcurrent ?? 5;
  const runTimeoutMs = deps.runTimeoutMs ?? 120_000;
  let active = 0;

  // Story 4.3 — resolve what this run may reach. Two separate outputs (AD-10):
  //   • jobConnections  — LOGICAL handles the harness may attempt (sandbox-visible, NO secret).
  //   • provision       — the Guard's allowlist + HELD credentials (control-plane only, minted here).
  // Default-deny per-agent: only an agent with a scoped skill (scope !== "none") uses Gmail; the
  // credential is provisioned only when a connected Gmail connection exists AND a token mints. A
  // configured-but-unprovisionable connection still yields a logical handle → the harness attempts
  // it → the Guard refuses (nothing registered) — that's the observable default-deny path.
  async function resolveRunConnections(agent: AgentLike): Promise<{ jobConnections: JobConnection[]; provision: RunProvision }> {
    const usesGmail = (agent.skills ?? []).some((s) => s.scope !== "none");
    if (!usesGmail || !dataConnectionsRepo) return { jobConnections: [], provision: { connections: [] } };

    const gmail = (await dataConnectionsRepo.list()).find((c) => c.provider === "gmail");
    const connectionId = gmail?.id ?? "gmail"; // stable handle even with no connection → refused read
    const jobConnections: JobConnection[] = [{ id: connectionId, provider: "gmail" }];

    // Provision a credential ONLY for a connected connection with a mintable token (fail-closed:
    // any miss ⇒ no credential ⇒ the Guard refuses, never grants without a held token).
    const provision: RunProvision = { connections: [] };
    if (gmail && gmail.status === "connected" && gmail.encRefreshToken && googleOAuth?.isConfigured()) {
      try {
        const refreshToken = decryptSecret(gmail.encRefreshToken);
        const { accessToken } = await googleOAuth.accessTokenFromRefresh(refreshToken);
        const conn: ProvisionConnection = { connectionId, provider: "gmail", destinations: gmail.destinations, accessToken };
        provision.connections.push(conn);
      } catch {
        /* mint/decrypt failed → omit the credential (the read will be refused, not granted) */
      }
    }
    return { jobConnections, provision };
  }

  async function finish(runId: string, status: RunStatus, reason?: string): Promise<RunRow> {
    await runsRepo.setStatus(runId, status, { reason: reason ?? null, endedAt: new Date().toISOString() });
    return (await runsRepo.get(runId))!;
  }

  type Created = { ok: true; runId: string; jobSpec: JobSpec; row: RunRow; provision: RunProvision } | { ok: false; error: string; status: 400 | 404 | 429 };
  async function validateAndCreate(agentId: string, taskInput: string): Promise<Created> {
    const agent = await agentsRepo.get(agentId);
    if (!agent) return { ok: false, error: "That agent doesn't exist.", status: 404 };
    if (!agent.model) return { ok: false, error: "An agent needs a model to run.", status: 400 };
    if (active >= maxConcurrent) return { ok: false, error: "Too many runs in progress. Try again in a moment.", status: 429 };
    active++; // reserve the slot (released in execute's finally, OR here if we never reach execute)
    try {
      const runId = ulid(Date.now());
      const now = new Date().toISOString();
      const { jobConnections, provision } = await resolveRunConnections(agent);
      // The job spec carries only LOGICAL handles — the minted access token lives in `provision`
      // and goes to the Guard over the admin API, NEVER into the sandbox (AD-10).
      const jobSpec: JobSpec = { v: CONTRACT_VERSION, runId, agentId, model: agent.model, instructions: agent.instructions, skills: [], connections: jobConnections, taskInput };
      const row: RunRow = { id: runId, agentId, status: "created", taskInput, transcript: [], reason: null, createdAt: now, endedAt: null };
      await runsRepo.create(row);
      hub.open(runId); // hub state exists before start() hands the run back — the SSE subscriber won't miss the opening
      return { ok: true, runId, jobSpec, row, provision };
    } catch (e) {
      active--; // create() (or hub.open) threw — execute() will never run, so release the slot now
      throw e;
    }
  }

  // Runs the sandbox to a terminal state, publishing every control message to the hub. ALWAYS
  // reaps + tears down the guard, completes the hub, and releases the concurrency slot.
  async function execute(runId: string, jobSpec: JobSpec, provision: RunProvision): Promise<RunRow> {
    let terminal: RunStatus = "failed";
    let handle: SandboxHandle | undefined;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      try {
        await guard.registerRun(runId, provision); // allowlist + held credentials (never in the jobSpec)
      } catch (e) {
        return await finish(runId, (terminal = "failed"), `Couldn't prepare the guard: ${msg(e)}`);
      }
      try {
        handle = await runtime.establish({ runId, image, jobSpecJson: JSON.stringify(jobSpec), guardVolume: sandboxVolume });
      } catch (e) {
        return await finish(runId, (terminal = "failed"), `Sandbox couldn't be established: ${msg(e)}`);
      }

      await runsRepo.setStatus(runId, "running");
      timer = setTimeout(() => {
        timedOut = true;
        void handle!.kill();
      }, runTimeoutMs);

      let seen: RunStatus | null = null;
      for await (const line of handle.lines) {
        const parsed = ControlChannelMessageSchema.safeParse(safeJson(line));
        if (!parsed.success) continue;
        await runsRepo.appendMessage(runId, parsed.data);
        hub.publish(runId, parsed.data); // live relay to the SSE endpoint
        if (parsed.data.type === "done") {
          seen = parsed.data.status;
          break;
        }
      }
      if (timedOut) return await finish(runId, (terminal = "killed"), `Run exceeded the ${Math.round(runTimeoutMs / 1000)}s time limit.`);
      const { exitCode } = await handle.done;
      if (timedOut) return await finish(runId, (terminal = "killed"), `Run exceeded the ${Math.round(runTimeoutMs / 1000)}s time limit.`);
      terminal = seen ?? (exitCode === 0 ? "succeeded" : "failed");
      return await finish(runId, terminal, !seen && exitCode !== 0 ? `Sandbox exited ${exitCode} without a done message.` : undefined);
    } catch (e) {
      terminal = timedOut ? "killed" : "failed";
      return await finish(runId, terminal, timedOut ? "Run exceeded the time limit." : `Run stream error: ${msg(e)}`);
    } finally {
      if (timer) clearTimeout(timer);
      if (handle) await handle.kill().catch(() => {});
      await guard.teardownRun(runId);
      hub.complete(runId, terminal);
      active--;
    }
  }

  return {
    /** Synchronous: runs to completion and returns the terminal run (used by tests). */
    async launch(agentId: string, taskInput: string): Promise<LaunchResult> {
      const v = await validateAndCreate(agentId, taskInput);
      if (!v.ok) return v;
      return { ok: true, run: await execute(v.runId, v.jobSpec, v.provision) };
    },
    /** Async: returns the created (running) run immediately; the sandbox runs in the background
     *  and streams via the hub → SSE. Used by POST /runs. */
    async start(agentId: string, taskInput: string): Promise<LaunchResult> {
      const v = await validateAndCreate(agentId, taskInput);
      if (!v.ok) return v;
      void execute(v.runId, v.jobSpec, v.provision).catch(() => {});
      // Report `running` immediately from the row we just created (no redundant re-read) — execute()
      // flips the persisted status to running once the sandbox is established; the client watches
      // /events for the live transcript.
      return { ok: true, run: { ...v.row, status: "running" } };
    },
  };
}

export type RunOrchestrator = ReturnType<typeof runOrchestrator>;
