// Money helpers (Story 3.5). Money is integer minor units + currency (never floats). The
// cost-caps UI edits dollars; these convert to/from minor units (cents). MVP: single-currency USD.
export const CURRENCY = "USD";
const MAX_CAP_MINOR = 100_000_00; // $100,000 — matches control-api's cap

/** Parse a dollar string into integer minor units (cents). Rejects negatives, non-numbers,
 *  and more than 2 decimal places with a stated reason. Callers treat empty input as "clear". */
export function parseDollarsToMinor(input: string): { ok: true; minor: number } | { ok: false; error: string } {
  const trimmed = input.trim().replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    return { ok: false, error: "Enter a dollar amount like 5.00." };
  }
  const [whole, frac = ""] = trimmed.split(".");
  const minor = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  if (minor > MAX_CAP_MINOR) return { ok: false, error: "That's above the maximum cap ($100,000)." };
  return { ok: true, minor };
}

/** Format integer minor units as a dollar string with 2 decimals + thousands separators. */
export function formatMinor(minor: number): string {
  return (minor / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Format micro-USD (1e-6 USD) run/call cost as a dollar string (Story 4.5). Sub-cent precision:
 *  ≥4 decimals (e.g. 4100 → "$0.0041"), scaling to more places for tiny amounts. */
export function formatMicros(micros: number): string {
  const usd = micros / 1_000_000;
  const dp = usd !== 0 && Math.abs(usd) < 0.0001 ? 6 : 4;
  return `$${usd.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
}

/** Fraction of the per-day cap at which the agents-list meter turns from neutral to caution. */
export const NEAR_CAP_FRACTION = 0.8;
/** Agents-list daily-meter tone (Story 5.2): "warn" once today's spend reaches NEAR_CAP_FRACTION of
 *  the per-day cap, else "neutral" (DESIGN.md — neutral until near a cap). Spend is micro-USD; the cap
 *  is minor units (cents) — convert micros→cents (÷10,000) before comparing (the units differ 10,000×).
 *  No cap ⇒ always neutral (nothing to approach). */
export function meterTone(spendMicros: number, perDayCapMinor: number | null): "neutral" | "warn" {
  if (!perDayCapMinor) return "neutral";
  return spendMicros / 10_000 >= NEAR_CAP_FRACTION * perDayCapMinor ? "warn" : "neutral";
}
