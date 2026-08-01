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

export interface ModelGateway {
  verify(input: RegisterInput): Promise<VerifyResult>;
  register(input: RegisterInput): Promise<string[]>; // LiteLLM model_info ids
  unregister(ids: string[]): Promise<void>;
  listModels(): Promise<string[]>;
}

function stripTrailingSlash(u: string): string {
  return u.replace(/\/+$/, "");
}

export function httpModelGateway(litellmBaseUrl: string, masterKey: string): ModelGateway {
  const llmHeaders = { authorization: `Bearer ${masterKey}`, "content-type": "application/json" };

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
  };
}

// Test double.
export function fakeModelGateway(opts: { verifyOk?: boolean; verifyError?: string } = {}): ModelGateway & { registered: string[][]; unregistered: string[] } {
  const registered: string[][] = [];
  const unregistered: string[] = [];
  let counter = 0;
  return {
    registered,
    unregistered,
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
  };
}
