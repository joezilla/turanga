import { describe, it, expect, beforeAll } from "vitest";
import { createApp } from "../app.js";
import { memoryAuthRepo, type AuthRepo } from "../auth/repo.js";
import { memoryDataConnectionsRepo } from "../connections/dataRepo.js";
import { fakeGoogleOAuth } from "./google.js";
import { encryptSecret, decryptSecret } from "../secrets/crypto.js";
import { hashPassword } from "../auth/password.js";
import { ulid } from "@turanga/domain";

beforeAll(() => {
  process.env.TOKEN_ENC_KEY = "test-encryption-key";
});

const EMAIL = "admin@turanga.local";
const PW = "pw-for-tests-123456";
async function seeded(repo: AuthRepo) {
  await repo.createUser({ id: ulid(1), email: EMAIL, passwordHash: await hashPassword(PW) });
}
const jsonPost = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function appWithSession(google = fakeGoogleOAuth({ configured: true, email: "me@gmail.com" })) {
  const authRepo = memoryAuthRepo();
  await seeded(authRepo);
  const dataRepo = memoryDataConnectionsRepo();
  const app = createApp({ authRepo, dataConnectionsRepo: dataRepo, googleOAuth: google });
  const login = await app.request("/auth/login", jsonPost({ email: EMAIL, password: PW }));
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  return { app, cookie, google, dataRepo };
}

describe("crypto", () => {
  it("round-trips and detects tampering", () => {
    const blob = encryptSecret("super-secret-refresh-token");
    expect(blob).not.toContain("super-secret");
    expect(decryptSecret(blob)).toBe("super-secret-refresh-token");
    const tampered = blob.slice(0, -4) + "AAAA";
    expect(() => decryptSecret(tampered)).toThrow();
  });
});

describe("oauth data connections", () => {
  it("guards /connections/data (401 without a session)", async () => {
    const { app } = await appWithSession();
    expect((await app.request("/connections/data")).status).toBe(401);
  });

  it("config reflects whether Google is configured", async () => {
    const { app, cookie } = await appWithSession(fakeGoogleOAuth({ configured: false }));
    const res = await app.request("/connections/config", { headers: { cookie } });
    expect(((await res.json()) as { googleConfigured: boolean }).googleConfigured).toBe(false);
  });

  it("completes the OAuth flow and stores the token encrypted (never returned)", async () => {
    const { app, cookie, dataRepo } = await appWithSession();
    // start → sets oauth_state cookie + redirects to Google
    const start = await app.request("/oauth/google/start", { headers: { cookie } });
    expect(start.status).toBe(302);
    const stateCookie = (start.headers.get("set-cookie") ?? "").split(";")[0]; // oauth_state=<hex>
    const state = stateCookie.split("=")[1];
    expect(start.headers.get("location")).toContain(`state=${state}`);

    // callback with matching state
    const cb = await app.request(`/oauth/google/callback?code=auth-code-xyz&state=${state}`, {
      headers: { cookie: `${cookie}; ${stateCookie}` },
    });
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toContain("/settings/connections");

    // the connection is stored, connected, email set — token encrypted in the row, not in the view
    const rows = await dataRepo.list();
    expect(rows[0].status).toBe("connected");
    expect(rows[0].accountEmail).toBe("me@gmail.com");
    expect(rows[0].encRefreshToken).toBeTruthy();
    expect(decryptSecret(rows[0].encRefreshToken!)).toBe("refresh-auth-code-xyz");

    const list = await app.request("/connections/data", { headers: { cookie } });
    const body = await list.text();
    expect(body).not.toContain("refresh-auth-code-xyz"); // token never leaves control-api
    expect(body).toContain("me@gmail.com");
  });

  it("rejects a state mismatch (CSRF) with 400", async () => {
    const { app, cookie } = await appWithSession();
    const start = await app.request("/oauth/google/start", { headers: { cookie } });
    const stateCookie = (start.headers.get("set-cookie") ?? "").split(";")[0];
    const cb = await app.request(`/oauth/google/callback?code=x&state=WRONG`, { headers: { cookie: `${cookie}; ${stateCookie}` } });
    expect(cb.status).toBe(400);
  });

  it("revokes at Google and deletes on remove", async () => {
    const { app, cookie, google, dataRepo } = await appWithSession();
    const start = await app.request("/oauth/google/start", { headers: { cookie } });
    const stateCookie = (start.headers.get("set-cookie") ?? "").split(";")[0];
    const state = stateCookie.split("=")[1];
    await app.request(`/oauth/google/callback?code=c&state=${state}`, { headers: { cookie: `${cookie}; ${stateCookie}` } });
    const id = (await dataRepo.list())[0].id;
    const del = await app.request(`/connections/data/${id}`, { method: "DELETE", headers: { cookie } });
    expect(del.status).toBe(200);
    expect(google.revoked.length).toBe(1);
    expect(await dataRepo.list()).toEqual([]);
  });
});
