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

test("instructions editor: variable-token, undefined-variable caution, popover, and autosave", async ({ page }) => {
  await signIn(page);

  // Fresh agent for this flow.
  await page.getByRole("button", { name: "Create agent" }).first().click();
  await page.locator("a.agent").first().click();
  await expect(page).toHaveURL(/\/agents\/[0-9A-Z]{26}$/);

  // Type instructions referencing an undefined variable. [3.3 AC1 + AC2]
  await page.getByLabel("Instructions").fill("Summarize {portfolio} for me.");
  await expect(page.locator(".token")).toHaveText("{portfolio}"); // signal-tinted token renders
  await expect(page.getByText(/undefined variable/)).toBeVisible(); // caution hint

  // Define the variable → the caution clears. [3.3 AC2]
  await page.getByRole("button", { name: "Add variable" }).click();
  await page.getByLabel("Variable name").fill("portfolio");
  await expect(page.getByText(/undefined variable/)).toHaveCount(0);

  // Typing `{` opens the variable-insert popover, now listing `portfolio`. [3.3 AC1]
  const editor = page.getByLabel("Instructions");
  await editor.click();
  await page.keyboard.press("End");
  await page.keyboard.type("{");
  const popover = page.getByRole("listbox", { name: "Insert a variable" });
  await expect(popover).toBeVisible();
  await expect(popover.getByRole("option", { name: "portfolio" })).toBeVisible();
  // Keyboard-select the highlighted option → inserts `{portfolio}` and closes the popover. [3.3 AC1 keyboard-navigable]
  await page.keyboard.press("Enter");
  await expect(popover).toHaveCount(0);
  await expect(editor).toHaveValue(/\{portfolio\}.*\{portfolio\}$/);

  // Autosave persists instructions + the variable across a reload. [3.3 AC1]
  await expect(page.getByText("Saved")).toBeVisible({ timeout: 10000 });
  await page.reload();
  await expect(page.getByLabel("Instructions")).toHaveValue(/Summarize \{portfolio\} for me\.\{portfolio\}/);
  await expect(page.getByLabel("Variable name")).toHaveValue("portfolio");
});
