// control-api HTTP app. Trusted control plane (AD-1): owns Agent/Connection/Run state.
// Story 1.4 adds single-user auth (users/sessions). Health/version stay unauthenticated
// (compose healthchecks + web topbar depend on them).
import { Hono } from "hono";
import { cors } from "hono/cors";
import { authRoutes } from "./auth/routes.js";
import { memoryAuthRepo, type AuthRepo } from "./auth/repo.js";

export const VERSION = process.env.TURANGA_VERSION ?? "0.0.0";
export const GIT_SHA = process.env.TURANGA_GIT_SHA ?? "unknown";

export interface AppDeps {
  authRepo?: AuthRepo; // defaults to an in-memory repo (tests / no-DB boot)
  secureCookie?: boolean; // true in production (HTTPS)
}

export function createApp(deps: AppDeps = {}) {
  const app = new Hono();

  // Only the local web origin may call the control API, and it may send credentials
  // (the session cookie) — exact origin, never "*".
  const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:5173";
  app.use("/*", cors({ origin: webOrigin, credentials: true }));

  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/version", (c) => c.json({ version: VERSION, gitSha: GIT_SHA }));

  const repo = deps.authRepo ?? memoryAuthRepo();
  app.route("/", authRoutes(repo, { secureCookie: deps.secureCookie ?? false }));

  return app;
}
