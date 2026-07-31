import { describe, it, expect } from "vitest";
import { createApp } from "../app.js";
import { memoryAuthRepo } from "./repo.js";
import { hashPassword, verifyPassword } from "./password.js";
import { ulid } from "@turanga/domain";

const EMAIL = "admin@turanga.local";
const PW = "correct horse battery staple";

async function appWithUser() {
  const repo = memoryAuthRepo();
  await repo.createUser({ id: ulid(1), email: EMAIL, passwordHash: await hashPassword(PW) });
  return createApp({ authRepo: repo });
}

function sessionCookie(res: Response): string {
  const raw = res.headers.get("set-cookie") ?? "";
  return raw.split(";")[0]; // "session=<token>"
}

const jsonPost = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("password", () => {
  it("hashes (not plaintext) and verifies round-trip", async () => {
    const h = await hashPassword(PW);
    expect(h).not.toContain(PW);
    expect(h.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(h, PW)).toBe(true);
    expect(await verifyPassword(h, "wrong")).toBe(false);
  });
});

describe("auth routes", () => {
  it("rejects a wrong password with a generic 401", async () => {
    const app = await appWithUser();
    const res = await app.request("/auth/login", jsonPost({ email: EMAIL, password: "nope" }));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("Email or password is incorrect.");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("returns the same generic 401 for an unknown email (no enumeration)", async () => {
    const app = await appWithUser();
    const res = await app.request("/auth/login", jsonPost({ email: "ghost@x.local", password: PW }));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("Email or password is incorrect.");
  });

  it("normalizes email case/whitespace on login", async () => {
    const app = await appWithUser();
    const res = await app.request("/auth/login", jsonPost({ email: "  ADMIN@Turanga.Local ", password: PW }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { email: string }).email).toBe(EMAIL);
  });

  it("logs in with correct credentials and sets a session cookie", async () => {
    const app = await appWithUser();
    const res = await app.request("/auth/login", jsonPost({ email: EMAIL, password: PW }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { email: string }).email).toBe(EMAIL);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^session=/);
    expect(setCookie.toLowerCase()).toContain("httponly");
    expect(setCookie).toMatch(/samesite=lax/i);
  });

  it("/auth/me is 401 without a cookie and 200 with a valid session", async () => {
    const app = await appWithUser();
    const noCookie = await app.request("/auth/me");
    expect(noCookie.status).toBe(401);

    const login = await app.request("/auth/login", jsonPost({ email: EMAIL, password: PW }));
    const cookie = sessionCookie(login);
    const me = await app.request("/auth/me", { headers: { cookie } });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { email: string }).email).toBe(EMAIL);
  });

  it("logout invalidates the session", async () => {
    const app = await appWithUser();
    const login = await app.request("/auth/login", jsonPost({ email: EMAIL, password: PW }));
    const cookie = sessionCookie(login);
    await app.request("/auth/logout", { method: "POST", headers: { cookie } });
    const me = await app.request("/auth/me", { headers: { cookie } });
    expect(me.status).toBe(401);
  });
});
