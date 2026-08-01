import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { AuthRepo } from "./repo.js";
import { hashToken } from "./sessions.js";

// First real server-side auth enforcement (Story 2.1). The Epic 1 client guard is UX only;
// this rejects unauthenticated requests to protected routes regardless of the browser.
export function requireSession(repo: AuthRepo): MiddlewareHandler {
  return async (c, next) => {
    const token = getCookie(c, "session");
    if (!token) return c.json({ error: "unauthenticated" }, 401);
    const su = await repo.findSessionUser(hashToken(token), new Date());
    if (!su) return c.json({ error: "unauthenticated" }, 401);
    await next();
  };
}
