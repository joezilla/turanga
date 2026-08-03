import { Hono } from "hono";
import { ulid } from "@turanga/domain";
import type { ConnectionsRepo, ProviderRow } from "./repo.js";
import type { AgentsRepo } from "../agents/repo.js";
import type { ModelGateway, ProviderKind, RegisterInput } from "../litellm/gateway.js";
import { defaultEnabledModels, reconcileEnabled, resolveCatalog } from "./models.js";

const PROVIDERS: ProviderKind[] = ["openai", "anthropic", "openai-compatible"];

function last4(key: string): string {
  return key.slice(-4);
}

// The public view — NEVER includes the key (only key_last4) or LiteLLM ids.
function view(r: ProviderRow) {
  return {
    id: r.id,
    provider: r.provider,
    name: r.name,
    baseUrl: r.baseUrl,
    keyLast4: r.keyLast4,
    status: r.status,
    lastError: r.lastError,
    models: r.models,
    enabledModels: r.enabledModels,
  };
}

function parseModels(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (typeof v === "string") return v.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  return [];
}

export function connectionRoutes(repo: ConnectionsRepo, gateway: ModelGateway, agentsRepo: AgentsRepo) {
  const app = new Hono();

  app.get("/connections/providers", async (c) => {
    return c.json({ providers: (await repo.listProviders()).map(view) });
  });

  // Agents that reference this provider — those whose selected model is "<kind>/…" (Story 3.6).
  // Advisory guard: the providers page surfaces these before a removal is confirmed.
  app.get("/connections/providers/:id/dependents", async (c) => {
    const provider = await repo.getProvider(c.req.param("id"));
    if (!provider) return c.json({ error: "Not found." }, 404);
    const prefix = `${provider.provider}/`;
    const agents = (await agentsRepo.list())
      .filter((a) => a.model?.startsWith(prefix))
      .map((a) => ({ id: a.id, name: a.name, state: a.state }));
    return c.json({ agents });
  });

  app.post("/connections/providers", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const provider = body.provider;
    const apiKey = body.apiKey;
    if (typeof provider !== "string" || !PROVIDERS.includes(provider as ProviderKind) || typeof apiKey !== "string" || !apiKey) {
      return c.json({ error: "Provider and API key are required." }, 400);
    }
    const kind = provider as ProviderKind;
    const baseUrl = typeof body.baseUrl === "string" && body.baseUrl.trim() ? body.baseUrl.trim() : undefined;
    const models = parseModels(body.models);
    const name =
      typeof body.name === "string" && body.name.trim()
        ? body.name.trim()
        : kind === "openai"
          ? "OpenAI"
          : kind === "anthropic"
            ? "Anthropic"
            : "Custom";
    if (kind === "openai-compatible" && (!baseUrl || models.length === 0)) {
      return c.json({ error: "An OpenAI-compatible provider needs a base URL and at least one model." }, 400);
    }

    const input: RegisterInput = { provider: kind, name, apiKey, baseUrl, models };
    const id = ulid(Date.now());
    const base: ProviderRow = {
      id,
      provider: kind,
      name,
      baseUrl: baseUrl ?? null,
      keyLast4: last4(apiKey),
      status: "error",
      lastError: null,
      models,
      enabledModels: [],
      litellmModelIds: [],
    };

    // Verify FIRST — never store a bad key in LiteLLM (AC2, Story 2.1).
    const v = await gateway.verify(input);
    if (!v.ok) {
      await repo.createProvider({ ...base, status: "error", lastError: v.error ?? "Verification failed." });
      return c.json({ provider: view((await repo.getProvider(id))!) }, 201);
    }
    // Story 2.4: persist the catalog + a chat-default enabled subset. openai/anthropic use the fetched
    // /v1/models; openai-compatible keeps the user's typed list (never a huge upstream catalog).
    const fetched = resolveCatalog(kind, v.models ?? [], models);
    const enabledModels = defaultEnabledModels(kind, fetched);
    let ids: string[] = [];
    try {
      ids = await gateway.register({ ...input, models: fetched });
    } catch {
      await repo.createProvider({ ...base, status: "error", lastError: "Key verified, but registering the model gateway failed." });
      return c.json({ provider: view((await repo.getProvider(id))!) }, 201);
    }
    await repo.createProvider({ ...base, status: "connected", lastError: null, models: fetched, enabledModels, litellmModelIds: ids });
    return c.json({ provider: view((await repo.getProvider(id))!) }, 201);
  });

  // Re-verify a provider with the supplied key, re-fetch its catalog, reconcile the enabled set
  // (preserving the user's choices for still-present models — Story 2.4 AC4), and re-register with
  // LiteLLM. Registers the NEW models BEFORE dropping the old, so a register failure can never leave a
  // "connected" provider pointing at deleted registrations. Does NOT mutate status on failure — the
  // caller decides (rotate flips to error; refresh keeps the working connection). Shared by rotate-key
  // (new key) + refresh-models (re-enter key). The key is never stored control-api-side (AD-10).
  async function syncCatalog(existing: ProviderRow, apiKey: string): Promise<{ ok: true; provider: ProviderRow } | { ok: false; error: string }> {
    const kind = existing.provider as ProviderKind;
    const input: RegisterInput = { provider: kind, name: existing.name, apiKey, baseUrl: existing.baseUrl ?? undefined, models: existing.models };
    const v = await gateway.verify(input);
    if (!v.ok) return { ok: false, error: v.error ?? "Verification failed." };
    const fetched = resolveCatalog(kind, v.models ?? [], existing.models);
    const enabledModels = reconcileEnabled(kind, existing.models, existing.enabledModels, fetched);
    let ids: string[];
    try {
      ids = await gateway.register({ ...input, models: fetched }); // new registrations first…
    } catch {
      return { ok: false, error: "The key verified, but registering the models with the gateway failed. The provider is unchanged." };
    }
    await gateway.unregister(existing.litellmModelIds); // …then drop the old (best-effort, no longer referenced)
    await repo.setModelIds(existing.id, ids);
    await repo.setModels(existing.id, fetched, enabledModels);
    await repo.setStatus(existing.id, "connected", null, last4(apiKey));
    return { ok: true, provider: (await repo.getProvider(existing.id))! };
  }

  app.post("/connections/providers/:id/rotate-key", async (c) => {
    const existing = await repo.getProvider(c.req.param("id"));
    if (!existing) return c.json({ error: "Not found." }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { apiKey?: unknown };
    if (typeof body.apiKey !== "string" || !body.apiKey) return c.json({ error: "A new API key is required." }, 400);
    const r = await syncCatalog(existing, body.apiKey);
    if (!r.ok) {
      // Rotate is a deliberate key REPLACEMENT — a bad new key marks the provider error (Story 2.1).
      await repo.setStatus(existing.id, "error", r.error, last4(body.apiKey));
      return c.json({ provider: view((await repo.getProvider(existing.id))!) });
    }
    return c.json({ provider: view(r.provider) });
  });

  // Refresh the model catalog (Story 2.4). The key isn't kept control-api-side (AD-10), so a refresh
  // re-takes it. Unlike rotate, a bad key here must NOT disconnect a working provider — a re-query
  // failure returns an error and leaves the connection untouched.
  app.post("/connections/providers/:id/refresh-models", async (c) => {
    const existing = await repo.getProvider(c.req.param("id"));
    if (!existing) return c.json({ error: "Not found." }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { apiKey?: unknown };
    if (typeof body.apiKey !== "string" || !body.apiKey) return c.json({ error: "The API key is required to refresh models." }, 400);
    const r = await syncCatalog(existing, body.apiKey);
    if (!r.ok) return c.json({ error: r.error }, 400); // provider stays connected — a refresh typo can't break it
    return c.json({ provider: view(r.provider) });
  });

  // Set which fetched models are enabled/selectable (Story 2.4). Unknown ids (not in the catalog) are
  // ignored. control-api is the sole writer of connection state (AD-7).
  app.put("/connections/providers/:id/models", async (c) => {
    const existing = await repo.getProvider(c.req.param("id"));
    if (!existing) return c.json({ error: "Not found." }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { enabled?: unknown };
    const requested = new Set(parseModels(body.enabled));
    const enabled = existing.models.filter((m) => requested.has(m)); // only ids that are in the catalog
    await repo.setEnabled(existing.id, enabled);
    return c.json({ provider: view((await repo.getProvider(existing.id))!) });
  });

  app.delete("/connections/providers/:id", async (c) => {
    const id = c.req.param("id");
    const existing = await repo.getProvider(id);
    if (!existing) return c.json({ error: "Not found." }, 404);
    await gateway.unregister(existing.litellmModelIds);
    await repo.deleteProvider(id);
    return c.json({ ok: true });
  });

  app.get("/models", async (c) => {
    return c.json({ models: await gateway.listModels() });
  });

  return app;
}
