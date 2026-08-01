import { Hono } from "hono";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import { randomBytes } from "node:crypto";
import { ulid } from "@turanga/domain";
import type { DataConnectionsRepo, DataConnRow } from "../connections/dataRepo.js";
import { type GoogleOAuth, GMAIL_DESTINATIONS } from "./google.js";
import { encryptSecret, decryptSecret } from "../secrets/crypto.js";

// Public view — NEVER includes enc_refresh_token.
function view(r: DataConnRow) {
  return {
    id: r.id,
    provider: r.provider,
    name: r.name,
    accountEmail: r.accountEmail,
    scopes: r.scopes,
    destinations: r.destinations,
    status: r.status,
    lastError: r.lastError,
  };
}

export function dataConnectionRoutes(repo: DataConnectionsRepo, google: GoogleOAuth, webOrigin: string) {
  const app = new Hono();

  app.get("/connections/config", (c) => c.json({ googleConfigured: google.isConfigured() }));

  app.get("/connections/data", async (c) => c.json({ connections: (await repo.list()).map(view) }));

  app.delete("/connections/data/:id", async (c) => {
    const id = c.req.param("id");
    const row = await repo.get(id);
    if (!row) return c.json({ error: "Not found." }, 404);
    if (row.encRefreshToken) {
      try {
        await google.revoke(decryptSecret(row.encRefreshToken));
      } catch {
        /* best-effort revoke */
      }
    }
    await repo.delete(id);
    return c.json({ ok: true });
  });

  app.get("/oauth/google/start", (c) => {
    if (!google.isConfigured()) return c.json({ error: "Google OAuth isn't configured." }, 503);
    const state = randomBytes(16).toString("hex");
    setCookie(c, "oauth_state", state, { httpOnly: true, sameSite: "Lax", path: "/", maxAge: 600 });
    return c.redirect(google.authUrl(state));
  });

  app.get("/oauth/google/callback", async (c) => {
    const errParam = c.req.query("error");
    if (errParam) return c.redirect(`${webOrigin}/settings/connections?error=${encodeURIComponent(errParam)}`);
    const state = c.req.query("state");
    const cookieState = getCookie(c, "oauth_state");
    if (!state || !cookieState || state !== cookieState) return c.json({ error: "Invalid state." }, 400);
    deleteCookie(c, "oauth_state", { path: "/" });
    const code = c.req.query("code");
    if (!code) return c.json({ error: "Missing authorization code." }, 400);

    const base: Omit<DataConnRow, "status" | "lastError" | "encRefreshToken" | "accountEmail" | "scopes"> = {
      id: ulid(Date.now()),
      provider: "gmail",
      name: "Gmail",
      destinations: GMAIL_DESTINATIONS,
    };
    try {
      const { refreshToken, email, scopes } = await google.exchange(code);
      if (!refreshToken) {
        await repo.upsertGmail({ ...base, accountEmail: email || null, scopes, status: "error", lastError: "No refresh token returned — remove and reconnect (consent required).", encRefreshToken: null });
      } else {
        await repo.upsertGmail({ ...base, accountEmail: email || null, scopes, status: "connected", lastError: null, encRefreshToken: encryptSecret(refreshToken) });
      }
    } catch {
      await repo.upsertGmail({ ...base, accountEmail: null, scopes: [], status: "error", lastError: "Couldn't complete Google sign-in. Try again.", encRefreshToken: null });
    }
    return c.redirect(`${webOrigin}/settings/connections`);
  });

  return app;
}
