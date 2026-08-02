// egress-guard — the Guard broker (AD-2, AD-5). The sandbox's only route out.
// Health stays open (compose healthcheck). The run-admin API (Epic 4) is control-plane-only:
// the orchestrator registers/tears down a run's per-run UDS. Guarded by a shared admin token.
import { Hono } from "hono";
import type { Guard } from "./guard.js";

export interface AppDeps {
  guard?: Guard;
  adminToken?: string;
}

export function createApp(deps: AppDeps = {}) {
  const app = new Hono();
  app.get("/health", (c) => c.json({ ok: true }));

  if (deps.guard) {
    const guard = deps.guard;
    const token = deps.adminToken ?? "";
    // Control-plane-only: only the orchestrator (which holds the token) may register/teardown runs.
    app.use("/admin/*", async (c, next) => {
      if (!token || c.req.header("x-guard-admin") !== token) return c.json({ error: "Forbidden." }, 403);
      await next();
    });
    app.post("/admin/runs/:id/register", async (c) => {
      const { socketPath } = await guard.register(c.req.param("id"));
      return c.json({ ok: true, socketPath });
    });
    app.post("/admin/runs/:id/teardown", async (c) => {
      await guard.teardown(c.req.param("id"));
      return c.json({ ok: true });
    });
  }

  return app;
}
