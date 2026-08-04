import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { AuthRepo } from "./repo.js";
import { hashToken } from "./sessions.js";

/** Context variables the guard publishes to downstream handlers. */
export interface SessionVars {
  sessionEmail: string;
}

// First real server-side auth enforcement (Story 2.1). The Epic 1 client guard is UX only;
// this rejects unauthenticated requests to protected routes regardless of the browser.
// It also stashes the session's email so handlers can attribute writes (e.g. who published).
export function requireSession(repo: AuthRepo): MiddlewareHandler<{ Variables: SessionVars }> {
  return async (c, next) => {
    const token = getCookie(c, "session");
    if (!token) return c.json({ error: "unauthenticated" }, 401);
    const su = await repo.findSessionUser(hashToken(token), new Date());
    if (!su) return c.json({ error: "unauthenticated" }, 401);
    c.set("sessionEmail", su.email);
    await next();
  };
}
