import { describe, it, expect } from "vitest";
import { createApp } from "./app.js";

describe("egress-guard", () => {
  it("GET /health -> { ok: true }", async () => {
    const res = await createApp().request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
