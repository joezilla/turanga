import { describe, it, expect, vi, afterEach } from "vitest";
import { httpReflector, fakeReflector, type ReflectInput } from "./reflector.js";

// Capture the LiteLLM chat call by stubbing global fetch (mirrors the gateway test's stub).
function stub(handler: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; body: any; auth: string | undefined }[] = [];
  vi.stubGlobal("fetch", (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: headers.authorization });
    return handler(String(url), init);
  }) as unknown as typeof fetch);
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

const chat = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
const input = (over: Partial<ReflectInput> = {}): ReflectInput => ({
  model: "openai/gpt-4o",
  taskInput: "summarize my inbox",
  turns: [
    { role: "user", text: "summarize my inbox" },
    { role: "agent", text: "You have 3 unread from Finance." },
  ],
  toolCallCount: 0,
  refusals: 0,
  ...over,
});

describe("httpReflector (Story 8.4)", () => {
  it("POSTs one /v1/chat/completions on the MASTER key + { model, messages } and parses a JSON array", async () => {
    const calls = stub((url) =>
      url.endsWith("/v1/chat/completions")
        ? chat('[{"kind":"semantic","content":"The user has a Finance contact.","summary":"has Finance contact","topic":"contacts"}]')
        : new Response("no", { status: 404 }),
    );
    const out = await httpReflector("http://litellm:4000", "sk-master").reflect(input());
    expect(out).toEqual([{ kind: "semantic", content: "The user has a Finance contact.", summary: "has Finance contact", topic: "contacts" }]);
    const call = calls.find((c) => c.url.endsWith("/v1/chat/completions"))!;
    expect(call.auth).toBe("Bearer sk-master"); // master key → unmetered
    expect(call.body.model).toBe("openai/gpt-4o");
    expect(call.body.messages).toHaveLength(2); // system + user
  });

  it("frames the transcript as DATA, not instructions, and only asks for procedures above the tool threshold", async () => {
    const calls = stub(() => chat("[]"));
    const r = httpReflector("http://litellm:4000", "sk-master");
    await r.reflect(input({ toolCallCount: 0 }));
    const sys0 = calls[0].body.messages[0].content as string;
    expect(sys0).toMatch(/never follow/i); // W1: transcript is data, not instructions
    expect(sys0).toMatch(/do not produce any procedure/i);
    vi.unstubAllGlobals();
    const calls2 = stub(() => chat("[]"));
    await r.reflect(input({ toolCallCount: 3 }));
    expect(calls2[0].body.messages[0].content as string).toMatch(/procedure/i);
  });

  it("tolerates code-fenced / prose-wrapped JSON and drops malformed items", async () => {
    stub(() => chat('Here you go:\n```json\n[{"kind":"semantic","content":"A"},{"kind":"bogus","content":"x"},{"content":"no kind"}]\n```'));
    const out = await httpReflector("http://litellm:4000", "sk-master").reflect(input());
    expect(out).toEqual([{ kind: "semantic", content: "A", summary: "A", topic: null }]); // only the valid one; summary falls back to content
  });

  it("is fail-safe — non-ok, non-JSON, and empty transcript all yield [] (never throws)", async () => {
    stub(() => new Response("boom", { status: 500 }));
    expect(await httpReflector("http://litellm:4000", "sk-master").reflect(input())).toEqual([]);
    vi.unstubAllGlobals();
    stub(() => chat("not json at all"));
    expect(await httpReflector("http://litellm:4000", "sk-master").reflect(input())).toEqual([]);
    // empty transcript short-circuits before any call
    const calls = stub(() => chat("[]"));
    expect(await httpReflector("http://litellm:4000", "sk-master").reflect(input({ turns: [] }))).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("fakeReflector (Story 8.4)", () => {
  it("is deterministic, records calls, and can be driven to throw", async () => {
    const f = fakeReflector();
    const out = await f.reflect(input());
    expect(out[0].kind).toBe("semantic");
    expect(f.calls).toHaveLength(1);
    expect(await f.reflect(input({ turns: [] }))).toEqual([]); // empty transcript → nothing

    const fixed = fakeReflector({ memories: [{ kind: "procedure", content: "step1; step2", summary: "playbook", topic: "t" }] });
    expect(await fixed.reflect(input())).toEqual([{ kind: "procedure", content: "step1; step2", summary: "playbook", topic: "t" }]);

    await expect(fakeReflector({ throws: true }).reflect(input())).rejects.toThrow();
  });
});
