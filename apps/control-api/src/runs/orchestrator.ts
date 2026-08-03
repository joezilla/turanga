// run-orchestrator (E4-AD-4): a control-api module, the sole writer of Run state (AD-7). Launch
// follows the deterministic, fail-closed establish order (E4-AD-8) — any step failing fails the
// Run with a stated reason and NEVER falls through to unsandboxed execution (NFR-1). Each control
// message is published to the RunHub so the SSE endpoint can stream it live (E4-AD-7). The per-run
// cost key + kill-on-429 is Story 4.5.
import { ulid, type LifecycleState, type AttachedSkill, type CostCap, type Money } from "@turanga/domain";
import { CONTRACT_VERSION, ControlChannelMessageSchema, type JobSpec, type JobConnection, type GuardRunEvent } from "@turanga/contracts";
import type { RunsRepo, RunRow, RunStatus } from "./repo.js";
import type { SandboxRuntime, SandboxHandle } from "./runtime.js";
import type { RunGuard, RunProvision, ProvisionConnection, SkillGrant } from "./guardClient.js";
import type { RunHub } from "./hub.js";
import { decryptSecret } from "../secrets/crypto.js";
import type { GoogleOAuth } from "../oauth/google.js";
import type { ModelGateway } from "../litellm/gateway.js";

interface AgentLike {
  id: string;
  model: string | null;
  instructions: string;
  state: LifecycleState;
  skills?: AttachedSkill[]; // Story 4.3/4.4: scoped skills drive the connection + the Guard's grants
  costCap?: CostCap; // Story 4.5: the per-run + per-day caps → the LiteLLM key hierarchy
}
interface AgentsReader {
  get(id: string): Promise<AgentLike | null>;
}

// A live run's control handle, so a Guard callback (E4-AD-10) can act on it — merge cost metrics or
// reap on a budget breach. Registered while a run streams, dropped in the finally.
interface RunController {
  onMetrics(event: Extract<GuardRunEvent, { type: "metrics" }>): Promise<void>;
  onKill(scope: "run" | "day"): void;
}

const fmtCap = (m: Money | null | undefined): string => (m ? `$${(m.minor / 100).toFixed(2)}` : "the cap");

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
  modelGateway?: ModelGateway; // Story 4.5 — mints the per-run cost key; absent ⇒ Guard uses the master key (unmetered)
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
  const { runsRepo, agentsRepo, runtime, guard, hub, image, sandboxVolume, dataConnectionsRepo, googleOAuth, modelGateway } = deps;
  const maxConcurrent = deps.maxConcurrent ?? 5;
  const runTimeoutMs = deps.runTimeoutMs ?? 120_000;
  let active = 0;
  const controllers = new Map<string, RunController>(); // live runs, for Guard→orchestrator callbacks (E4-AD-10)

  // Story 4.3/4.4 — resolve what this run may do. Three separate outputs (AD-10):
  //   • jobConnections  — LOGICAL handles the harness may attempt (sandbox-visible, NO secret).
  //   • jobSkills       — the skill IDs the harness runs (sandbox-visible; the scope/send are NOT
  //                       authoritative here — the Guard enforces via `grants`).
  //   • provision       — the Guard's allowlist + HELD credentials + skill GRANTS (control-plane only).
  // Default-deny per-agent: only skills with scope !== "none" count. The credential is provisioned
  // only when a connected Gmail connection exists AND a token mints; but the GRANTS + logical handle
  // are always present for scoped skills, so an out-of-scope/ungranted op refuses on permission and a
  // credential-less connection refuses on egress — both observable without OAuth.
  async function resolveRunConnections(agent: AgentLike): Promise<{ jobConnections: JobConnection[]; jobSkills: string[]; provision: RunProvision }> {
    const scoped = (agent.skills ?? []).filter((s) => s.scope !== "none");
    const jobSkills = scoped.map((s) => s.skill);
    const grants: SkillGrant[] = scoped.map((s) => ({ scope: s.scope, send: s.send }));
    if (scoped.length === 0 || !dataConnectionsRepo) return { jobConnections: [], jobSkills, provision: { connections: [], grants } };

    const gmail = (await dataConnectionsRepo.list()).find((c) => c.provider === "gmail");
    const connectionId = gmail?.id ?? "gmail"; // stable handle even with no connection → refused op
    const jobConnections: JobConnection[] = [{ id: connectionId, provider: "gmail" }];

    // Mint the short-lived credential ONLY for a connected connection with a mintable token
    // (fail-closed: any miss ⇒ empty token ⇒ the Guard refuses on egress, never grants without one).
    let accessToken = "";
    if (gmail && gmail.status === "connected" && gmail.encRefreshToken && googleOAuth?.isConfigured()) {
      try {
        const refreshToken = decryptSecret(gmail.encRefreshToken);
        ({ accessToken } = await googleOAuth.accessTokenFromRefresh(refreshToken));
      } catch {
        /* mint/decrypt failed → leave the token empty (the op will be refused, not granted) */
      }
    }
    // Always provision the connection's metadata (provider + declared destinations) so the Guard can
    // name the destination in a refusal even when uncredentialed (NFR-4); the TOKEN is the only
    // conditional part. The allowlist derives from the (possibly empty) destinations — default-deny.
    const conn: ProvisionConnection = { connectionId, provider: "gmail", destinations: gmail?.destinations ?? [], accessToken };
    const provision: RunProvision = { connections: [conn], grants };
    return { jobConnections, jobSkills, provision };
  }

  async function finish(runId: string, status: RunStatus, reason: string | undefined, costMicros: number): Promise<RunRow> {
    // Persist the run-cost summary = the summed metrics the Guard reported (AC3, no drift by construction).
    await runsRepo.setStatus(runId, status, { reason: reason ?? null, endedAt: new Date().toISOString(), costMicros });
    return (await runsRepo.get(runId))!;
  }

  type Created =
    | { ok: true; runId: string; jobSpec: JobSpec; row: RunRow; provision: RunProvision; costCap: CostCap | null }
    | { ok: false; error: string; status: 400 | 404 | 429 };
  async function validateAndCreate(agentId: string, taskInput: string): Promise<Created> {
    const agent = await agentsRepo.get(agentId);
    if (!agent) return { ok: false, error: "That agent doesn't exist.", status: 404 };
    if (!agent.model) return { ok: false, error: "An agent needs a model to run.", status: 400 };
    if (active >= maxConcurrent) return { ok: false, error: "Too many runs in progress. Try again in a moment.", status: 429 };
    active++; // reserve the slot (released in execute's finally, OR here if we never reach execute)
    try {
      const runId = ulid(Date.now());
      const now = new Date().toISOString();
      const { jobConnections, jobSkills, provision } = await resolveRunConnections(agent);
      // The job spec carries only LOGICAL handles + skill IDs — the minted access token, the cost key,
      // AND the authoritative scope/send grants live in `provision` and go to the Guard over the admin
      // API, NEVER into the sandbox (AD-10).
      const jobSpec: JobSpec = { v: CONTRACT_VERSION, runId, agentId, model: agent.model, instructions: agent.instructions, skills: jobSkills, connections: jobConnections, taskInput };
      const row: RunRow = { id: runId, agentId, status: "created", taskInput, transcript: [], reason: null, costMicros: 0, createdAt: now, endedAt: null };
      await runsRepo.create(row);
      hub.open(runId); // hub state exists before start() hands the run back — the SSE subscriber won't miss the opening
      return { ok: true, runId, jobSpec, row, provision, costCap: agent.costCap ?? null };
    } catch (e) {
      active--; // create() (or hub.open) threw — execute() will never run, so release the slot now
      throw e;
    }
  }

  // Runs the sandbox to a terminal state, publishing every control message to the hub. ALWAYS
  // reaps + tears down the guard, deletes the cost key, completes the hub, releases the slot.
  async function execute(runId: string, agentId: string, jobSpec: JobSpec, provision: RunProvision, costCap: CostCap | null): Promise<RunRow> {
    let terminal: RunStatus = "failed";
    let handle: SandboxHandle | undefined;
    let timedOut = false;
    let breached: { scope: "run" | "day" } | null = null; // set by the Guard callback (E4-AD-10)
    let costMicros = 0; // accumulated from the Guard's metrics events (the persisted summary = this, AC3)
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The breach `kill` is an async Guard→control-api callback that can land just after the harness's
    // in-band `done`. This resolvable lets us briefly settle for it so the terminal is `killed`, not `failed`.
    let signalBreach: (() => void) | null = null;
    const breachSignal = new Promise<void>((resolve) => (signalBreach = resolve));
    try {
      // Step 2 (E4-AD-8): mint the per-run cost key under the agent's daily-budget team. Fail-closed:
      // a mint failure fails the Run (no unmetered run). Absent gateway ⇒ no key (Guard uses master).
      if (modelGateway) {
        try {
          const teamId = await modelGateway.ensureAgentTeam(agentId, costCap?.perDay ?? null);
          provision.costKey = await modelGateway.mintRunKey({ teamId, perRunCap: costCap?.perRun ?? null, runId });
        } catch (e) {
          return await finish(runId, (terminal = "failed"), `Couldn't mint the cost key: ${msg(e)}`, 0);
        }
      }
      try {
        await guard.registerRun(runId, provision); // allowlist + held credentials + cost key (never in the jobSpec)
      } catch (e) {
        return await finish(runId, (terminal = "failed"), `Couldn't prepare the guard: ${msg(e)}`, 0);
      }
      try {
        handle = await runtime.establish({ runId, image, jobSpecJson: JSON.stringify(jobSpec), guardVolume: sandboxVolume });
      } catch (e) {
        return await finish(runId, (terminal = "failed"), `Sandbox couldn't be established: ${msg(e)}`, 0);
      }

      // Register the run's controller so a Guard callback can merge cost metrics + reap on a breach.
      const activeHandle = handle;
      controllers.set(runId, {
        async onMetrics(event) {
          costMicros += event.costMicros;
          const m = { type: "metrics" as const, v: CONTRACT_VERSION, latencyMs: event.latencyMs, tokens: event.tokens, costMicros: event.costMicros };
          await runsRepo.appendMessage(runId, m);
          hub.publish(runId, m); // the Guard is the cost truth now (E4-AD-10) — stream it like a harness message
        },
        onKill(scope) {
          breached = { scope };
          signalBreach?.(); // wake a post-`done` settle so the terminal resolves as killed, not failed
          void activeHandle.kill().catch(() => {}); // reap the run that can no longer progress
        },
      });

      await runsRepo.setStatus(runId, "running");
      timer = setTimeout(() => {
        timedOut = true;
        void activeHandle.kill();
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
      // On a `failed` done, the cause may be a budget breach whose out-of-band `kill` callback is
      // still in flight — briefly settle for it so the breach WINS the terminal (killed, not failed).
      // The happy path (succeeded) never waits.
      if (seen === "failed" && !breached && !timedOut) {
        await Promise.race([breachSignal, new Promise<void>((r) => setTimeout(r, 250).unref?.())]);
      }
      // A budget breach or the wall-clock timeout WINS the terminal (over the harness's `done`).
      const killReason = (): string => {
        const scope = breached!.scope;
        return `Killed — ${scope === "day" ? "per-day" : "per-run"} cost cap reached (${fmtCap(scope === "day" ? costCap?.perDay : costCap?.perRun)}).`;
      };
      if (breached) return await finish(runId, (terminal = "killed"), killReason(), costMicros);
      if (timedOut) return await finish(runId, (terminal = "killed"), `Run exceeded the ${Math.round(runTimeoutMs / 1000)}s time limit.`, costMicros);
      const { exitCode } = await handle.done.catch(() => ({ exitCode: -1 }));
      if (breached) return await finish(runId, (terminal = "killed"), killReason(), costMicros);
      if (timedOut) return await finish(runId, (terminal = "killed"), `Run exceeded the ${Math.round(runTimeoutMs / 1000)}s time limit.`, costMicros);
      terminal = seen ?? (exitCode === 0 ? "succeeded" : "failed");
      return await finish(runId, terminal, !seen && exitCode !== 0 ? `Sandbox exited ${exitCode} without a done message.` : undefined, costMicros);
    } catch (e) {
      terminal = breached ? "killed" : timedOut ? "killed" : "failed";
      return await finish(runId, terminal, breached ? "Killed — cost cap reached." : timedOut ? "Run exceeded the time limit." : `Run stream error: ${msg(e)}`, costMicros);
    } finally {
      controllers.delete(runId);
      if (timer) clearTimeout(timer);
      if (handle) await handle.kill().catch(() => {});
      await guard.teardownRun(runId);
      if (modelGateway && provision.costKey) await modelGateway.deleteKey(provision.costKey).catch(() => {}); // no leaked LiteLLM keys
      hub.complete(runId, terminal);
      active--;
    }
  }

  return {
    /** Synchronous: runs to completion and returns the terminal run (used by tests). */
    async launch(agentId: string, taskInput: string): Promise<LaunchResult> {
      const v = await validateAndCreate(agentId, taskInput);
      if (!v.ok) return v;
      return { ok: true, run: await execute(v.runId, agentId, v.jobSpec, v.provision, v.costCap) };
    },
    /** Async: returns the created (running) run immediately; the sandbox runs in the background
     *  and streams via the hub → SSE. Used by POST /runs. */
    async start(agentId: string, taskInput: string): Promise<LaunchResult> {
      const v = await validateAndCreate(agentId, taskInput);
      if (!v.ok) return v;
      void execute(v.runId, agentId, v.jobSpec, v.provision, v.costCap).catch(() => {});
      // Report `running` immediately from the row we just created (no redundant re-read) — execute()
      // flips the persisted status to running once the sandbox is established; the client watches
      // /events for the live transcript.
      return { ok: true, run: { ...v.row, status: "running" } };
    },
    /** The Guard→orchestrator control-plane callback (E4-AD-10). Cost `metrics` merge into the Run +
     *  SSE; a budget `kill` reaps the run. Events for an unknown/terminal run are ignored. */
    async handleGuardEvent(runId: string, event: GuardRunEvent): Promise<void> {
      const c = controllers.get(runId);
      if (!c) return;
      if (event.type === "metrics") await c.onMetrics(event);
      else c.onKill(event.scope);
    },
  };
}

export type RunOrchestrator = ReturnType<typeof runOrchestrator>;
