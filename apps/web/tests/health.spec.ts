import { test, expect } from "@playwright/test";

// Requires the compose stack up (control-api on :8080). Dev server runs on :5173
// (the control-api CORS-allowed origin), so the browser fetch to :8080 succeeds.

test("landing page renders on tokens and reaches the control plane (regression)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "turanga" })).toBeVisible();
  // Story 1.1 regression: control-plane connectivity still reported.
  await expect(page.getByTestId("control-status")).toHaveText("control plane: connected", { timeout: 10000 });
  // UX-DR19: a Lucide icon renders as an inline svg.
  expect(await page.locator("svg").count()).toBeGreaterThan(0);
});

test("theme toggle flips data-theme and changes the canvas background (tokens + theming)", async ({ page }) => {
  await page.goto("/");
  const bgOf = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  // Force a known starting theme, then read the token-driven background.
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
  const lightBg = await bgOf();

  await page.getByRole("button", { name: "Toggle theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const darkBg = await bgOf();

  // Proves components read semantic tokens that re-declare under [data-theme="dark"].
  expect(darkBg).not.toBe(lightBg);
});
