import { test, expect, type Page } from "@playwright/test";

// Requires the live stack (control-api :8080 owns its `control` DB) seeded with deploy/.env
// creds. Serial (workers:1). All agent e2e live in this ONE file so order is guaranteed:
// the empty-state assertion (3.1) runs first on a fresh DB, before any test creates agents.
// Story 3.1: create + list + Draft. Story 3.2: /agents/:id two-pane + model + name autosave.

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

  // Empty state (fresh DB): fact + one action. [3.1 AC1]
  await expect(page.getByText("No agents yet.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Create agent" })).toBeVisible();

  // Create an agent.
  await page.getByRole("button", { name: "Create agent" }).first().click();

  // A row appears with a Draft status shown as dot + the word "draft".
  const rows = page.locator("a.agent");
  await expect(rows.first()).toBeVisible();
  await expect(rows.first()).toContainText("Untitled agent");
  await expect(rows.first().locator(".status-dot")).toContainText("draft");

  // The filter is present, "/" focuses it, and typing narrows the list.
  const filter = page.getByPlaceholder("Filter agents");
  await expect(filter).toBeVisible();
  await page.keyboard.press("/");
  await expect(filter).toBeFocused();
  await filter.fill("no-such-agent-xyz");
  await expect(page.locator("a.agent")).toHaveCount(0);
  await expect(page.getByText(/No agents match/)).toBeVisible();
});

test("open an agent → two-pane surface, disabled model selector, and name autosave", async ({ page }) => {
  await signIn(page);

  // Open an agent from the list (navigation deferred from 3.1 lands here). [3.2 AC3]
  await page.locator("a.agent").first().click();
  await expect(page).toHaveURL(/\/agents\/[0-9A-Z]{26}$/);

  // Two-pane surface: the Model section + the test-pane scaffold. [3.2 AC1]
  await expect(page.getByRole("button", { name: "Model" })).toBeVisible();
  await expect(page.getByText("Test runs appear here.")).toBeVisible();

  // No provider connected → selector disabled state + Connect in Settings. [3.2 AC2]
  await expect(page.getByText("OpenAI · not connected")).toBeVisible();
  await expect(page.getByRole("link", { name: "Connect in Settings" })).toBeVisible();

  // Name autosave: edit → Saved → persists across reload and back in the list. [3.2 AC1]
  await page.getByLabel("Agent name").fill("Portfolio agent");
  await expect(page.getByText("Saved")).toBeVisible({ timeout: 10000 });

  await page.reload();
  await expect(page.getByLabel("Agent name")).toHaveValue("Portfolio agent");

  await page.getByRole("link", { name: "Back to Agents" }).click();
  await expect(page).toHaveURL(/\/agents$/);
  await expect(page.getByText("Portfolio agent")).toBeVisible();
});
