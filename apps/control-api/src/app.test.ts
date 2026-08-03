import { describe, it, expect } from "vitest";
import { createApp } from "./app.js";

describe("control-api", () => {
  const app = createApp();
  it("GET /health -> { ok: true }", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
  it("GET /version returns a version string", async () => {
    const res = await app.request("/version");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: string };
    expect(typeof body.version).toBe("string");
  });

  it("the Guard callback route rejects a bad token (constant-time) and is NOT web-session-guarded", async () => {
    const app2 = createApp({ guardCallbackToken: "secret-cb" });
    const event = JSON.stringify({ type: "metrics", v: 4, latencyMs: 1, tokens: 1, costMicros: 1 });
    // No token → 403 (not 401/redirect — it's control-plane, token-authenticated, not session).
    const bad = await app2.request("/internal/guard/runs/R1/events", { method: "POST", headers: { "content-type": "application/json" }, body: event });
    expect(bad.status).toBe(403);
    // Correct token → 200 (an event for an unknown run is a harmless no-op).
    const ok = await app2.request("/internal/guard/runs/R1/events", { method: "POST", headers: { "content-type": "application/json", "x-guard-callback": "secret-cb" }, body: event });
    expect(ok.status).toBe(200);
  });

  it("GET /agents/cost (agents-list daily meter, Story 5.2) is session-guarded via /agents/*", async () => {
    // No session cookie → 401 (it sits under the same requireSession as the rest of /agents/*).
    const res = await app.request("/agents/cost");
    expect(res.status).toBe(401);
  });
});
