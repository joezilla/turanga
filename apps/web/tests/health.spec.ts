import { test, expect } from "@playwright/test";

// AC3: the web app loads and reaches the control-api health endpoint.
// Requires the compose stack up (control-api on :8080).
test("home page loads and reaches the control plane", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "turanga" })).toBeVisible();
  await expect(page.getByTestId("control-status")).toHaveText("control plane: connected", { timeout: 10000 });
});
