import { describe, it, expect, vi, afterEach } from "vitest";
import { httpModelGateway } from "./gateway.js";

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
