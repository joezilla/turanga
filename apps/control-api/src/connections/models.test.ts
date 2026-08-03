import { describe, it, expect } from "vitest";
import { isChatModel, defaultEnabledModels, reconcileEnabled, resolveCatalog } from "./models.js";

describe("provider model curation (Story 2.4)", () => {
  it("isChatModel: openai keeps chat families, excludes non-chat", () => {
    for (const id of ["gpt-4o", "gpt-4o-mini", "o1", "o3-mini", "o4-mini", "chatgpt-4o-latest"]) {
      expect(isChatModel("openai", id)).toBe(true);
    }
    for (const id of ["text-embedding-3-small", "whisper-1", "tts-1", "dall-e-3", "gpt-4o-audio-preview", "gpt-4o-realtime-preview", "gpt-image-1", "omni-moderation-latest", "gpt-4o-transcribe"]) {
      expect(isChatModel("openai", id)).toBe(false);
    }
  });
  it("isChatModel: anthropic keeps claude-*, nothing else", () => {
    expect(isChatModel("anthropic", "claude-sonnet-4")).toBe(true);
    expect(isChatModel("anthropic", "claude-opus-4-20250101")).toBe(true);
    expect(isChatModel("anthropic", "text-embedding")).toBe(false);
  });
  it("isChatModel: openai-compatible treats every fetched id as chat (user-curated endpoint)", () => {
    expect(isChatModel("openai-compatible", "llama-3")).toBe(true);
    expect(isChatModel("openai-compatible", "whatever-embedding")).toBe(true);
  });

  it("defaultEnabledModels filters to the chat set", () => {
    expect(defaultEnabledModels("openai", ["gpt-4o", "text-embedding-3-small", "gpt-4o-mini", "dall-e-3"])).toEqual(["gpt-4o", "gpt-4o-mini"]);
    expect(defaultEnabledModels("anthropic", ["claude-sonnet-4", "claude-opus-4"])).toEqual(["claude-sonnet-4", "claude-opus-4"]);
    expect(defaultEnabledModels("openai-compatible", ["llama-3", "mixtral"])).toEqual(["llama-3", "mixtral"]);
  });

  it("reconcileEnabled preserves user choices for still-present models, chat-defaults new ones, drops removed", () => {
    const prevModels = ["gpt-4o", "gpt-4o-mini", "o1"];
    const prevEnabled = ["gpt-4o"]; // user disabled gpt-4o-mini and o1
    const newModels = ["gpt-4o", "gpt-4o-mini", "gpt-5", "text-embedding-3-large"]; // o1 gone; gpt-5 + an embedding new
    // gpt-4o preserved (enabled); gpt-4o-mini preserved (disabled → absent); gpt-5 new chat → enabled;
    // the embedding new non-chat → not enabled; o1 removed → gone.
    expect(reconcileEnabled("openai", prevModels, prevEnabled, newModels)).toEqual(["gpt-4o", "gpt-5"]);
  });
  it("reconcileEnabled: a first fetch (no prior) equals the chat default", () => {
    expect(reconcileEnabled("openai", [], [], ["gpt-4o", "text-embedding-3-small"])).toEqual(["gpt-4o"]);
  });

  it("isChatModel: a search-preview chat model is NOT excluded (regex refinement)", () => {
    expect(isChatModel("openai", "gpt-4o-search-preview")).toBe(true);
  });

  it("resolveCatalog: openai/anthropic prefer the fetched list; openai-compatible keeps the curated list", () => {
    // openai/anthropic use fetched (fresh catalog); fall back to curated only when fetched is empty.
    expect(resolveCatalog("openai", ["gpt-4o", "gpt-4o"], ["stale"])).toEqual(["gpt-4o"]); // deduped
    expect(resolveCatalog("openai", [], ["existing"])).toEqual(["existing"]);
    // openai-compatible keeps the user-curated list — never a huge upstream /models catalog.
    expect(resolveCatalog("openai-compatible", ["a", "b", "c", "d"], ["llama-3", "mixtral"])).toEqual(["llama-3", "mixtral"]);
    expect(resolveCatalog("openai-compatible", ["fallback"], [])).toEqual(["fallback"]); // only if nothing curated
  });
});
