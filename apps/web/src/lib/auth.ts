// Client-side auth helpers. The control-api is the auth authority; these just drive
// the session cookie (credentials: 'include' — same-site localhost, SameSite=Lax).
const base = import.meta.env.VITE_CONTROL_API_URL ?? "http://localhost:8080";

export interface Me {
  email: string;
}

export async function me(): Promise<Me | null> {
  try {
    const r = await fetch(`${base}/auth/me`, { credentials: "include" });
    return r.ok ? ((await r.json()) as Me) : null;
  } catch {
    return null;
  }
}

export async function login(email: string, password: string): Promise<boolean> {
  const r = await fetch(`${base}/auth/login`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return r.ok;
}

export async function logout(): Promise<void> {
  try {
    await fetch(`${base}/auth/logout`, { method: "POST", credentials: "include" });
  } catch {
    /* ignore — cookie will be cleared server-side or expire */
  }
}
