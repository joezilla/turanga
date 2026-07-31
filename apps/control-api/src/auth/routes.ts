import { Hono } from "hono";
import type { Context } from "hono";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import { ulid } from "@turanga/domain";
import type { AuthRepo } from "./repo.js";
import { normalizeEmail } from "./repo.js";
import { verifyPassword, decoyHash } from "./password.js";
import { newToken, hashToken, SESSION_TTL_MS } from "./sessions.js";

const GENERIC = "Email or password is incorrect."; // same for unknown email + bad password (no enumeration)
const MAX_BODY_BYTES = 4096;
const MAX_EMAIL_LEN = 320;
const MAX_PASSWORD_LEN = 1024;

// Basic per-client login throttle: blunts online brute-force and the argon2 CPU/memory
// flood (each attempt costs ~19 MiB). In-memory is fine for a single-instance control plane.
const RL_WINDOW_MS = 60_000;
const RL_MAX = 20;
const attempts = new Map<string, { count: number; resetAt: number }>();

function rateLimited(key: string, now: number): boolean {
  const e = attempts.get(key);
  if (!e || now >= e.resetAt) {
    attempts.set(key, { count: 1, resetAt: now + RL_WINDOW_MS });
    return false;
  }
  e.count += 1;
  return e.count > RL_MAX;
}

function clientKey(c: Context): string {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}

export function authRoutes(repo: AuthRepo, opts: { secureCookie: boolean }) {
  const app = new Hono();

  app.post("/auth/login", async (c) => {
    if (Number(c.req.header("content-length") ?? "0") > MAX_BODY_BYTES) {
      return c.json({ error: GENERIC }, 413);
    }
    if (rateLimited(clientKey(c), Date.now())) {
      return c.json({ error: "Too many attempts. Try again in a minute." }, 429);
    }

    const body = (await c.req.json().catch(() => ({}))) as { email?: unknown; password?: unknown };
    const email = body.email;
    const password = body.password;
    const valid =
      typeof email === "string" &&
      typeof password === "string" &&
      email.length <= MAX_EMAIL_LEN &&
      password.length <= MAX_PASSWORD_LEN;

    // Look up (normalized) + always run exactly one argon2 verify so the unknown-email and
    // bad-password paths take the same time (no user enumeration by timing).
    const user = valid ? await repo.findUserByEmail(normalizeEmail(email as string)) : null;
    const ok = await verifyPassword(user?.passwordHash ?? (await decoyHash()), valid ? (password as string) : "");
    if (!valid || !user || !ok) return c.json({ error: GENERIC }, 401);

    const token = newToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await repo.createSession({ id: ulid(Date.now()), tokenHash: hashToken(token), userId: user.id, expiresAt });
    setCookie(c, "session", token, {
      httpOnly: true,
      sameSite: "Lax",
      secure: opts.secureCookie,
      path: "/",
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });
    return c.json({ email: user.email });
  });

  app.get("/auth/me", async (c) => {
    const token = getCookie(c, "session");
    if (!token) return c.json({ error: "unauthenticated" }, 401);
    const su = await repo.findSessionUser(hashToken(token), new Date());
    if (!su) return c.json({ error: "unauthenticated" }, 401);
    return c.json({ email: su.email });
  });

  app.post("/auth/logout", async (c) => {
    const token = getCookie(c, "session");
    if (token) await repo.deleteSession(hashToken(token));
    deleteCookie(c, "session", { path: "/" });
    return c.json({ ok: true });
  });

  return app;
}
