// control-api HTTP app. Trusted control plane (AD-1): owns Agent/Connection/Run state.
// Auth (Story 1.4) + model-provider connections (Story 2.1). Health/version stay
// unauthenticated (compose healthchecks + web topbar depend on them); /connections/*
// and /models require a valid session (server-side guard, Story 2.1).
import { Hono } from "hono";
import { cors } from "hono/cors";
import { authRoutes } from "./auth/routes.js";
import { requireSession } from "./auth/guard.js";
import { memoryAuthRepo, type AuthRepo } from "./auth/repo.js";
import { connectionRoutes } from "./connections/routes.js";
import { memoryConnectionsRepo, type ConnectionsRepo } from "./connections/repo.js";
import { fakeModelGateway, type ModelGateway } from "./litellm/gateway.js";
import { dataConnectionRoutes } from "./oauth/routes.js";
import { memoryDataConnectionsRepo, type DataConnectionsRepo } from "./connections/dataRepo.js";
import { googleOAuth, type GoogleOAuth } from "./oauth/google.js";
import { agentRoutes } from "./agents/routes.js";
import { memoryAgentsRepo, type AgentsRepo } from "./agents/repo.js";
import { runRoutes } from "./runs/routes.js";
import { memoryRunsRepo, type RunsRepo } from "./runs/repo.js";
import { runOrchestrator, type RunOrchestrator } from "./runs/orchestrator.js";
import { fakeSandboxRuntime } from "./runs/runtime.js";
import { fakeRunGuard } from "./runs/guardClient.js";
import { createRunHub, type RunHub } from "./runs/hub.js";

export const VERSION = process.env.TURANGA_VERSION ?? "0.0.0";
export const GIT_SHA = process.env.TURANGA_GIT_SHA ?? "unknown";

export interface AppDeps {
  authRepo?: AuthRepo; // defaults to an in-memory repo (tests / no-DB boot)
  secureCookie?: boolean; // true in production (HTTPS)
  connectionsRepo?: ConnectionsRepo;
  modelGateway?: ModelGateway;
  dataConnectionsRepo?: DataConnectionsRepo;
  googleOAuth?: GoogleOAuth;
  agentsRepo?: AgentsRepo;
  runsRepo?: RunsRepo;
  runHub?: RunHub; // the live SSE relay; MUST be the same instance the orchestrator publishes to
  orchestrator?: RunOrchestrator; // defaults to a fake-runtime orchestrator (tests / no-Docker boot)
  guardCallbackToken?: string; // authenticates the Guard→orchestrator callback (Story 4.5)
}

export function createApp(deps: AppDeps = {}) {
  const app = new Hono();

  // Only the local web origin may call the control API, and it may send credentials
  // (the session cookie) — exact origin, never "*".
  const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:5173";
  app.use("/*", cors({ origin: webOrigin, credentials: true }));

  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/version", (c) => c.json({ version: VERSION, gitSha: GIT_SHA }));

  const authRepo = deps.authRepo ?? memoryAuthRepo();
  app.route("/", authRoutes(authRepo, { secureCookie: deps.secureCookie ?? false }));

  // Protected surface — server-side session enforcement.
  app.use("/connections/*", requireSession(authRepo));
  app.use("/models", requireSession(authRepo));
  app.use("/oauth/*", requireSession(authRepo));
  app.use("/agents", requireSession(authRepo));
  app.use("/agents/*", requireSession(authRepo));
  app.use("/runs", requireSession(authRepo));
  app.use("/runs/*", requireSession(authRepo));
  const agentsRepo = deps.agentsRepo ?? memoryAgentsRepo();
  const connectionsRepo = deps.connectionsRepo ?? memoryConnectionsRepo();
  const gateway = deps.modelGateway ?? fakeModelGateway();
  app.route("/", connectionRoutes(connectionsRepo, gateway, agentsRepo)); // agentsRepo → dependents guard (3.6)

  const dataConnectionsRepo = deps.dataConnectionsRepo ?? memoryDataConnectionsRepo();
  const google = deps.googleOAuth ?? googleOAuth();
  app.route("/", dataConnectionRoutes(dataConnectionsRepo, google, webOrigin));

  app.route("/", agentRoutes(agentsRepo));

  const runsRepo = deps.runsRepo ?? memoryRunsRepo();
  // The hub is the live SSE relay; the orchestrator and the routes MUST share one instance.
  const runHub = deps.runHub ?? createRunHub();
  // Default orchestrator uses a fake runtime + fake guard so the app boots + tests run without
  // Docker; server.ts injects the real Docker-backed orchestrator (built on the same hub).
  const orchestrator =
    deps.orchestrator ??
    runOrchestrator({ runsRepo, agentsRepo, runtime: fakeSandboxRuntime(), guard: fakeRunGuard(), hub: runHub, dataConnectionsRepo, googleOAuth: google, modelGateway: gateway, image: "turanga/agent-harness:dev", sandboxVolume: "guard-run" });
  app.route("/", runRoutes(runsRepo, orchestrator, runHub, deps.guardCallbackToken ?? "dev-guard-callback"));

  return app;
}
