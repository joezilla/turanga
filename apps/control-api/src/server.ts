import { serve } from "@hono/node-server";
import { ulid } from "@turanga/domain";
import { createApp } from "./app.js";
import { createDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { drizzleAuthRepo, type AuthRepo } from "./auth/repo.js";
import { hashPassword } from "./auth/password.js";

const port = Number(process.env.PORT ?? 8080);

async function seedInitialUser(repo: AuthRepo): Promise<void> {
  if ((await repo.userCount()) > 0) return;
  const email = process.env.INITIAL_ADMIN_EMAIL;
  const password = process.env.INITIAL_ADMIN_PASSWORD;
  if (!email || !password) return;
  await repo.createUser({ id: ulid(Date.now()), email, passwordHash: await hashPassword(password) });
  console.log(`[control-api] seeded initial user ${email}`);
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");

  const { db } = createDb(url);
  await runMigrations(db);
  const authRepo = drizzleAuthRepo(db);
  await seedInitialUser(authRepo);

  const app = createApp({ authRepo, secureCookie: process.env.NODE_ENV === "production" });
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`[control-api] listening on :${info.port}`);
  });
}

main().catch((err) => {
  console.error("[control-api] failed to start:", err);
  process.exit(1);
});
