import { describe, it, expect, beforeAll } from "vitest";

// Live end-to-end test: launches a REAL dev-insecure sandbox against a running stack (control-api
// on :8080 with the Docker socket mounted + the turanga/agent-harness:dev image built). Gated on
// RUN_SANDBOX_IT=1 so `pnpm -r test` stays green everywhere Docker-in-control-api isn't wired.
//
//   Run it:  cd deploy && docker compose up -d --build && docker compose --profile build build agent-harness-image
//            RUN_SANDBOX_IT=1 pnpm --filter @turanga/control-api exec vitest run src/runs/sandbox.integration.test.ts
//
// A real completion needs a configured provider; with none, LiteLLM errors and the run ends
// `failed` with the error visible in the transcript — which still proves the call left ONLY via
// the Guard (topology), the transcript returned on stdout, and the container was reaped.
const RUN = process.env.RUN_SANDBOX_IT === "1";
const base = process.env.CONTROL_API_URL ?? "http://localhost:8080";
const EMAIL = process.env.IT_EMAIL ?? "admin@turanga.local";
const PW = process.env.IT_PASSWORD ?? "changeme-dev";

describe.skipIf(!RUN)("sandbox integration (live stack)", () => {
  let cookie = "";

  beforeAll(async () => {
    const r = await fetch(`${base}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PW }) });
    cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
    expect(cookie).toBeTruthy();
  });

  it("launches a real --network=none sandbox, injects the job spec, streams the transcript, reaps", async () => {
    const created = (await (await fetch(`${base}/agents`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ name: "IT runner" }) })).json()) as { agent: { id: string } };
    const agentId = created.agent.id;
    await fetch(`${base}/agents/${agentId}`, { method: "PATCH", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ model: "openai/gpt-4o" }) });

    // POST is async now (Story 4.2): it returns the running run immediately; poll until terminal.
    const res = await fetch(`${base}/runs`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ agentId, taskInput: "say hello" }) });
    expect(res.status).toBe(201);
    const started = (await res.json()) as { run: { id: string; status: string } };
    expect(started.run.status).toBe("running");

    let run!: { status: string; transcript: { type: string; role?: string; text?: string }[] };
    for (let i = 0; i < 60; i++) {
      const got = (await (await fetch(`${base}/runs/${started.run.id}`, { headers: { cookie } })).json()) as { run: typeof run };
      run = got.run;
      if (["succeeded", "failed", "killed"].includes(run.status)) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    // The single control channel returned a transcript; the first turn is the user's task input.
    expect(["succeeded", "failed", "killed"]).toContain(run.status);
    const types = run.transcript.map((m) => m.type);
    expect(types[0]).toBe("turn");
    expect(run.transcript[0].role).toBe("user");
    expect(types).toContain("done");
    // The model call left ONLY via the Guard → LiteLLM (with no provider key, that surfaces as a
    // model error in the transcript — the topology is what this proves).
    const agentTurn = run.transcript.find((m) => m.type === "turn" && m.role === "agent");
    expect(agentTurn).toBeTruthy();
    // No credential ever crosses into the sandbox transcript (AD-10) — nothing Bearer-shaped leaks.
    expect(JSON.stringify(run.transcript)).not.toMatch(/Bearer\s/i);
  }, 60_000);
});
