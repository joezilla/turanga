// Client-side auth helpers. The control-api is the auth authority; these drive the
// session cookie (credentials: 'include' — same-site localhost, SameSite=Lax).
const base = import.meta.env.VITE_CONTROL_API_URL ?? "http://localhost:8080";

export interface Me {
  email: string;
}

// Discriminated so callers can tell "not logged in" (401) from "can't reach the control
// plane" (network/5xx) — the guard must NOT log a valid user out over a transient blip.
export type MeResult = { status: "authed"; email: string } | { status: "unauthed" } | { status: "error" };

export async function me(): Promise<MeResult> {
  try {
    const r = await fetch(`${base}/auth/me`, { credentials: "include" });
    if (r.ok) return { status: "authed", email: ((await r.json()) as Me).email };
    if (r.status === 401) return { status: "unauthed" };
    return { status: "error" };
  } catch {
    return { status: "error" };
  }
}

export type LoginResult = "ok" | "invalid" | "error";

export async function login(email: string, password: string): Promise<LoginResult> {
  try {
    const r = await fetch(`${base}/auth/login`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (r.ok) return "ok";
    if (r.status === 401 || r.status === 429) return "invalid";
    return "error";
  } catch {
    return "error";
  }
}

export async function logout(): Promise<void> {
  try {
    await fetch(`${base}/auth/logout`, { method: "POST", credentials: "include" });
  } catch {
    /* ignore — cookie clears server-side or expires */
  }
}
