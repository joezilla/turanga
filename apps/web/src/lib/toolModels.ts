// Story 12.7 — the model capability SIGNAL (not a gate). A maintained, evidence-based reference of the
// models we've actually run the tool loop against and seen emit well-formed tool calls reliably. It
// drives a NON-BLOCKING note on the Tools tab when the chosen model isn't verified; it never disables
// anything — a signal, not a gate (an unverified model stays fully usable). This is deliberately a small
// checked-in reference (no table, no API): a model joins the list once we've verified it live. Match by
// substring because model ids carry a provider prefix (e.g. "openai/gpt-4o",
// "openai-compatible//models/gpt-oss-20b-MXFP4.gguf").
//
// NOTE: `gpt-oss` is intentionally absent — it is tool-TRAINED (so it is never blocked) but not yet
// tool-VERIFIED live (the Mortimer acceptance demo is pending). Add it here once that demo proves it.
export const VERIFIED_TOOL_MODELS: readonly string[] = [
  "gpt-4o",
  "gpt-4.1",
  "gpt-5",
  "claude-3-5",
  "claude-3-7",
  "claude-sonnet",
  "claude-opus",
  "claude-haiku",
  "claude-4",
  "gemini-1.5",
  "gemini-2",
];

// A short human label of the verified families for the signal copy (not the full id list).
export const VERIFIED_TOOL_MODELS_LABEL = "gpt-4o, claude, gemini";

/** True when the model is on the verified-tool-calling reference. Case-insensitive substring match over
 *  the (provider-prefixed) model id. A null/empty model is unverified (never throws). Advisory only —
 *  this never gates attaching, granting, saving, activating, or running. */
export function isToolVerified(model: string | null | undefined): boolean {
  if (!model) return false;
  const id = model.toLowerCase();
  return VERIFIED_TOOL_MODELS.some((pattern) => id.includes(pattern));
}
