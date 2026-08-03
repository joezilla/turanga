import { test, expect, type Page } from "@playwright/test";

// Requires the live stack (control-api :8080 + litellm) seeded with deploy/.env creds.
// No real provider key needed: a bogus key gets a real 401 from the provider → error card.

const EMAIL = "admin@turanga.local";
const PASSWORD = "changeme-dev";

// Distinct x-forwarded-for per login so control-api's per-key login throttle (20/min) buckets each
// test separately — the whole serial suite exceeds 20 logins on one control-api process otherwise.
let signInSeq = 0;
async function signIn(page: Page) {
  await page.setExtraHTTPHeaders({ "x-forwarded-for": `e2e-providers-${++signInSeq}` });
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

test("openai-compatible connect discovers models instead of manual typing (Story 2.4)", async ({ page }) => {
  await signIn(page);
  await page.goto("/settings/providers");
  await page.getByLabel("Provider").selectOption("openai-compatible");

  // The error-prone manual "Models (comma-separated)" field is gone — discovery replaces it.
  await expect(page.getByText("Models (comma-separated)")).toHaveCount(0);

  // A Discover button is present, disabled until the base URL + key are set.
  const discover = page.getByRole("button", { name: "Discover models" });
  await expect(discover).toBeVisible();
  await expect(discover).toBeDisabled();
  // Connect is gated until at least one discovered model is selected.
  await expect(page.getByRole("button", { name: "Connect provider" })).toBeDisabled();

  // Entering the base URL + key enables discovery (the actual /models fetch needs a real endpoint —
  // gated/manual, like the run/OAuth paths).
  await page.getByLabel("Base URL").fill("https://example.invalid/v1");
  await page.getByLabel("API key").fill("sk-test-key");
  await expect(discover).toBeEnabled();
});

test("Settings → Tools shows the tools management surface + empty state (Story 6.1)", async ({ page }) => {
  await signIn(page);
  await page.goto("/settings");
  // The Tools tab is in the Settings sub-nav.
  await page.getByRole("link", { name: "Tools", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/tools$/);
  await expect(page.getByRole("heading", { name: "Tools" })).toBeVisible();
  // Empty state + the "Add a tool" affordance (disabled — connecting tools ships in 6.2).
  await expect(page.getByText("No tools yet.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add a tool" })).toBeDisabled();
});

test("Data connections shows the not-configured state when no Google client is set", async ({ page }) => {
  await signIn(page);
  await page.goto("/settings/connections");
  await expect(page.getByRole("heading", { name: "Data connections" })).toBeVisible();
  await expect(page.getByText(/Google OAuth isn't configured/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect with Google" })).toHaveCount(0);
});
