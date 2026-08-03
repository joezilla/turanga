import { test, expect, type Page } from "@playwright/test";

// Requires the compose stack up (control-api :8080, postgres) seeded with the
// INITIAL_ADMIN_* creds from deploy/.env. Dev server runs on :5173 (same-site as
// :8080, so the SameSite=Lax session cookie flows with credentials: include).

const EMAIL = "admin@turanga.local";
const PASSWORD = "changeme-dev";

// Distinct x-forwarded-for per login so control-api's per-key login throttle (20/min) buckets each
// test separately — the whole serial suite exceeds 20 logins on one control-api process otherwise.
let signInSeq = 0;
async function signIn(page: Page) {
  await page.setExtraHTTPHeaders({ "x-forwarded-for": `e2e-health-${++signInSeq}` });
  await page.goto("/login");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/agents$/);
}

test("unauthenticated app routes redirect to /login", async ({ page }) => {
  await page.goto("/agents");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});

test("wrong credentials show a generic inline error and stay on /login", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill("wrong-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toHaveText("Email or password is incorrect.");
  await expect(page).toHaveURL(/\/login$/);
});

test("sign in lands on the shell and reaches the control plane (regression)", async ({ page }) => {
  await signIn(page);
  await expect(page.getByText("turanga", { exact: true })).toBeVisible();
  await expect(page.getByTestId("control-status")).toHaveText("control plane: connected", { timeout: 10000 });
  await expect(page.getByRole("link", { name: "Agents" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Settings" })).toBeVisible();
});

test("active nav highlights and navigation works", async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole("link", { name: "Agents" })).toHaveAttribute("aria-current", "page");
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings\/providers$/); // /settings redirects here (Story 2.1)
  await expect(page.getByRole("heading", { name: "Model providers" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Settings" })).toHaveAttribute("aria-current", "page");
});

test("theme toggle changes the background and persists across reload", async ({ page }) => {
  await signIn(page);
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
  expect(darkBg).not.toBe(lightBg);

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("logout returns to /login", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  // Session cleared: app routes redirect again.
  await page.goto("/agents");
  await expect(page).toHaveURL(/\/login$/);
});
