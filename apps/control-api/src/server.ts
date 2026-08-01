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

  const app = createApp({ authRepo, secureCookie: process.env.COOKIE_SECURE === "true", connectionsRepo, modelGateway });
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`[control-api] listening on :${info.port}`);
  });
}

main().catch((err) => {
  console.error("[control-api] failed to start:", err);
  process.exit(1);
});
