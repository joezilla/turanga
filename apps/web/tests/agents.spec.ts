import { test, expect, type Page } from "@playwright/test";

// Requires the live stack (control-api :8080 owns its `control` DB) seeded with deploy/.env
// creds. Story 3.1: create + list + Draft state. Serial (workers:1) — each run creates rows.

const EMAIL = "admin@turanga.local";
const PASSWORD = "changeme-dev";

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/agents$/);
}

test("create an agent → it appears as a Draft row; the filter focuses on '/' and narrows", async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();

  // Empty state (fresh DB): fact + one action. [AC1]
  await expect(page.getByText("No agents yet.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Create agent" })).toBeVisible();

  // Create an agent.
  await page.getByRole("button", { name: "Create agent" }).first().click();

  // A row appears with a Draft status shown as dot + the word "draft".
  const rows = page.locator("li.agent");
  await expect(rows.first()).toBeVisible();
  await expect(rows.first()).toContainText("Untitled agent");
  await expect(rows.first().locator(".status-dot")).toContainText("draft");

  // The filter is present, "/" focuses it, and typing narrows the list.
  const filter = page.getByPlaceholder("Filter agents");
  await expect(filter).toBeVisible();
  await page.keyboard.press("/");
  await expect(filter).toBeFocused();
  await filter.fill("no-such-agent-xyz");
  await expect(page.locator("li.agent")).toHaveCount(0);
  await expect(page.getByText(/No agents match/)).toBeVisible();
});
