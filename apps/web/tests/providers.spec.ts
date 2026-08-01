import { test, expect, type Page } from "@playwright/test";

// Requires the live stack (control-api :8080 + litellm) seeded with deploy/.env creds.
// No real provider key needed: a bogus key gets a real 401 from the provider → error card.

const EMAIL = "admin@turanga.local";
const PASSWORD = "changeme-dev";

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/agents$/);
}

test("Settings redirects to Model providers and shows the sub-nav + empty state", async ({ page }) => {
  await signIn(page);
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/settings\/providers$/);
  await expect(page.getByRole("heading", { name: "Model providers" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Data connections" })).toBeVisible();
  await expect(page.getByText("No providers connected.")).toBeVisible();
});

test("connecting with a bad key shows an error card, and Remove clears it", async ({ page }) => {
  await signIn(page);
  await page.goto("/settings/providers");

  await page.getByLabel("API key").fill("sk-bogus-key-should-401");
  await page.getByRole("button", { name: "Connect provider" }).click();

  // control-api verifies provider-direct → real 401 → status error with a cause.
  const card = page.locator("li.provider");
  await expect(card).toContainText("OpenAI · error", { timeout: 20000 });
  await expect(card).toContainText("HTTP 401");

  await page.getByRole("button", { name: "Remove" }).click(); // arm confirm
  await page.getByRole("button", { name: "Remove" }).click(); // confirm
  await expect(page.getByText("No providers connected.")).toBeVisible();
});
