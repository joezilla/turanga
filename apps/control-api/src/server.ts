import { serve } from "@hono/node-server";
import { ulid } from "@turanga/domain";
import { createApp } from "./app.js";
import { createDb } from "./db/client.js";
import { ensureDatabase } from "./db/ensure.js";
import { runMigrations } from "./db/migrate.js";
import { drizzleAuthRepo, normalizeEmail, type AuthRepo } from "./auth/repo.js";
import { hashPassword } from "./auth/password.js";
import { drizzleConnectionsRepo } from "./connections/repo.js";
import { httpModelGateway } from "./litellm/gateway.js";
import { drizzleDataConnectionsRepo } from "./connections/dataRepo.js";
import { googleOAuth } from "./oauth/google.js";
import { drizzleAgentsRepo } from "./agents/repo.js";
import { drizzleRunsRepo } from "./runs/repo.js";
import { runOrchestrator } from "./runs/orchestrator.js";
import { dockerRuntime, resolveSandboxRuntimeKind } from "./runs/runtime.js";
import { httpRunGuard } from "./runs/guardClient.js";
import { createRunHub } from "./runs/hub.js";

const port = Number(process.env.PORT ?? 8080);
const SESSION_SWEEP_MS = 1000 * 60 * 60; // reap expired sessions hourly

async function seedInitialUser(repo: AuthRepo): Promise<void> {
  if ((await repo.userCount()) > 0) return;
  const email = process.env.INITIAL_ADMIN_EMAIL;
  const password = process.env.INITIAL_ADMIN_PASSWORD;
  if (!email || !password) {
    if (email || password) {
      console.warn("[control-api] INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD must BOTH be set to seed a user — skipping.");
    }
    return;
  }
  if (password === "changeme-dev") {
    console.warn("[control-api] seeding with the sample password 'changeme-dev' — change INITIAL_ADMIN_PASSWORD before any real use.");
  }
  await repo.createUser({ id: ulid(Date.now()), email: normalizeEmail(email), passwordHash: await hashPassword(password) });
  console.log(`[control-api] seeded initial user ${normalizeEmail(email)}`);
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");

  await ensureDatabase(url);
  const { db } = createDb(url);
  await runMigrations(db);
  const authRepo = drizzleAuthRepo(db);
  await seedInitialUser(authRepo);

  // Reap expired sessions at startup and on an interval (bounded sessions table).
  const sweep = () => authRepo.deleteExpiredSessions(new Date()).catch((e) => console.error("[control-api] session sweep failed:", e));
  await sweep();
  setInterval(sweep, SESSION_SWEEP_MS).unref();

  const connectionsRepo = drizzleConnectionsRepo(db);
  const litellmBaseUrl = process.env.LITELLM_BASE_URL ?? "http://litellm:4000";
  const litellmMasterKey = process.env.LITELLM_MASTER_KEY ?? "sk-turanga-dev";
  const modelGateway = httpModelGateway(litellmBaseUrl, litellmMasterKey);
  const dataConnectionsRepo = drizzleDataConnectionsRepo(db);
  const google = googleOAuth();
  const agentsRepo = drizzleAgentsRepo(db);

  // Run-orchestrator wiring (Epic 4). Runtime kind is explicit (fail-closed; dev-insecure refused
  // in production). The Docker socket is available only here (control plane), never a sandbox.
  const runsRepo = drizzleRunsRepo(db);
  const runtimeKind = resolveSandboxRuntimeKind();
  const runtime = dockerRuntime(runtimeKind);
  const guard = httpRunGuard(process.env.GUARD_ADMIN_URL ?? "http://egress-guard:8081", process.env.GUARD_ADMIN_TOKEN ?? "dev-guard-admin");
  const runHub = createRunHub();
  const orchestrator = runOrchestrator({
    runsRepo,
    agentsRepo,
    runtime,
    guard,
    hub: runHub,
    dataConnectionsRepo, // Story 4.3 — resolve the run's Gmail connection + allowlist
    googleOAuth: google, // Story 4.3 — mint the short-lived access token handed to the Guard
    modelGateway, // Story 4.5 — mint the per-run cost key under the agent's daily-budget team
    image: process.env.AGENT_HARNESS_IMAGE ?? "turanga/agent-harness:dev",
    sandboxVolume: process.env.GUARD_SANDBOX_VOLUME ?? "turanga_guard-run",
  });
  console.log(`[control-api] sandbox runtime: ${runtimeKind}`);

  const app = createApp({
    authRepo,
    secureCookie: process.env.COOKIE_SECURE === "true",
    connectionsRepo,
    modelGateway,
    dataConnectionsRepo,
    googleOAuth: google,
    agentsRepo,
    runsRepo,
    runHub,
    orchestrator,
    guardCallbackToken: process.env.GUARD_CALLBACK_TOKEN ?? "dev-guard-callback",
  });
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`[control-api] listening on :${info.port}`);
  });
}

main().catch((err) => {
  console.error("[control-api] failed to start:", err);
  process.exit(1);
});
