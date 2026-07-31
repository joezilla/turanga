import { test, expect } from "@playwright/test";

// Requires the compose stack up (control-api on :8080). Dev server runs on :5173
// (the control-api CORS-allowed origin), so the browser fetch to :8080 succeeds.

test("app shell renders and reaches the control plane (regression)", async ({ page }) => {
  await page.goto("/"); // redirects to /agents
  await expect(page).toHaveURL(/\/agents$/);

  // Topbar: workspace name + control-plane connectivity (Story 1.1/1.2 regression).
  await expect(page.getByText("turanga", { exact: true })).toBeVisible();
  await expect(page.getByTestId("control-status")).toHaveText("control plane: connected", { timeout: 10000 });

  // Sidebar nav present.
  await expect(page.getByRole("link", { name: "Agents" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Settings" })).toBeVisible();
  // Lucide icons render (UX-DR19).
  expect(await page.locator("svg").count()).toBeGreaterThan(0);
});

test("active nav highlights and navigation works", async ({ page }) => {
  await page.goto("/agents");
  await expect(page.getByRole("link", { name: "Agents" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("link", { name: "Settings" })).not.toHaveAttribute("aria-current", "page");

  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Settings" })).toHaveAttribute("aria-current", "page");
});

test("theme toggle changes the background and persists across reload", async ({ page }) => {
  await page.goto("/agents");
  // Wait for hydration: the control-status fetch only resolves after client JS runs,
  // so the toggle's click handler is guaranteed to be wired before we click it.
  await expect(page.getByTestId("control-status")).toHaveText("control plane: connected", { timeout: 10000 });

  const bgOf = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
    localStorage.setItem("theme", "light");
  });
  const lightBg = await bgOf();

  await page.getByRole("button", { name: "Toggle theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const darkBg = await bgOf();
  expect(darkBg).not.toBe(lightBg); // tokens re-declare under [data-theme="dark"]

  // Persistence (UX-DR17): reload → still dark, no flash.
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});
