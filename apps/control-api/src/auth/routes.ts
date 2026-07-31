import { Hono } from "hono";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import { ulid } from "@turanga/domain";
import type { AuthRepo } from "./repo.js";
import { verifyPassword } from "./password.js";
import { newToken, hashToken, SESSION_TTL_MS } from "./sessions.js";

const GENERIC = "Email or password is incorrect."; // same for unknown email + bad password (no enumeration)

export function authRoutes(repo: AuthRepo, opts: { secureCookie: boolean }) {
  const app = new Hono();

  app.post("/auth/login", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { email?: unknown; password?: unknown };
    const email = body.email;
    const password = body.password;
    if (typeof email !== "string" || typeof password !== "string") {
      return c.json({ error: GENERIC }, 401);
    }
    const user = await repo.findUserByEmail(email);
    const ok = user ? await verifyPassword(user.passwordHash, password) : false;
    if (!user || !ok) return c.json({ error: GENERIC }, 401);

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
