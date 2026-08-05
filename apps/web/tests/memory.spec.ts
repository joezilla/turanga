import { test, expect, type Page } from "@playwright/test";

// Story 8.2 — the memory config surface (Settings → Memory + the per-agent Memory tab). Config-only:
// no model call, so these are NOT run-dependent (unlike the test-pane specs). Requires the live stack
// seeded with deploy/.env creds; runs against a fresh e2e DB (memory ships OFF by default).

const EMAIL = "admin@turanga.local";
const PASSWORD = "changeme-dev";

let signInSeq = 0;
async function signIn(page: Page) {
  await page.setExtraHTTPHeaders({ "x-forwarded-for": `e2e-memory-${++signInSeq}` });
  await page.goto("/login");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/agents$/);
}

async function newAgent(page: Page) {
  await page.getByRole("button", { name: "New" }).click();
  await expect(page).toHaveURL(/\/agents\/[0-9A-Z]{26}$/);
}

async function saveDraft(page: Page) {
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.locator(".dirty-bar:not(.quiet)")).toHaveCount(0, { timeout: 10000 });
}

test("Settings → Memory: off by default, and the 'remember by default' toggle persists (Story 8.2 AC1)", async ({ page }) => {
  await signIn(page);
  await page.goto("/settings");

  // The Memory sub-nav entry exists and opens the surface.
  await page.getByRole("link", { name: "Memory" }).click();
  await expect(page).toHaveURL(/\/settings\/memory$/);
  await expect(page.getByRole("heading", { name: "Memory" })).toBeVisible();

  // Off by default — the platform status line says so (dot + word, NFR-6). Exact text so it doesn't
  // also match the layout blurb, which ends "…Off by default.".
  const offStatus = "Off by default — enable memory per agent, or flip the default";
  await expect(page.getByText(offStatus)).toBeVisible();

  // Flip "New agents remember by default" on. The switch reflects the SERVER config, which updates only
  // after the PATCH round-trips — so click once and poll (not .check(), which retries against the lagging
  // controlled state). Assert on the switch state, the real persistence contract (the status word also
  // labels the card, so it's not a unique locator).
  const defaultToggle = page.getByRole("switch", { name: "Toggle the default for new agents" });
  await defaultToggle.click();
  await expect(defaultToggle).toBeChecked();

  // Persists across a reload (control-api is the sole writer).
  await page.reload();
  await expect(page.getByRole("switch", { name: "Toggle the default for new agents" })).toBeChecked();

  // Restore the off default so the rest of the suite sees a clean platform state.
  await page.getByRole("switch", { name: "Toggle the default for new agents" }).click();
  await expect(page.getByText(offStatus)).toBeVisible();
});

test("agent editor Memory tab: set on + toggle reflect + a kind, Save draft persists, no publish marker (Story 8.2 AC2/AC3)", async ({ page }) => {
  await signIn(page);
  await newAgent(page);

  // Open the Memory tab (fifth section, next to Limits).
  await page.getByRole("button", { name: /^Memory/ }).click();
  await expect(page.getByText(/Off by default — the global default is/)).toBeVisible();

  // Effective off while inherit + global-off.
  await expect(page.getByText(/Effectively off/)).toBeVisible();

  // Turn this agent On → effective flips to on.
  await page.getByRole("button", { name: "On", exact: true }).click();
  await expect(page.getByText(/Effectively on/)).toBeVisible();

  // Turn reflect off and drop the "procedure" kind.
  await page.getByRole("checkbox", { name: /Reflect/ }).uncheck();
  await page.getByRole("checkbox", { name: /Procedure/ }).uncheck();

  // Memory is operational, so the dirty bar is the "unsaved" (typed-not-saved) kind — save it.
  await expect(page.getByText(/unsaved change/)).toBeVisible();
  await saveDraft(page);

  // Editing memory is NOT a publishable change — it must not raise the "unpublished/not published" marker.
  await expect(page.getByText(/not published/)).toHaveCount(0);

  // Persists across a reload.
  await page.reload();
  await page.getByRole("button", { name: /^Memory/ }).click();
  await expect(page.getByRole("button", { name: "On", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("checkbox", { name: /Reflect/ })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: /Procedure/ })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: /Recall/ })).toBeChecked();
});

test("agent header links to a Memory page that shows the empty state for a fresh agent (Story 8.5)", async ({ page }) => {
  await signIn(page);
  await newAgent(page);
  const url = page.url(); // /agents/<id>

  // The header has a Memory link (next to Runs) → the per-agent memory page.
  await page.getByRole("link", { name: "Memory", exact: true }).click();
  await expect(page).toHaveURL(/\/agents\/[0-9A-Z]{26}\/memory$/);
  await expect(page.getByRole("heading", { name: "Memory", level: 1 })).toBeVisible();
  // A brand-new agent has learned nothing yet (nothing writes memory until reflection runs).
  await expect(page.getByText("This agent hasn't learned anything yet.")).toBeVisible();

  // Back arrow returns to the agent editor.
  await page.getByLabel("Back to agent").click();
  await expect(page).toHaveURL(url);
});

test("Settings → Memory: the 'require approval by default' toggle persists (Story 8.6)", async ({ page }) => {
  await signIn(page);
  await page.goto("/settings/memory");
  await expect(page.getByRole("heading", { name: "Memory" })).toBeVisible();

  // Off by default; flip it on and confirm the server-backed switch state (poll, don't .check()).
  const approvalToggle = page.getByRole("switch", { name: "Toggle require-approval by default" });
  await expect(approvalToggle).not.toBeChecked();
  await approvalToggle.click();
  await expect(approvalToggle).toBeChecked();

  // Persists across a reload (control-api is the sole writer, AD-7).
  await page.reload();
  await expect(page.getByRole("switch", { name: "Toggle require-approval by default" })).toBeChecked();

  // Restore the off default so the rest of the suite sees a clean platform state.
  await page.getByRole("switch", { name: "Toggle require-approval by default" }).click();
  await expect(page.getByRole("switch", { name: "Toggle require-approval by default" })).not.toBeChecked();
});

test("agent editor Memory tab: the per-agent 'Require my approval' checkbox persists (Story 8.6)", async ({ page }) => {
  await signIn(page);
  await newAgent(page);

  await page.getByRole("button", { name: /^Memory/ }).click();
  // Turn the agent On so the flags are live, then require approval.
  await page.getByRole("button", { name: "On", exact: true }).click();
  await expect(page.getByText(/Effectively on/)).toBeVisible();

  await page.getByRole("checkbox", { name: /Require my approval/ }).check();
  await saveDraft(page);

  // Persists across a reload.
  await page.reload();
  await page.getByRole("button", { name: /^Memory/ }).click();
  await expect(page.getByRole("checkbox", { name: /Require my approval/ })).toBeChecked();
});

test("Memory page: the learning-history changelog opens and is empty for a fresh agent (Story 8.6)", async ({ page }) => {
  await signIn(page);
  await newAgent(page);

  await page.getByRole("link", { name: "Memory", exact: true }).click();
  await expect(page).toHaveURL(/\/agents\/[0-9A-Z]{26}\/memory$/);

  // The changelog is collapsed by default; opening it loads the (empty) history for a fresh agent.
  await page.getByRole("button", { name: /Learning history/ }).click();
  await expect(page.getByText("No changes recorded yet.")).toBeVisible();
});
