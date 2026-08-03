// A tiny MCP server for local dev + e2e (Story 6.2). It exists so "Add a tool" has a real remote MCP
// endpoint to verify against — the control-api's httpMcpVerifier does an actual MCP handshake here.
// Stateless Streamable HTTP: a fresh McpServer + transport per request (no sessions), JSON responses.
// Not part of the trust boundary — it holds no secrets. Optional bearer auth (MCP_STUB_TOKEN) lets the
// e2e exercise both the no-auth and credentialed paths.
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const port = Number(process.env.PORT ?? 9000);
const token = process.env.MCP_STUB_TOKEN; // when set, every /mcp request must carry `Authorization: Bearer <token>`

// Canned operations — enough for discovery to return a stable, recognizable set.
function buildServer(): McpServer {
  const server = new McpServer({ name: "turanga-mcp-stub", version: "0.0.0" });
  server.registerTool(
    "echo",
    { title: "Echo", description: "Echo back the text you send.", inputSchema: { text: z.string() } },
    async ({ text }) => ({ content: [{ type: "text", text }] }),
  );
  server.registerTool(
    "get_time",
    { title: "Get time", description: "Return a fixed server time (this is a stub).", inputSchema: {} },
    async () => ({ content: [{ type: "text", text: "2026-01-01T00:00:00Z" }] }),
  );
  return server;
}

const rpcError = (message: string, code: number) => JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null });

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.url !== "/mcp") {
    res.writeHead(404, { "content-type": "application/json" }).end(rpcError("Not found.", -32601));
    return;
  }
  if (token) {
    const auth = req.headers["authorization"];
    if (auth !== `Bearer ${token}`) {
      res.writeHead(401, { "content-type": "application/json" }).end(rpcError("Unauthorized.", -32001));
      return;
    }
  }

  // Stateless: parse the body ourselves, then hand a new server+transport this one request.
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    res.writeHead(400, { "content-type": "application/json" }).end(rpcError("Parse error.", -32700));
    return;
  }

  const mcp = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    transport.close().catch(() => {});
    mcp.close().catch(() => {});
  });
  try {
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (e) {
    console.error("[mcp-stub] request failed:", e);
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" }).end(rpcError("Internal error.", -32603));
  }
});

server.listen(port, () => {
  console.log(`[mcp-stub] MCP server listening on :${port}/mcp${token ? " (bearer auth required)" : ""}`);
});
