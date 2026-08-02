import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createGuard } from "./guard.js";

const port = Number(process.env.PORT ?? 8081);

const guard = createGuard({
  socketDir: process.env.GUARD_SOCKET_DIR ?? "/run/guard",
  litellmBaseUrl: process.env.LITELLM_BASE_URL ?? "http://litellm:4000",
  litellmMasterKey: process.env.LITELLM_MASTER_KEY ?? "sk-turanga-dev",
});

const app = createApp({ guard, adminToken: process.env.GUARD_ADMIN_TOKEN ?? "dev-guard-admin" });

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[egress-guard] listening on :${info.port} (run-admin enabled)`);
});
