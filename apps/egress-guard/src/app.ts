// egress-guard — the Guard broker (AD-2, AD-5). The sandbox's only route out.
// Story 1.1 is a skeleton: health only. Allowlist + credential injection + filter hook
// land in Epic 4. Default posture is deny (NFR-2) — enforced when the proxy is built.
import { Hono } from "hono";

export function createApp() {
  const app = new Hono();
  app.get("/health", (c) => c.json({ ok: true }));
  return app;
}
