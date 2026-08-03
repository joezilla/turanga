// Timestamp helpers (Story 5.3). Run timestamps are UTC ISO-8601 strings; render them in the
// viewer's local time. Small $lib helper, mirroring money.ts. Timestamps render in mono (DESIGN.md).

const fmt = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

/** Format a UTC ISO-8601 string as a readable local absolute time (e.g. "Aug 3, 2026, 9:16 AM").
 *  An empty or unparseable input returns "" (a missing timestamp must not render "Invalid Date"). */
export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return fmt.format(d);
}
