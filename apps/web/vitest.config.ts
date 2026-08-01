import { defineConfig } from "vitest/config";

// Plain unit-test config (no SvelteKit plugin) for pure-TS logic like the variable parser.
// Component/e2e behavior is covered by Playwright; svelte-check runs via `pnpm check`.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
