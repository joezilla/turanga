// egress-guard — the Guard broker (AD-2, AD-5). The sandbox's only route out.
// Health stays open (compose healthcheck). The run-admin API (Epic 4) is control-plane-only:
// the orchestrator registers/tears down a run's per-run UDS. Guarded by a shared admin token
// (constant-time compare) and strict runId validation (the guard rejects a bad id, fail-closed).
import { Hono } from "hono";
import { timingSafeEqual } from "node:crypto";
import type { Guard, ProvisionConnection } from "./guard.js";

export interface AppDeps {
  guard?: Guard;
  adminToken?: string;
}

function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createApp(deps: AppDeps = {}) {
  const app = new Hono();
  app.get("/health", (c) => c.json({ ok: true }));

  if (deps.guard) {
    const guard = deps.guard;
    const token = deps.adminToken ?? "";
    // Control-plane-only: only the orchestrator (which holds the token) may register/teardown runs.
    app.use("/admin/*", async (c, next) => {
      if (!tokenMatches(c.req.header("x-guard-admin"), token)) return c.json({ error: "Forbidden." }, 403);
      await next();
    });
    app.post("/admin/runs/:id/register", async (c) => {
      try {
        // The provision (allowlist + held credentials) is control-plane data — it arrives only over
        // this admin-token-guarded route, never in the sandbox's job spec (AD-10). An absent/empty
        // body means an empty allowlist (default-deny — the run reaches nothing).
        const provision = ((await c.req.json().catch(() => ({}))) ?? {}) as { connections?: unknown };
        const connections = Array.isArray(provision.connections) ? (provision.connections as ProvisionConnection[]) : [];
        const { socketPath } = await guard.register(c.req.param("id"), { connections });
        return c.json({ ok: true, socketPath });
      } catch (e) {
        return c.json({ error: e instanceof Error ? e.message : "Register failed." }, 400);
      }
    });
    app.post("/admin/runs/:id/teardown", async (c) => {
      await guard.teardown(c.req.param("id"));
      return c.json({ ok: true });
    });
  }

  return app;
}
