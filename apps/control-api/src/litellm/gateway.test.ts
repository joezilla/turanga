import { describe, it, expect, vi, afterEach } from "vitest";
import { httpModelGateway, fakeModelGateway, fakeEmbed } from "./gateway.js";

// Capture LiteLLM admin calls by stubbing global fetch. The gateway uses the master key bearer.
function stub(handler: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; body: unknown; auth: string | undefined }[] = [];
  vi.stubGlobal("fetch", (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: headers.authorization });
    return handler(String(url), init);
  }) as unknown as typeof fetch);
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

const gw = () => httpModelGateway("http://litellm:4000", "sk-master");

describe("litellm gateway — cost keys (Story 4.5)", () => {
  it("ensureAgentTeam creates a daily-resetting team (per-day cap in USD) when none exists", async () => {
    const calls = stub((url) => {
      if (url.endsWith("/team/list")) return new Response("[]", { status: 200 });
      return new Response(JSON.stringify({ team_id: "team-xyz" }), { status: 200 });
    });
    const teamId = await gw().ensureAgentTeam("a1", { minor: 500, currency: "USD" }); // $5.00/day
    expect(teamId).toBe("team-xyz");
    const create = calls.find((c) => c.url.endsWith("/team/new"))!;
    expect((create.body as { team_alias: string }).team_alias).toBe("agent-a1");
    expect((create.body as { max_budget: number }).max_budget).toBe(5); // cents → dollars
    expect((create.body as { budget_duration: string }).budget_duration).toBe("1d");
    expect(create.auth).toBe("Bearer sk-master");
  });

  it("ensureAgentTeam serializes concurrent calls for one agent — exactly one team is created (no cap-splitting race)", async () => {
    let created = 0;
    const calls = stub((url) => {
      if (url.endsWith("/team/list")) return new Response(JSON.stringify(created === 0 ? [] : [{ team_id: "team-1", team_alias: "agent-a1" }]), { status: 200 });
      if (url.endsWith("/team/new")) { created++; return new Response(JSON.stringify({ team_id: "team-1" }), { status: 200 }); }
      return new Response("{}", { status: 200 });
    });
    const g = gw();
    const [t1, t2] = await Promise.all([g.ensureAgentTeam("a1", null), g.ensureAgentTeam("a1", null)]);
    expect(t1).toBe("team-1");
    expect(t2).toBe("team-1");
    expect(calls.filter((c) => c.url.endsWith("/team/new"))).toHaveLength(1); // serialized → not two teams
  });

  it("ensureAgentTeam reuses an existing team (idempotent by alias) and refreshes its budget", async () => {
    const calls = stub((url) => {
      if (url.endsWith("/team/list")) return new Response(JSON.stringify([{ team_id: "team-old", team_alias: "agent-a1" }]), { status: 200 });
      return new Response("{}", { status: 200 });
    });
    const teamId = await gw().ensureAgentTeam("a1", { minor: 1000, currency: "USD" });
    expect(teamId).toBe("team-old");
    expect(calls.some((c) => c.url.endsWith("/team/update"))).toBe(true);
    expect(calls.some((c) => c.url.endsWith("/team/new"))).toBe(false);
  });

  it("mintRunKey generates a key under the team with the per-run cap + a TTL", async () => {
    const calls = stub(() => new Response(JSON.stringify({ key: "sk-run-abc" }), { status: 200 }));
    const key = await gw().mintRunKey({ teamId: "team-xyz", perRunCap: { minor: 50, currency: "USD" }, runId: "R1" });
    expect(key).toBe("sk-run-abc");
    const body = calls[0].body as { team_id: string; max_budget: number; key_alias: string; duration: string };
    expect(body.team_id).toBe("team-xyz");
    expect(body.max_budget).toBe(0.5); // $0.50
    expect(body.key_alias).toBe("run-R1");
    expect(body.duration).toBe("2h");
  });

  it("mintRunKey omits max_budget when the per-run cap is null (metering only, no hard cap)", async () => {
    const calls = stub(() => new Response(JSON.stringify({ key: "sk-run-uncapped" }), { status: 200 }));
    await gw().mintRunKey({ teamId: "team-xyz", perRunCap: null, runId: "R2" });
    expect((calls[0].body as Record<string, unknown>).max_budget).toBeUndefined();
  });

  it("deleteKey posts the key to /key/delete", async () => {
    const calls = stub(() => new Response("{}", { status: 200 }));
    await gw().deleteKey("sk-run-abc");
    expect(calls[0].url).toContain("/key/delete");
    expect((calls[0].body as { keys: string[] }).keys).toEqual(["sk-run-abc"]);
  });

  it("teamSpendMicros reads team spend (USD) → micro-USD", async () => {
    stub(() => new Response(JSON.stringify({ team_info: { spend: 0.0413 } }), { status: 200 }));
    expect(await gw().teamSpendMicros("team-xyz")).toBe(41300);
  });
});

describe("litellm gateway — model registration", () => {
  it("registers openai/anthropic as wildcards", async () => {
    const calls = stub(() => new Response(JSON.stringify({ model_info: { id: "m1" } }), { status: 200 }));
    await gw().register({ provider: "openai", name: "OpenAI", apiKey: "sk-x" });
    expect((calls[0].body as { model_name: string }).model_name).toBe("openai/*");
  });

  it("registers an openai-compatible model under the KIND prefix so the agent's model resolves (2.4 fix)", async () => {
    // A local server that advertises the model file path as its id (leading slash) — the case that broke.
    const calls = stub((url) => (url.endsWith("/model/new") ? new Response(JSON.stringify({ model_info: { id: "m1" } }), { status: 200 }) : new Response("{}", { status: 200 })));
    const ids = await gw().register({ provider: "openai-compatible", name: "My Local Box", apiKey: "sk-x", baseUrl: "http://host:8080/v1", models: ["/models/gpt-oss-20b-MXFP4.gguf"] });
    expect(ids).toEqual(["m1"]);
    const add = calls.find((c) => c.url.endsWith("/model/new"))!;
    const body = add.body as { model_name: string; litellm_params: { model: string; api_base: string } };
    // model_name is `openai-compatible/<id>` (matches ModelSelector's `<kind>/<id>`), NOT `<name>/<id>`.
    expect(body.model_name).toBe("openai-compatible//models/gpt-oss-20b-MXFP4.gguf");
    expect(body.model_name).not.toContain("My Local Box");
    // litellm_params calls the upstream via the openai provider + the base URL with the raw id.
    expect(body.litellm_params.model).toBe("openai//models/gpt-oss-20b-MXFP4.gguf");
    expect(body.litellm_params.api_base).toBe("http://host:8080/v1");
  });
});

describe("litellm gateway — embeddings (Story 8.3, recall)", () => {
  it("httpModelGateway.embed POSTs to /embeddings with the master key + { model, input } and returns data[0].embedding", async () => {
    const vec = [0.1, 0.2, 0.3];
    const calls = stub((url) =>
      url.endsWith("/embeddings")
        ? new Response(JSON.stringify({ data: [{ embedding: vec }] }), { status: 200 })
        : new Response("nope", { status: 404 }),
    );
    const out = await gw().embed("some task input");
    expect(out).toEqual(vec);
    const call = calls.find((c) => c.url.endsWith("/embeddings"))!;
    expect(call.auth).toBe("Bearer sk-master"); // master key — unmetered, off the cost cap
    expect(call.body).toMatchObject({ model: "text-embedding-3-small", input: "some task input" });
  });

  it("embed throws on a non-ok response or a malformed body (so recall can fail-open)", async () => {
    stub(() => new Response("boom", { status: 500 }));
    await expect(gw().embed("x")).rejects.toThrow();
    vi.unstubAllGlobals();
    stub(() => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    await expect(gw().embed("x")).rejects.toThrow();
  });

  it("fakeModelGateway.embed is deterministic (1536-dim; same text → same vector) and records calls", async () => {
    const g = fakeModelGateway();
    const a = await g.embed("hello");
    const b = await g.embed("hello");
    const c = await g.embed("world");
    expect(a).toHaveLength(1536);
    expect(a).toEqual(b); // deterministic
    expect(a).not.toEqual(c); // different text diverges
    expect(g.embedded).toEqual(["hello", "hello", "world"]);
    expect(fakeEmbed("hello")).toEqual(a); // the exported helper matches
  });
});
