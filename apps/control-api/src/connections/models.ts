// Provider model curation (Story 2.4). A provider's `/v1/models` returns everything — chat models
// plus embeddings, whisper, tts, image, etc. These pure helpers decide the default-enabled subset
// (the "recognized chat models" rule) and reconcile it across a refresh. No I/O — unit-tested.
import type { ProviderKind } from "../litellm/gateway.js";

// Non-chat model families to exclude from the openai default-enabled set.
const NON_CHAT = /(embedding|whisper|tts|dall-?e|audio|realtime|moderation|image|search|transcribe|speech|rerank|moderat)/i;
const OPENAI_CHAT = /^(gpt-|o1|o3|o4|chatgpt)/i;
const ANTHROPIC_CHAT = /^claude-/i;

/** Is `id` a recognized chat model for `provider` — the default-enabled rule (Story 2.4 AC1). An
 *  openai-compatible endpoint is user-curated, so every fetched id is treated as chat. */
export function isChatModel(provider: ProviderKind, id: string): boolean {
  if (provider === "openai-compatible") return true;
  if (provider === "anthropic") return ANTHROPIC_CHAT.test(id);
  return OPENAI_CHAT.test(id) && !NON_CHAT.test(id); // openai
}

/** The subset of `ids` to enable by default on first fetch (recognized chat models). */
export function defaultEnabledModels(provider: ProviderKind, ids: string[]): string[] {
  return ids.filter((id) => isChatModel(provider, id));
}

/** Reconcile the enabled set across a refresh (Story 2.4 AC4): a model still present keeps the user's
 *  prior enable/disable choice; a brand-new model follows the chat default; a removed model drops. */
export function reconcileEnabled(provider: ProviderKind, prevModels: string[], prevEnabled: string[], newModels: string[]): string[] {
  const prevModelSet = new Set(prevModels);
  const prevEnabledSet = new Set(prevEnabled);
  return newModels.filter((id) => (prevModelSet.has(id) ? prevEnabledSet.has(id) : isChatModel(provider, id)));
}
