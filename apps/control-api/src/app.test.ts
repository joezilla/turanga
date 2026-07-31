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
});
