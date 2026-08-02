import { describe, it, expect } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGuard } from "./guard.js";
import type { GuardModelResponse } from "@turanga/contracts";

const okFetch = (async () =>
  new Response(JSON.stringify({ choices: [{ message: { content: "hello from the model" } }], usage: { total_tokens: 12 } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;

const errFetch = (async () =>
  new Response(JSON.stringify({ error: { message: "no key configured (401)" } }), { status: 401, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

describe("guard model proxy", () => {
  it("maps a model request to a LiteLLM call and returns the completion", async () => {
    const guard = createGuard({ socketDir: "/tmp", litellmBaseUrl: "http://litellm:4000", litellmMasterKey: "sk", fetchImpl: okFetch });
    const res = await guard.proxyModel({ v: 1, runId: "r", model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }] });
    expect(res.ok).toBe(true);
    expect(res.text).toBe("hello from the model");
    expect(res.tokens).toBe(12);
  });

  it("surfaces a provider error (no fallback)", async () => {
    const guard = createGuard({ socketDir: "/tmp", litellmBaseUrl: "http://litellm:4000", litellmMasterKey: "sk", fetchImpl: errFetch });
    const res = await guard.proxyModel({ v: 1, runId: "r", model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }] });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/401/);
  });
});

const RUN = "01ARZ3NDEKTSV4RRFFQ69G5FAV"; // a valid ULID

describe("guard per-run socket lifecycle", () => {
  it("rejects a non-ULID runId (no path traversal)", async () => {
    const guard = createGuard({ socketDir: "/tmp", litellmBaseUrl: "http://x", litellmMasterKey: "sk", fetchImpl: okFetch });
    await expect(guard.register("../../etc/x")).rejects.toThrow(/invalid/i);
  });

  it("register provisions a UDS in the run's own subdir that serves the model contract; teardown removes it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-"));
    const guard = createGuard({ socketDir: dir, litellmBaseUrl: "http://litellm:4000", litellmMasterKey: "sk", fetchImpl: okFetch });
    const { socketPath } = await guard.register(RUN);
    expect(fs.existsSync(socketPath)).toBe(true);
    expect(socketPath).toContain(`${RUN}/run.sock`); // per-run subdir (isolation)
    expect(guard.activeRuns()).toEqual([RUN]);

    // A harness-style HTTP-over-UDS call resolves through the socket.
    const body = JSON.stringify({ v: 1, runId: RUN, model: "m", messages: [{ role: "user", content: "hi" }] });
    const out = await new Promise<GuardModelResponse>((resolve) => {
      const req = http.request({ socketPath, path: "/", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => resolve(JSON.parse(raw)));
      });
      req.end(body);
    });
    expect(out.ok).toBe(true);
    expect(out.text).toBe("hello from the model");

    await guard.teardown(RUN);
    expect(fs.existsSync(socketPath)).toBe(false);
    expect(guard.activeRuns()).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
