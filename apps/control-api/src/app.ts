// control-api HTTP app. Trusted control plane (AD-1): owns Agent/Connection/Run state
// (added in later stories). Story 1.1 exposes only health/version wiring.
import { Hono } from "hono";
import { cors } from "hono/cors";

export const VERSION = process.env.TURANGA_VERSION ?? "0.0.0";
export const GIT_SHA = process.env.TURANGA_GIT_SHA ?? "unknown";

export function createApp() {
  const app = new Hono();

  // Only the local web origin may call the control API (single authenticated surface later).
  const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:5173";
  app.use("/*", cors({ origin: webOrigin }));

  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/version", (c) => c.json({ version: VERSION, gitSha: GIT_SHA }));

  return app;
}
