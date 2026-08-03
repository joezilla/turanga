// MCP verify/discover client (Epic 6, Story 6.2). Connect-time only: control-api (the trusted control
// plane) performs the MCP handshake to VERIFY a remote server + DISCOVER its operations — like
// gateway.verify hits /v1/models. The sandbox never does this; the runtime agent→tool call goes
// through the Guard (Story 6.4). Injectable (the ModelGateway analogue) so tests use a fake.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ToolOperation } from "@turanga/domain";

export interface McpVerifyInput {
  url: string;
  credential?: string; // a bearer token; the control plane holds it, the agent never does (AD-10)
}
export type McpVerifyResult = { ok: true; operations: ToolOperation[] } | { ok: false; error: string };

export interface McpVerifier {
  verify(input: McpVerifyInput): Promise<McpVerifyResult>;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Real verifier: connect over Streamable HTTP (initialize) and list-tools (auto-paginates). The
 *  bearer token is set on every request via `requestInit.headers` — a forwarding client sets
 *  Authorization; the server neither knows nor cares a proxy attached it (MCP auth model). */
export function httpMcpVerifier(): McpVerifier {
  return {
    async verify(input) {
      let url: URL;
      try {
        url = new URL(input.url);
      } catch {
        return { ok: false, error: "That doesn't look like a valid URL." };
      }
      const transport = new StreamableHTTPClientTransport(
        url,
        input.credential ? { requestInit: { headers: { Authorization: `Bearer ${input.credential}` } } } : undefined,
      );
      const client = new Client({ name: "turanga", version: "0.0.0" });
      try {
        await client.connect(transport); // runs the MCP `initialize` handshake
        const { tools } = await client.listTools();
        const operations: ToolOperation[] = tools.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
        }));
        return { ok: true, operations };
      } catch (e) {
        return { ok: false, error: `Couldn't connect to the MCP server — check the URL and credential. (${msg(e)})` };
      } finally {
        await client.close().catch(() => {});
      }
    },
  };
}

/** Test double (mirrors fakeModelGateway). Default returns a couple of representative operations so a
 *  connect test has something to persist; `ok:false` drives the fail-closed path. */
export function fakeMcpVerifier(opts: { ok?: boolean; error?: string; operations?: ToolOperation[] } = {}): McpVerifier {
  return {
    async verify() {
      if (opts.ok === false) return { ok: false, error: opts.error ?? "The MCP server rejected the connection." };
      return {
        ok: true,
        operations: opts.operations ?? [
          { name: "echo", description: "Echo the input back" },
          { name: "get_time", description: "Return the current time" },
        ],
      };
    },
  };
}
