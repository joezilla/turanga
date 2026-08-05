// run-orchestrator (E4-AD-4): a control-api module, the sole writer of Run state (AD-7). Launch
// follows the deterministic, fail-closed establish order (E4-AD-8) — any step failing fails the
// Run with a stated reason and NEVER falls through to unsandboxed execution (NFR-1). Each control
// message is published to the RunHub so the SSE endpoint can stream it live (E4-AD-7). The per-run
// cost key + kill-on-429 is Story 4.5.
import { ulid, effectiveMemoryConfig, type LifecycleState, type AttachedSkill, type AttachedTool, type CostCap, type Money, type MemoryEventKind } from "@turanga/domain";
import { CONTRACT_VERSION, ControlChannelMessageSchema, type JobSpec, type JobConnection, type JobTool, type JobMemory, type JobHistoryTurn, type GuardRunEvent } from "@turanga/contracts";
import type { RunsRepo, RunRow, RunStatus } from "./repo.js";
import type { AgentVersionRow } from "../agents/repo.js";
import type { ConversationsRepo } from "../conversations/repo.js";
import type { SandboxRuntime, SandboxHandle } from "./runtime.js";
import type { RunGuard, RunProvision, ProvisionConnection, ProvisionTool, SkillGrant } from "./guardClient.js";
import type { RunHub } from "./hub.js";
import { decryptSecret } from "../secrets/crypto.js";
import type { GoogleOAuth } from "../oauth/google.js";
import type { ModelGateway } from "../litellm/gateway.js";
import type { MemoryRepo, MemoryRow } from "../memory/repo.js";
import { SUPERSEDE_MAX_DISTANCE } from "../memory/tuning.js";
import type { Reflector } from "../memory/reflector.js";

interface AgentLike {
  id: string;
  model: string | null;
  instructions: string;
  state: LifecycleState;
  skills?: AttachedSkill[]; // Story 4.3/4.4: scoped skills drive the connection + the Guard's grants
  attachedTools?: AttachedTool[]; // Story 6.3: per-operation tool grants → the sandbox-visible JobSpec.tools
  costCap?: CostCap; // Story 4.5: the per-run + per-day caps → the LiteLLM key hierarchy
}
interface AgentsReader {
  get(id: string): Promise<AgentLike | null>;
  // Story 9.2 — a chat turn resolves the PINNED published snapshot (not the draft) via this. The
  // concrete agentsRepo is the full AgentsRepo, which has it; the narrowed reader just exposes it.
  listVersions(id: string): Promise<AgentVersionRow[]>;
}

// Minimal reader over tools (Story 6.3/6.4). The `name` + `operations` resolve the sandbox-visible
// JobTool (no secret — AD-10); the `url` + `encCredential` resolve the Guard-only ProvisionTool (the
// credential is decrypted control-side and handed to the Guard, NEVER the jobSpec — Story 6.4, AD-10).
interface ToolLike {
  id: string;
  name: string;
  url: string | null;
  encCredential: string | null;
  operations: { name: string }[];
}
interface ToolsReader {
  getTool(id: string): Promise<ToolLike | null>;
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
  toolsRepo?: ToolsReader; // Story 6.3 — resolve granted-tool names for JobSpec.tools; absent ⇒ no tools
  memoryRepo?: MemoryRepo; // Story 8.1 — recall (8.3) reads + reflect (8.4) writes it.
  conversationsRepo?: ConversationsRepo; // Story 9.2 — a chat turn resolves its conversation (pinned version + thread) here.
  reflector?: Reflector; // Story 8.4 — distills a completed run's transcript into memories (post-run, master key)
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
  const { runsRepo, agentsRepo, runtime, guard, hub, image, sandboxVolume, dataConnectionsRepo, toolsRepo, memoryRepo, conversationsRepo, reflector, googleOAuth, modelGateway } = deps;
  const maxConcurrent = deps.maxConcurrent ?? 5;
  const RECALL_TOP_K = 5; // Story 8.3 — how many memories recall injects at most
  const MAX_RECALL_SUMMARY_CHARS = 500; // bound each injected memory so an un-distilled row can't blow the token budget
  // Story 8.4 (reflect/evolve) tuning constants.
  const PROCEDURE_TOOL_THRESHOLD = 2; // a run needs ≥ this many tool calls to distill "procedure" memories
  const DEDUPE_MAX_DISTANCE = 0.05; // ≤ this cosine distance to an existing same-kind memory ⇒ a duplicate (bump, don't insert)
  const MAX_MEMORIES_PER_AGENT = 200; // per-agent budget; excess is pruned lowest-salience-first
  const MAX_HISTORY_RUNS = 20; // Story 9.4 — a chat turn injects at most the last N exchanges; older turns are dropped (the summarize-older seam, Epic 8)
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

  // Story 6.3/6.4 — the granted tools, split two ways (the connection pattern, AD-10):
  //   • jobTools       — SANDBOX-VISIBLE logical handles { id, name, operations } (NO url/credential).
  //   • provisionTools — GUARD-ONLY { toolId, url, credential, operations } — the credential DECRYPTED
  //                      here in the control plane and handed to the Guard, never into the jobSpec.
  // Default-deny: an attached tool with no granted operations is omitted. A grant whose tool was deleted
  // is skipped rather than crashing the run. A tool with no url is sandbox-visible but not provisioned
  // (nothing for the Guard to reach → the call refuses on egress).
  async function resolveRunTools(agent: AgentLike): Promise<{ jobTools: JobTool[]; provisionTools: ProvisionTool[] }> {
    const granted = (agent.attachedTools ?? []).filter((t) => t.operations.length > 0);
    if (granted.length === 0 || !toolsRepo) return { jobTools: [], provisionTools: [] };
    const jobTools: JobTool[] = [];
    const provisionTools: ProvisionTool[] = [];
    for (const g of granted) {
      const tool = await toolsRepo.getTool(g.toolId);
      if (!tool) continue; // deleted tool — skip, don't fail the run
      // Grants were validated at save-time against the tool's operations; re-narrow to what it still offers.
      const offered = new Set(tool.operations.map((o) => o.name));
      const operations = g.operations.filter((op) => offered.has(op));
      if (operations.length === 0) continue;
      jobTools.push({ id: tool.id, name: tool.name, operations }); // sandbox-visible — no secret
      if (tool.url) {
        // Decrypt the held bearer token control-side; it goes ONLY into the provision (→ the Guard),
        // never the jobSpec (AD-10). A decrypt failure → an empty credential (the call refuses, not grants).
        let credential = "";
        if (tool.encCredential) {
          try {
            credential = decryptSecret(tool.encCredential);
          } catch {
            /* leave empty → the tool call is refused, never granted with a bad credential */
          }
        }
        provisionTools.push({ toolId: tool.id, url: tool.url, credential, operations });
      }
    }
    return { jobTools, provisionTools };
  }

  // Story 8.3 — RECALL: before the spec is built, inject what the agent has learned that's relevant to
  // the task. Embedding-only (zero LLM cost — runs BEFORE the per-run cost key is minted, on the master
  // key), gated by effectiveMemoryConfig(...).recall (8.2), agent-scoped (FR-7), secret-free (AD-10),
  // and FAIL-OPEN: any failure degrades to no memories — a run is NEVER blocked because recall failed.
  async function resolveRecall(agent: AgentLike, taskInput: string): Promise<{ memories: JobMemory[]; recalledIds: string[] }> {
    const empty = { memories: [], recalledIds: [] };
    if (!memoryRepo || !modelGateway) return empty;
    try {
      const global = await memoryRepo.getGlobalConfig();
      const eff = effectiveMemoryConfig(global, await memoryRepo.getAgentMemoryConfig(agent.id));
      if (!eff.recall) return empty; // the gate: off / inherit-off / killSwitch all resolve here
      // Embed the query with the SAME model memories are written with (8.4), so the vector spaces match.
      const embedding = await modelGateway.embed(taskInput, global.embeddingModel);
      const rows = await memoryRepo.recall(agent.id, embedding, RECALL_TOP_K, { kinds: eff.kinds });
      // Secret-free projection (AD-10): id/kind + distilled text only. Prefer summary, fall back to
      // content, and BOUND the length so an un-distilled row can't blow up the system-context token budget.
      const memories: JobMemory[] = rows.map((r) => ({ id: r.id, kind: r.kind, summary: (r.summary || r.content).slice(0, MAX_RECALL_SUMMARY_CHARS) }));
      return { memories, recalledIds: rows.map((r) => r.id) };
    } catch {
      return empty; // fail-open — recall is additive, never a guardrail
    }
  }

  // Story 8.4 — REFLECT: after a run is terminal, distill its transcript into durable memories and
  // evolve the store (dedupe→bump / insert / supersede / prune). Runs on the MASTER key AFTER the
  // per-run cost key is deleted, so it is structurally observed-not-metered (never on the cap/kill
  // path, AC3). Agent-scoped (FR-7). FAIL-SAFE: any error is swallowed — reflection is best-effort and
  // must never affect the already-completed run. Dispatched non-awaited from launch()/start().
  async function reflectRun(agentId: string, run: RunRow): Promise<void> {
    if (!reflector || !memoryRepo || !modelGateway) return;
    try {
      const agent = await agentsRepo.get(agentId);
      if (!agent?.model) return;
      const global = await memoryRepo.getGlobalConfig();
      const eff = effectiveMemoryConfig(global, await memoryRepo.getAgentMemoryConfig(agentId));
      if (!eff.reflect) return; // the gate — off / inherit-off / killSwitch all resolve here

      // The distillable material + behavioral signals from the persisted transcript.
      const turns = run.transcript
        .filter((m): m is Extract<typeof m, { type: "turn" }> => m.type === "turn")
        .map((m) => ({ role: m.role, text: m.text }));
      if (turns.length === 0) return; // nothing to learn from
      const toolCallCount = run.transcript.filter((m) => m.type === "tool").length;
      const refusals = run.transcript.filter((m) => m.type === "refusal").length;

      const distilled = (await reflector.reflect({ model: agent.model, taskInput: run.taskInput, turns, toolCallCount, refusals }))
        // enforce the agent's enabled kinds, and drop procedures below the tool threshold (defensive —
        // the prompt already conditions on it).
        .filter((m) => eff.kinds.includes(m.kind))
        .filter((m) => m.kind !== "procedure" || toolCallCount >= PROCEDURE_TOOL_THRESHOLD);

      // Story 8.6 — staged approval: when required, a new memory starts PENDING (never recalled) until
      // the builder accepts it; otherwise it's active immediately (the auto-apply loop).
      const status = eff.requireApproval ? "pending" : "active";
      const logEvent = (kind: MemoryEventKind, summary: string, memoryId: string | null) =>
        void memoryRepo!.logMemoryEvent({ id: ulid(Date.now()), agentId, memoryId, kind, summary, sourceRunId: run.id, at: new Date().toISOString() }).catch(() => {});

      const now = new Date().toISOString();
      for (const m of distilled) {
        // Per-item fail-safe (8.6 review): a single bad distilled item (e.g. a transient embed error)
        // must not abort the remaining items OR skip the prune below. Isolate each iteration.
        try {
          const embedding = await modelGateway.embed(m.content, global.embeddingModel);
          // Dedupe: a near-identical existing memory ⇒ promote-on-reuse (bump salience), do NOT insert.
          const dup = await memoryRepo.findSimilar(agentId, embedding, m.kind, DEDUPE_MAX_DISTANCE);
          if (dup) {
            await memoryRepo.bumpSalience(agentId, dup.id, 1);
            logEvent("reinforced", dup.summary || m.summary, dup.id);
            continue;
          }
          // Find the stale same-topic prior fact BEFORE inserting (so the new row can't be its own match —
          // findSimilar returns only the single nearest). Superseding is DEFERRED when the new memory is
          // PENDING: the accept route closes the stale fact at accept-time, so the topic keeps a
          // recallable fact until the builder approves the replacement (8.6 review).
          let staleToClose: MemoryRow | null = null;
          if (status === "active" && m.topic) {
            const stale = await memoryRepo.findSimilar(agentId, embedding, m.kind, SUPERSEDE_MAX_DISTANCE);
            if (stale && stale.topic === m.topic) staleToClose = stale;
          }
          const mem: MemoryRow = {
            id: ulid(Date.now()),
            agentId,
            kind: m.kind,
            content: m.content,
            summary: m.summary,
            embedding,
            topic: m.topic,
            salience: 1,
            pinned: false, // Story 8.5 — a new memory starts unpinned (prunable)
            status, // Story 8.6 — pending (staged approval) or active (auto-apply)
            sourceRunId: run.id, // the auditable causal link (8.5 renders "learned from this run")
            validFrom: now,
            validUntil: null,
            useCount: 0,
            lastUsedAt: null,
            createdAt: now,
          };
          // Insert FIRST, then supersede — a failed insert must never orphan the prior fact (8.6 review).
          await memoryRepo.createMemory(mem);
          logEvent("learned", m.summary, mem.id);
          if (staleToClose) {
            await memoryRepo.supersede(agentId, staleToClose.id, now);
            logEvent("superseded", staleToClose.summary, staleToClose.id);
          }
        } catch {
          /* per-item fail-safe — this item is skipped; the batch + prune continue */
        }
      }

      // Prune: keep the agent's memory set within budget, forgetting lowest-salience (then oldest)
      // first. The budget is measured over the ACTIVE set — non-active (pending/quarantined, 8.6) rows
      // are NOT counted, so an unreviewed pending backlog or an accumulating quarantine (the Epic-10
      // seam) never force-evicts the working set (8.6 review — pre-fix the count was over TOTAL storage,
      // which let non-recallable rows squeeze out active ones). PINNED rows count toward the budget (they
      // are active + recallable) but are never candidates — only active, unpinned rows can be forgotten.
      const active = (await memoryRepo.listForAgent(agentId)).filter((m) => m.status === "active");
      if (active.length > MAX_MEMORIES_PER_AGENT) {
        const doomed = active
          .filter((m) => !m.pinned)
          .sort((a, b) => a.salience - b.salience || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
          .slice(0, active.length - MAX_MEMORIES_PER_AGENT);
        for (const d of doomed) {
          await memoryRepo.deleteMemory(agentId, d.id);
          logEvent("forgotten", d.summary, d.id);
        }
      }
    } catch {
      /* fail-safe — reflection never affects the completed run */
    }
  }

  async function finish(runId: string, status: RunStatus, reason: string | undefined, costMicros: number): Promise<RunRow> {
    // Persist the run-cost summary = the summed metrics the Guard reported (AC3, no drift by construction).
    await runsRepo.setStatus(runId, status, { reason: reason ?? null, endedAt: new Date().toISOString(), costMicros });
    return (await runsRepo.get(runId))!;
  }

  type Created =
    | { ok: true; runId: string; jobSpec: JobSpec; row: RunRow; provision: RunProvision; costCap: CostCap | null }
    | { ok: false; error: string; status: 400 | 404 | 429 };

  // Story 9.2 — a chat turn's context: the conversation it belongs to, its 0-based position in the
  // thread, and the prior turns folded into the model context. Null for a standalone/test-console run.
  type ChatContext = { conversationId: string; turnIndex: number; history: JobHistoryTurn[] };

  // The shared run-build path (Story 9.2 — "a turn is a normal run, parameterized by a DEFINITION").
  // Both the test console (draft) and a chat turn (published snapshot) resolve an AgentLike + optional
  // chat context, then take the IDENTICAL Sandbox + Guard + cost-cap machinery here.
  //
  // INVARIANT (Story 5.2 AC2, NFR-1): state-agnostic — a Draft (Test) run and an Active run take the
  // identical establishment below; nothing here or in execute() branches on agent.state or on chat-vs-
  // draft. Do NOT add a state or chat condition to the establishment — a run must always be sandboxed
  // and guarded regardless of lifecycle. (Asserted by the "Active agent runs under the same
  // Sandbox/Guard" test in runs.test.ts.)
  async function assembleRun(agent: AgentLike, taskInput: string, chat: ChatContext | null): Promise<Created> {
    if (!agent.model) return { ok: false, error: "An agent needs a model to run.", status: 400 };
    if (active >= maxConcurrent) return { ok: false, error: "Too many runs in progress. Try again in a moment.", status: 429 };
    active++; // reserve the slot (released in execute's finally, OR here if we never reach execute)
    try {
      const runId = ulid(Date.now());
      const now = new Date().toISOString();
      const { jobConnections, jobSkills, provision } = await resolveRunConnections(agent);
      const { jobTools, provisionTools } = await resolveRunTools(agent); // Story 6.3/6.4 — sandbox handles + Guard-held creds
      provision.tools = provisionTools; // Story 6.4 — the granted tools + decrypted credentials go to the Guard (never the jobSpec)
      // Story 8.3 — recall (embedding-only, gated, fail-open) runs HERE, before the cost key is minted
      // in execute() — so it can never touch the run's cost cap. Composes with a chat turn's short-term
      // `history` (Story 9.2): long-term memory + the thread so far both fold into the model context.
      const { memories, recalledIds } = await resolveRecall(agent, taskInput);
      // The job spec carries only LOGICAL handles + skill/tool IDs + secret-free recalled memories +
      // secret-free prior turns — the minted access token, the cost key, AND the authoritative
      // scope/send grants + tool credentials live in `provision` and go to the Guard over the admin
      // API, NEVER into the sandbox (AD-10). `history` is [] for a standalone run; a chat turn (9.2)
      // fills it from the pinned conversation.
      const jobSpec: JobSpec = { v: CONTRACT_VERSION, runId, agentId: agent.id, model: agent.model, instructions: agent.instructions, skills: jobSkills, connections: jobConnections, tools: jobTools, memories, history: chat?.history ?? [], taskInput };
      // Auditable causality (NFR-4): record which memories this run recalled, as a transcript event on the
      // row at creation (orchestrator-authored, not a harness stream message), and bump their usage counters.
      const transcript = recalledIds.length > 0 ? [{ type: "recall" as const, v: CONTRACT_VERSION, memoryIds: recalledIds, count: recalledIds.length }] : [];
      const row: RunRow = { id: runId, agentId: agent.id, conversationId: chat?.conversationId ?? null, turnIndex: chat?.turnIndex ?? null, status: "created", taskInput, transcript, reason: null, costMicros: 0, createdAt: now, endedAt: null };
      await runsRepo.create(row);
      if (recalledIds.length > 0 && memoryRepo) void memoryRepo.markRecalled(agent.id, recalledIds).catch(() => {}); // best-effort; never blocks the run
      hub.open(runId); // hub state exists before start() hands the run back — the SSE subscriber won't miss the opening
      return { ok: true, runId, jobSpec, row, provision, costCap: agent.costCap ?? null };
    } catch (e) {
      active--; // create() (or hub.open) threw — execute() will never run, so release the slot now
      throw e;
    }
  }

  // The test console (draft) path: resolves the WORKING DRAFT, not the published version — the test
  // console exists precisely to try unsaved-since-publish edits (Story 5.2/publish decision).
  async function validateAndCreate(agentId: string, taskInput: string): Promise<Created> {
    const agent = await agentsRepo.get(agentId);
    if (!agent) return { ok: false, error: "That agent doesn't exist.", status: 404 };
    return assembleRun(agent, taskInput, null);
  }

  // Story 9.2 — the chat-turn path: resolves the conversation's PINNED published snapshot (not the
  // draft), reconstructs the thread so far into `history`, and links the run to the conversation.
  async function validateChatTurn(conversationId: string, taskInput: string): Promise<Created> {
    if (!conversationsRepo) return { ok: false, error: "Chat isn't available.", status: 400 };
    const conv = await conversationsRepo.get(conversationId);
    if (!conv) return { ok: false, error: "That conversation doesn't exist.", status: 404 };
    // Resolve the pinned snapshot (AC #3: a later publish never changes an in-flight conversation).
    const pinned = (await agentsRepo.listVersions(conv.agentId)).find((v) => v.version === conv.publishedVersion);
    if (!pinned) return { ok: false, error: "That published version is no longer available.", status: 404 };
    const snap = pinned.snapshot;
    const agent: AgentLike = {
      id: conv.agentId,
      model: snap.model,
      instructions: snap.instructions,
      state: "active", // unused — the run path is state-agnostic (see assembleRun's invariant note)
      skills: snap.skills,
      attachedTools: snap.attachedTools,
      costCap: snap.costCap,
    };
    // Reconstruct the thread from the conversation's prior runs (each run's transcript already carries
    // its user turn + the agent reply as `turn` messages). turnIndex = the next 0-based position — the
    // TRUE thread position, NOT windowed. Story 9.4 — the injected history is BOUNDED to the last N runs
    // (whole exchanges, so a user turn is never orphaned from its reply) so a long thread's context (and
    // cost) can't grow unbounded; the per-turn cost cap stays authoritative. Dropping older exchanges is
    // the summarize-older seam (Epic 8 memory) — additive later.
    const prior = await runsRepo.listByConversation(conv.id);
    const turnIndex = prior.length; // the TRUE thread position — counts EVERY prior turn, not windowed/filtered
    // Reconstruct history from SUCCEEDED turns only (code-review 9.x): a killed/failed turn may carry a
    // user turn with no agent reply, and an in-flight turn carries a partial (or empty) transcript —
    // either injects an orphaned `user` turn, producing consecutive user messages the model rejects. A
    // succeeded run always carries a clean user+agent pair. Then window to the last N whole exchanges.
    const windowed = prior.filter((r) => r.status === "succeeded").slice(-MAX_HISTORY_RUNS);
    const history: JobHistoryTurn[] = windowed.flatMap((r) =>
      r.transcript.filter((m): m is Extract<typeof m, { type: "turn" }> => m.type === "turn").map((m) => ({ role: m.role, content: m.text })),
    );
    return assembleRun(agent, taskInput, { conversationId: conv.id, turnIndex, history });
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
      const run = await execute(v.runId, agentId, v.jobSpec, v.provision, v.costCap);
      void reflectRun(agentId, run).catch(() => {}); // Story 8.4 — post-run, non-blocking, fail-safe
      return { ok: true, run };
    },
    /** Async: returns the created (running) run immediately; the sandbox runs in the background
     *  and streams via the hub → SSE. Used by POST /runs. */
    async start(agentId: string, taskInput: string): Promise<LaunchResult> {
      const v = await validateAndCreate(agentId, taskInput);
      if (!v.ok) return v;
      // Story 8.4 — reflect chains on the backgrounded run (after it's terminal), non-blocking + fail-safe.
      void execute(v.runId, agentId, v.jobSpec, v.provision, v.costCap)
        .then((run) => reflectRun(agentId, run))
        .catch(() => {});
      // Report `running` immediately from the row we just created (no redundant re-read) — execute()
      // flips the persisted status to running once the sandbox is established; the client watches
      // /events for the live transcript.
      return { ok: true, run: { ...v.row, status: "running" } };
    },
    /** Story 9.2 — send a message to a conversation: build a run from the pinned published snapshot
     *  with the thread so far as history, run it in the background, return the created (running) run
     *  immediately. A chat turn is a normal run — same execute/reflect path as start(). */
    async startChatTurn(conversationId: string, taskInput: string): Promise<LaunchResult> {
      const v = await validateChatTurn(conversationId, taskInput);
      if (!v.ok) return v;
      void execute(v.runId, v.row.agentId, v.jobSpec, v.provision, v.costCap)
        .then((run) => reflectRun(v.row.agentId, run))
        .catch(() => {});
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
