import { serve } from "@hono/node-server";
import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 8081);
serve({ fetch: createApp().fetch, port }, (info) => {
  console.log(`[egress-guard] listening on :${info.port}`);
});
