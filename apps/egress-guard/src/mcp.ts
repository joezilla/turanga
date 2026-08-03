// Guard-side MCP caller (Epic 6, Story 6.4). At RUNTIME the Guard performs the agent's tool call:
// an MCP `tools/call` over its OWN TLS, injecting the held bearer token — the sandbox never sees the
// URL or credential (AD-10). This is the runtime twin of control-api's connect-time httpMcpVerifier
// (Story 6.2): same Client + StreamableHTTPClientTransport + bearer injection, but callTool instead
// of listTools. Injectable (the doFetch/ConnectionAdapter analogue) so guard tests stay network-free.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface McpToolCallInput {
  url: string;
  credential?: string; // the bearer token the Guard holds for the run; the agent never sees it (AD-10)
  operation: string; // the MCP tool name
  arguments?: Record<string, unknown>;
  timeoutMs?: number;
}

// A successful CALL (the MCP round trip completed). `isError` is the tool's own execution error —
// distinct from a Guard refusal or a transport failure; it rides inside a 200 and is passed through.
export type McpToolCallResult = { ok: true; content: unknown[]; isError: boolean } | { ok: false; error: string };

export type McpToolCaller = (input: McpToolCallInput) => Promise<McpToolCallResult>;

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Real caller: connect over Streamable HTTP (initialize), then `tools/call`. The bearer token is set
 *  on every request via `requestInit.headers` — the forwarding client attaches Authorization; the
 *  server neither knows nor cares a proxy added it (MCP auth model). Per-call connect is fine for MVP
 *  (a per-run client cache is a later optimization). */
export function httpMcpToolCaller(): McpToolCaller {
  return async (input) => {
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      return { ok: false, error: "The tool endpoint isn't a valid URL." };
    }
    const transport = new StreamableHTTPClientTransport(
      url,
      input.credential ? { requestInit: { headers: { Authorization: `Bearer ${input.credential}` } } } : undefined,
    );
    const client = new Client({ name: "turanga-guard", version: "0.0.0" });
    try {
      await client.connect(transport); // runs the MCP `initialize` handshake
      const r = await client.callTool({ name: input.operation, arguments: input.arguments ?? {} });
      return { ok: true, content: (r.content ?? []) as unknown[], isError: !!r.isError };
    } catch (e) {
      // AD-10: the sandbox-facing error MUST be Guard-composed — the raw MCP/undici error can carry
      // the tool endpoint URL/host or the server's response body (the agent must never learn the URL).
      // Log the raw cause Guard-side for the operator; return only a generic message to the run.
      console.error(`[egress-guard] tool call failed (${input.operation}):`, msg(e));
      return { ok: false, error: "Couldn't reach the tool endpoint." };
    } finally {
      await client.close().catch(() => {});
    }
  };
}

/** Test double (mirrors fakeMcpVerifier). Records every input so a test can assert the Guard passed the
 *  credential + operation + arguments (proving Guard-side custody). `ok:false` drives the error path. */
export function fakeMcpToolCaller(opts: { ok?: boolean; error?: string; content?: unknown[]; isError?: boolean } = {}): McpToolCaller & { calls: McpToolCallInput[] } {
  const calls: McpToolCallInput[] = [];
  const fn = (async (input: McpToolCallInput) => {
    calls.push(input);
    if (opts.ok === false) return { ok: false, error: opts.error ?? "The tool endpoint rejected the call." };
    return { ok: true, content: opts.content ?? [{ type: "text", text: "ok" }], isError: opts.isError ?? false };
  }) as McpToolCaller & { calls: McpToolCallInput[] };
  fn.calls = calls;
  return fn;
}
