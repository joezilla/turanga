// Tools client (Epic 6, Story 6.1). control-api is the only writer of Tool state (AD-7); the web
// reads + (from 6.2) POSTs. Same base + credentials + Result pattern as $lib/connections. The Tool
// shape mirrors the masked server view() (no credential ever reaches the browser — AD-10).
const base = import.meta.env.VITE_CONTROL_API_URL ?? "http://localhost:8080";

export type ToolEndpointType = "remote" | "container";
export type ToolStatus = "unverified" | "connected" | "error";

export interface ToolOperation {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
}

export interface Tool {
  id: string;
  name: string;
  endpoint: ToolEndpointType;
  status: ToolStatus;
  lastError: string | null;
  operations: ToolOperation[];
  createdAt: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

async function req<T>(path: string, init?: RequestInit): Promise<Result<T>> {
  try {
    const r = await fetch(`${base}${path}`, { credentials: "include", ...init });
    if (r.ok) return { ok: true, value: (await r.json().catch(() => ({}))) as T };
    const body = (await r.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: body.error ?? `Request failed (${r.status}).` };
  } catch {
    return { ok: false, error: "Can't reach the control plane." };
  }
}

export async function listTools(): Promise<Result<Tool[]>> {
  const r = await req<{ tools?: Tool[] }>("/tools");
  if (!r.ok) return r;
  if (!Array.isArray(r.value.tools)) return { ok: false, error: "The control plane returned an unexpected response." };
  return { ok: true, value: r.value.tools };
}

export function removeTool(id: string): Promise<Result<{ ok: true }>> {
  return req(`/tools/${encodeURIComponent(id)}`, { method: "DELETE" });
}
