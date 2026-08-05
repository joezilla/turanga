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
import { toolRoutes } from "./tools/routes.js";
import { memoryToolsRepo, type ToolsRepo } from "./tools/repo.js";
import { memoryMemoryRepo, type MemoryRepo } from "./memory/repo.js";
import { fakeReflector, type Reflector } from "./memory/reflector.js";
import { memoryRoutes } from "./memory/routes.js";
import { fakeMcpVerifier, type McpVerifier } from "./tools/mcp.js";
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
  toolsRepo?: ToolsRepo; // Epic 6 (Story 6.1) — first-class tools
  memoryRepo?: MemoryRepo; // Epic 8 (Story 8.1) — agent memory store + config (recall/reflect consume it in 8.3/8.4)
  reflector?: Reflector; // Epic 8 (Story 8.4) — post-run transcript distillation; defaults to a fake (tests / no-model boot)
  mcpVerifier?: McpVerifier; // Epic 6 (Story 6.2) — connect-time MCP handshake; defaults to a fake (tests / no-network boot)
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
  app.use("/tools", requireSession(authRepo));
  app.use("/tools/*", requireSession(authRepo));
  app.use("/memory", requireSession(authRepo));
  app.use("/memory/*", requireSession(authRepo));
  const agentsRepo = deps.agentsRepo ?? memoryAgentsRepo();
  const connectionsRepo = deps.connectionsRepo ?? memoryConnectionsRepo();
  const gateway = deps.modelGateway ?? fakeModelGateway();
  app.route("/", connectionRoutes(connectionsRepo, gateway, agentsRepo)); // agentsRepo → dependents guard (3.6)

  const dataConnectionsRepo = deps.dataConnectionsRepo ?? memoryDataConnectionsRepo();
  const google = deps.googleOAuth ?? googleOAuth();
  app.route("/", dataConnectionRoutes(dataConnectionsRepo, google, webOrigin));

  const toolsRepo = deps.toolsRepo ?? memoryToolsRepo();
  const memoryRepo = deps.memoryRepo ?? memoryMemoryRepo(); // Story 8.1 — the store; recall/reflect wire in via the orchestrator (8.3/8.4)
  const reflector = deps.reflector ?? fakeReflector(); // Story 8.4 — post-run distillation (fake by default)
  app.route("/", agentRoutes(agentsRepo, connectionsRepo, toolsRepo)); // connectionsRepo → the Activate gate (5.1); toolsRepo → per-op grant validation (6.3)

  const mcpVerifier = deps.mcpVerifier ?? fakeMcpVerifier();
  app.route("/", toolRoutes(toolsRepo, mcpVerifier)); // Epic 6 — manage + connect first-class tools
  app.route("/", memoryRoutes(memoryRepo, gateway)); // Epic 8 — memory settings/purge (8.2) + list/edit/forget (8.5); gateway re-embeds on edit

  const runsRepo = deps.runsRepo ?? memoryRunsRepo();
  // The hub is the live SSE relay; the orchestrator and the routes MUST share one instance.
  const runHub = deps.runHub ?? createRunHub();
  // Default orchestrator uses a fake runtime + fake guard so the app boots + tests run without
  // Docker; server.ts injects the real Docker-backed orchestrator (built on the same hub).
  const orchestrator =
    deps.orchestrator ??
    runOrchestrator({ runsRepo, agentsRepo, runtime: fakeSandboxRuntime(), guard: fakeRunGuard(), hub: runHub, dataConnectionsRepo, toolsRepo, memoryRepo, reflector, googleOAuth: google, modelGateway: gateway, image: "turanga/agent-harness:dev", sandboxVolume: "guard-run" });
  app.route("/", runRoutes(runsRepo, orchestrator, runHub, deps.guardCallbackToken ?? "dev-guard-callback"));

  return app;
}
