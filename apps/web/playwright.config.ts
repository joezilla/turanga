import { defineConfig } from "@playwright/test";

// Dev server on :5173 — the control-api CORS-allowed origin — so the browser's
// fetch to control-api :8080 succeeds and the page reports "connected" (AC3).
export default defineConfig({
  testDir: "tests",
  // Serial: the suite does many argon2 logins; parallel workers contend on control-api CPU.
  workers: 1,
  webServer: { command: "npm run dev", port: 5173, reuseExistingServer: !process.env.CI, timeout: 60000 },
  use: { baseURL: "http://localhost:5173" },
});
