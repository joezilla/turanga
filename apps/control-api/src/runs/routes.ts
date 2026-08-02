import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { timingSafeEqual } from "node:crypto";
import { GuardRunEventSchema } from "@turanga/contracts";
import type { RunsRepo } from "./repo.js";
import type { RunOrchestrator } from "./orchestrator.js";
import type { RunHub } from "./hub.js";

// Run surface (Epic 4). 4.2 makes runs asynchronous: POST /runs launches in the background and
// returns the created (running) run immediately; the web test pane watches GET /runs/:id/events
// (SSE, E4-AD-7), which relays the run's control-channel messages live via the RunHub and falls
// back to the persisted transcript for a terminal or hub-evicted run.
const MAX_TASK_INPUT = 10_000; // the task input flows into an env-injected job spec — keep it bounded

function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function runRoutes(repo: RunsRepo, orchestrator: RunOrchestrator, hub: RunHub, callbackToken = "") {
  const app = new Hono();

  // The Guard→orchestrator control-plane callback (E4-AD-10, Story 4.5). NOT web-session-guarded —
  // it's control-plane, authenticated by the shared callback token (constant-time). Cost `metrics`
  // merge into the Run + SSE; a budget `kill` reaps the run.
  app.post("/internal/guard/runs/:id/events", async (c) => {
    if (!tokenMatches(c.req.header("x-guard-callback"), callbackToken)) return c.json({ error: "Forbidden." }, 403);
    const parsed = GuardRunEventSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Malformed guard event." }, 400);
    await orchestrator.handleGuardEvent(c.req.param("id"), parsed.data);
    return c.json({ ok: true });
  });

  // The agent's cumulative spend today (micro-USD) for the live daily meter (the web pairs it with the
  // agent's per-day cap it already holds). Session-guarded via /agents/* in app.ts.
  app.get("/agents/:id/cost", async (c) => {
    return c.json({ todayMicros: await repo.sumTodayMicros(c.req.param("id")) });
  });

  app.post("/runs", async (c) => {
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { agentId?: unknown; taskInput?: unknown };
    if (typeof body.agentId !== "string" || !body.agentId) {
      return c.json({ error: "An agentId is required." }, 400);
    }
    const taskInput = (typeof body.taskInput === "string" ? body.taskInput : "").slice(0, MAX_TASK_INPUT);
    try {
      const r = await orchestrator.start(body.agentId, taskInput);
      if (!r.ok) return c.json({ error: r.error }, r.status);
      return c.json({ run: r.run }, 201);
    } catch (e) {
      return c.json({ error: `The run couldn't be launched: ${e instanceof Error ? e.message : "unexpected error"}` }, 500);
    }
  });

  app.get("/runs/:id", async (c) => {
    const run = await repo.get(c.req.param("id"));
    if (!run) return c.json({ error: "That run doesn't exist." }, 404);
    return c.json({ run });
  });

  // SSE relay (E4-AD-7). Streams `message` events (one per control-channel message) then a final
  // `done` event carrying the terminal status. The hub is the live source for an in-flight run; a
  // terminal or hub-evicted run replays from the persisted transcript.
  app.get("/runs/:id/events", async (c) => {
    const id = c.req.param("id");
    const run = await repo.get(id);
    if (!run) return c.json({ error: "That run doesn't exist." }, 404);

    return streamSSE(c, async (stream) => {
      // Bridge the hub's synchronous callbacks to the async SSE writer via an ordered queue.
      const queue: { event: "message" | "done"; data: string }[] = [];
      let finished = false;
      let wake: (() => void) | null = null;
      const nudge = () => {
        wake?.();
        wake = null;
      };
      const push = (event: "message" | "done", data: unknown) => {
        queue.push({ event, data: JSON.stringify(data) });
        nudge();
      };

      const unsub = hub.subscribe(
        id,
        0,
        (msg) => push("message", msg),
        (status) => {
          push("done", { status });
          finished = true;
        },
      );

      if (!unsub) {
        // The hub doesn't know this run (terminal + evicted, or never live here) — the repo is the
        // truth. Replay the persisted transcript, then close. A run the hub has forgotten but whose
        // row is still non-terminal is orphaned (e.g. control-api restarted mid-run): report it as
        // `failed` so the client resolves cleanly instead of wedging on a running dot that never ends.
        const fresh = (await repo.get(id)) ?? run;
        const status = fresh.status === "created" || fresh.status === "running" ? "failed" : fresh.status;
        for (const msg of fresh.transcript) await stream.writeSSE({ event: "message", data: JSON.stringify(msg) });
        await stream.writeSSE({ event: "done", data: JSON.stringify({ status }) });
        return;
      }

      stream.onAbort(() => {
        unsub();
        finished = true;
        nudge();
      });

      // Drain until the terminal `done` event is written (or the client aborts).
      for (;;) {
        while (queue.length) {
          const e = queue.shift()!;
          await stream.writeSSE(e);
          if (e.event === "done") {
            unsub();
            return;
          }
        }
        if (finished) {
          unsub();
          return;
        }
        await new Promise<void>((r) => (wake = r));
      }
    });
  });

  app.get("/runs", async (c) => {
    return c.json({ runs: await repo.list(c.req.query("agentId")) }); // bounded by the repo default
  });

  return app;
}
