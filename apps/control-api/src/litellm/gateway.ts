// ModelGateway: verify a provider key (provider-direct — deterministic, free, avoids
// LiteLLM wildcard/health quirks) and register the provider with LiteLLM so its key is
// stored encrypted there (AD-10) and its models become callable. One interface, injected;
// a fake impl drives the unit tests.

export type ProviderKind = "openai" | "anthropic" | "openai-compatible";

export interface RegisterInput {
  provider: ProviderKind;
  name: string;
  apiKey: string;
  baseUrl?: string;
  models?: string[]; // required for openai-compatible
}
export interface VerifyResult {
  ok: boolean;
  error?: string; // human cause, never contains the key
}

import type { Money } from "@turanga/domain";

export interface ModelGateway {
  verify(input: RegisterInput): Promise<VerifyResult>;
  register(input: RegisterInput): Promise<string[]>; // LiteLLM model_info ids
  unregister(ids: string[]): Promise<void>;
  listModels(): Promise<string[]>;
  // Cost enforcement (Story 4.5, AD-6). The per-agent daily budget is a LiteLLM TEAM (resets daily);
  // the per-run cap is a KEY minted under it. LiteLLM 400s a call when EITHER budget is exceeded.
  ensureAgentTeam(agentId: string, perDayCap: Money | null): Promise<string>; // team_id (idempotent by alias)
  mintRunKey(input: { teamId: string; perRunCap: Money | null; runId: string }): Promise<string>; // the per-run key
  deleteKey(key: string): Promise<void>;
  teamSpendMicros(teamId: string): Promise<number>; // best-effort, lags ~60s — display only, never enforcement
}

function stripTrailingSlash(u: string): string {
  return u.replace(/\/+$/, "");
}

// LiteLLM budgets are USD dollars (float); our caps are Money in integer minor units (cents).
const dollars = (m: Money | null): number | undefined => (m ? m.minor / 100 : undefined);
const MICROS_PER_USD = 1_000_000;

export function httpModelGateway(litellmBaseUrl: string, masterKey: string): ModelGateway {
  const llmHeaders = { authorization: `Bearer ${masterKey}`, "content-type": "application/json" };
  const teamAlias = (agentId: string) => `agent-${agentId}`;

  async function addModel(modelName: string, model: string, apiKey: string, apiBase?: string): Promise<string> {
    const res = await fetch(`${litellmBaseUrl}/model/new`, {
      method: "POST",
      headers: llmHeaders,
      body: JSON.stringify({ model_name: modelName, litellm_params: { model, api_key: apiKey, ...(apiBase ? { api_base: apiBase } : {}) } }),
    });
    if (!res.ok) throw new Error(`LiteLLM /model/new failed (${res.status})`);
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const info = (json.model_info ?? (json.data as Record<string, unknown>)?.model_info) as { id?: string } | undefined;
    const id = info?.id ?? (json.id as string | undefined);
    if (!id) throw new Error("LiteLLM /model/new returned no model id");
    return id;
  }

  async function providerVerify(input: RegisterInput): Promise<VerifyResult> {
    try {
      let url: string;
      let headers: Record<string, string>;
      if (input.provider === "anthropic") {
        url = "https://api.anthropic.com/v1/models";
        headers = { "x-api-key": input.apiKey, "anthropic-version": "2023-06-01" };
      } else if (input.provider === "openai") {
        url = "https://api.openai.com/v1/models";
        headers = { authorization: `Bearer ${input.apiKey}` };
      } else {
        if (!input.baseUrl) return { ok: false, error: "A base URL is required for an OpenAI-compatible provider." };
        url = `${stripTrailingSlash(input.baseUrl)}/models`;
        headers = { authorization: `Bearer ${input.apiKey}` };
      }
      const res = await fetch(url, { headers });
      if (res.ok) return { ok: true };
      return { ok: false, error: `The provider rejected the key (HTTP ${res.status}). Check the key and try again.` };
    } catch {
      return { ok: false, error: "Couldn't reach the provider to verify the key. Check the base URL / network." };
    }
  }

  return {
    verify: providerVerify,
    async register(input) {
      if (input.provider === "openai") return [await addModel("openai/*", "openai/*", input.apiKey)];
      if (input.provider === "anthropic") return [await addModel("anthropic/*", "anthropic/*", input.apiKey)];
      // openai-compatible: namespaced model_name avoids colliding with the real openai/* wildcard
      const models = input.models ?? [];
      const ids: string[] = [];
      for (const m of models) ids.push(await addModel(`${input.name}/${m}`, `openai/${m}`, input.apiKey, input.baseUrl));
      return ids;
    },
    async unregister(ids) {
      for (const id of ids) {
        await fetch(`${litellmBaseUrl}/model/delete`, { method: "POST", headers: llmHeaders, body: JSON.stringify({ id }) }).catch(() => {});
      }
    },
    async listModels() {
      const res = await fetch(`${litellmBaseUrl}/v1/models`, { headers: { authorization: `Bearer ${masterKey}` } });
      if (!res.ok) return [];
      const json = (await res.json().catch(() => ({}))) as { data?: { id?: string }[] };
      return (json.data ?? []).map((m) => m.id).filter((x): x is string => typeof x === "string");
    },
    async ensureAgentTeam(agentId, perDayCap) {
      const alias = teamAlias(agentId);
      const budget = dollars(perDayCap);
      // Idempotent by alias: LiteLLM is the store. Reuse an existing team (and refresh its budget so
      // per-day cap edits apply); otherwise create a daily-resetting team.
      const list = await fetch(`${litellmBaseUrl}/team/list`, { headers: llmHeaders }).catch(() => null);
      if (list?.ok) {
        const teams = (await list.json().catch(() => [])) as { team_id?: string; team_alias?: string }[];
        const existing = (Array.isArray(teams) ? teams : []).find((t) => t.team_alias === alias);
        if (existing?.team_id) {
          await fetch(`${litellmBaseUrl}/team/update`, { method: "POST", headers: llmHeaders, body: JSON.stringify({ team_id: existing.team_id, max_budget: budget ?? null, budget_duration: budget ? "1d" : null }) }).catch(() => {});
          return existing.team_id;
        }
      }
      const res = await fetch(`${litellmBaseUrl}/team/new`, {
        method: "POST",
        headers: llmHeaders,
        body: JSON.stringify({ team_alias: alias, ...(budget !== undefined ? { max_budget: budget, budget_duration: "1d" } : {}) }),
      });
      if (!res.ok) throw new Error(`LiteLLM /team/new failed (${res.status})`);
      const json = (await res.json().catch(() => ({}))) as { team_id?: string };
      if (!json.team_id) throw new Error("LiteLLM /team/new returned no team_id");
      return json.team_id;
    },
    async mintRunKey({ teamId, perRunCap, runId }) {
      const budget = dollars(perRunCap);
      const res = await fetch(`${litellmBaseUrl}/key/generate`, {
        method: "POST",
        headers: llmHeaders,
        body: JSON.stringify({ team_id: teamId, key_alias: `run-${runId}`, duration: "2h", ...(budget !== undefined ? { max_budget: budget } : {}) }),
      });
      if (!res.ok) throw new Error(`LiteLLM /key/generate failed (${res.status})`);
      const json = (await res.json().catch(() => ({}))) as { key?: string };
      if (!json.key) throw new Error("LiteLLM /key/generate returned no key");
      return json.key;
    },
    async deleteKey(key) {
      await fetch(`${litellmBaseUrl}/key/delete`, { method: "POST", headers: llmHeaders, body: JSON.stringify({ keys: [key] }) }).catch(() => {});
    },
    async teamSpendMicros(teamId) {
      const res = await fetch(`${litellmBaseUrl}/team/info?team_id=${encodeURIComponent(teamId)}`, { headers: llmHeaders }).catch(() => null);
      if (!res?.ok) return 0;
      const json = (await res.json().catch(() => ({}))) as { team_info?: { spend?: number }; spend?: number };
      const usd = json.team_info?.spend ?? json.spend ?? 0;
      return Math.round(usd * MICROS_PER_USD);
    },
  };
}

// Test double.
export function fakeModelGateway(opts: { verifyOk?: boolean; verifyError?: string; teamSpendMicros?: number } = {}): ModelGateway & {
  registered: string[][];
  unregistered: string[];
  mintedKeys: { runId: string; teamId: string; perRunCap: Money | null }[];
  deletedKeys: string[];
} {
  const registered: string[][] = [];
  const unregistered: string[] = [];
  const mintedKeys: { runId: string; teamId: string; perRunCap: Money | null }[] = [];
  const deletedKeys: string[] = [];
  let counter = 0;
  return {
    registered,
    unregistered,
    mintedKeys,
    deletedKeys,
    async verify() {
      return opts.verifyOk === false ? { ok: false, error: opts.verifyError ?? "bad key" } : { ok: true };
    },
    async register(input) {
      const n = input.provider === "openai-compatible" ? (input.models?.length ?? 0) : 1;
      const ids = Array.from({ length: Math.max(1, n) }, () => `llm-${++counter}`);
      registered.push(ids);
      return ids;
    },
    async unregister(ids) {
      unregistered.push(...ids);
    },
    async listModels() {
      return ["openai/gpt-4o", "anthropic/claude-sonnet-4"];
    },
    async ensureAgentTeam(agentId) {
      return `team-${agentId}`;
    },
    async mintRunKey({ teamId, perRunCap, runId }) {
      mintedKeys.push({ runId, teamId, perRunCap });
      return `sk-run-${runId}-${++counter}`;
    },
    async deleteKey(key) {
      deletedKeys.push(key);
    },
    async teamSpendMicros() {
      return opts.teamSpendMicros ?? 0;
    },
  };
}
