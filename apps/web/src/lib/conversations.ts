// Chat conversations client (Epic 9, Story 9.3). Mirrors @turanga/domain's Conversation (KEEP IN
// SYNC). control-api is the sole writer (AD-7); the web starts/reads conversations and turns. A turn
// is a run: sendMessage returns a Run whose id the caller streams over the existing run SSE
// (runEventsUrl from $lib/runs), and a conversation's thread is its linked runs. Same base +
// credentials + Result pattern as $lib/runs.
import { type Run, type Result } from "$lib/runs";

const base = import.meta.env.VITE_CONTROL_API_URL ?? "http://localhost:8080";

// Re-export the run streaming surface so the chat pages import everything chat-related from here.
export { runEventsUrl, getRun, runCause, type Run, type RunMessage, type RunStatus, type Result } from "$lib/runs";

/** A chat conversation — a thread bound to a PUBLISHED agent version. Mirrors @turanga/domain
 *  Conversation (KEEP IN SYNC). `publishedVersion` is pinned at creation (never null). */
export interface Conversation {
  id: string;
  agentId: string;
  publishedVersion: number;
  title: string;
  createdAt: string; // UTC ISO-8601
}

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

/** Start a conversation against a PUBLISHED agent. The server refuses an unpublished agent with a
 *  409 whose message ("Publish this agent to chat with it.") flows straight through as the error. */
export async function createConversation(agentId: string, title?: string): Promise<Result<Conversation>> {
  const r = await req<{ conversation?: Conversation }>("/conversations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentId, title }),
  });
  if (!r.ok) return r;
  if (!r.value.conversation) return { ok: false, error: "The control plane returned an unexpected response." };
  return { ok: true, value: r.value.conversation };
}

/** An agent's conversations, newest-first. */
export async function listConversations(agentId: string): Promise<Result<Conversation[]>> {
  const r = await req<{ conversations?: Conversation[] }>(`/conversations?agentId=${encodeURIComponent(agentId)}`);
  if (!r.ok) return r;
  if (!Array.isArray(r.value.conversations)) return { ok: false, error: "The control plane returned an unexpected response." };
  return { ok: true, value: r.value.conversations };
}

/** A single conversation. A genuine 404 resolves to { ok: true, value: null } (distinct from an outage). */
export async function getConversation(id: string): Promise<Result<Conversation | null>> {
  try {
    const r = await fetch(`${base}/conversations/${encodeURIComponent(id)}`, { credentials: "include" });
    if (r.status === 404) return { ok: true, value: null };
    if (!r.ok) return { ok: false, error: `Couldn't load the conversation (${r.status}).` };
    const body = (await r.json().catch(() => ({}))) as { conversation?: Conversation };
    return { ok: true, value: body.conversation ?? null };
  } catch {
    return { ok: false, error: "Can't reach the control plane." };
  }
}

/** Send a message → run a turn against the pinned published snapshot. Returns the created (running)
 *  Run; the caller opens runEventsUrl(run.id) to stream the reply. */
export async function sendMessage(conversationId: string, taskInput: string): Promise<Result<Run>> {
  const r = await req<{ run?: Run }>(`/conversations/${encodeURIComponent(conversationId)}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskInput }),
  });
  if (!r.ok) return r;
  if (!r.value.run) return { ok: false, error: "The control plane returned an unexpected response." };
  return { ok: true, value: r.value.run };
}

/** The conversation's turns (its linked runs), turnIndex ASC, WITH transcripts — the thread. */
export async function listConversationRuns(id: string): Promise<Result<Run[]>> {
  const r = await req<{ runs?: Run[] }>(`/conversations/${encodeURIComponent(id)}/runs`);
  if (!r.ok) return r;
  if (!Array.isArray(r.value.runs)) return { ok: false, error: "The control plane returned an unexpected response." };
  return { ok: true, value: r.value.runs };
}
