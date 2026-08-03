import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createGuard, sentinelFilterHook } from "./guard.js";

const port = Number(process.env.PORT ?? 8081);

const DEFAULT_ADMIN_TOKEN = "dev-guard-admin";
const adminToken = process.env.GUARD_ADMIN_TOKEN ?? DEFAULT_ADMIN_TOKEN;
// Fail-closed on a well-known secret in production (matches the SANDBOX_RUNTIME posture).
if (process.env.NODE_ENV === "production" && adminToken === DEFAULT_ADMIN_TOKEN) {
  throw new Error("GUARD_ADMIN_TOKEN must be set to a non-default value in production.");
}

const guard = createGuard({
  socketDir: process.env.GUARD_SOCKET_DIR ?? "/run/guard",
  litellmBaseUrl: process.env.LITELLM_BASE_URL ?? "http://litellm:4000",
  litellmMasterKey: process.env.LITELLM_MASTER_KEY ?? "sk-turanga-dev",
  // Out-of-band Guard→orchestrator channel (Story 4.5, E4-AD-10): cost metrics + breach kill.
  controlCallbackUrl: process.env.CONTROL_API_URL ?? "http://control-api:8080",
  callbackToken: process.env.GUARD_CALLBACK_TOKEN ?? "dev-guard-callback",
  // Filter Hook (Story 4.6, FR-10/E4-AD-6): no inspector ships in MVP — the default is a no-op.
  // Setting GUARD_FILTER_SENTINEL registers a trivial sentinel-blocking hook to demonstrate the seam.
  filterHook: process.env.GUARD_FILTER_SENTINEL ? sentinelFilterHook(process.env.GUARD_FILTER_SENTINEL) : undefined,
});

const app = createApp({ guard, adminToken });

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[egress-guard] listening on :${info.port} (run-admin enabled)`);
});
