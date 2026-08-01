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
