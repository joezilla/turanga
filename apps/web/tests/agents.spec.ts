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

  // Two-pane surface: the Model section + the test pane (empty state). [3.2 AC1 / 4.2 AC2]
  await expect(page.getByRole("button", { name: "Model" })).toBeVisible();
  await expect(page.getByText("No test runs.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Run test" })).toBeVisible();

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

test("skills: attach via picker, default-deny scope, off-by-default send, persist", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Create agent" }).first().click();
  await page.locator("a.agent").first().click();
  await expect(page).toHaveURL(/\/agents\/[0-9A-Z]{26}$/);

  // Attach read/search via the searchable picker → a rectangular chip. [3.4 AC1]
  await page.getByRole("button", { name: "Add skill" }).click();
  await page.getByRole("button", { name: "read/search" }).click();
  const readChip = page.locator("li.chip", { hasText: "read/search" });
  await expect(readChip).toBeVisible();
  // Scope defaults to No access (deny) and there's no send control for a non-outbound skill. [3.4 AC2/AC3]
  await expect(readChip.getByLabel("Permission scope")).toHaveValue("none");
  await expect(readChip.getByText("Allow send")).toHaveCount(0);

  // Attach draft reply → it carries an Allow-send control that is OFF by default. [3.4 AC3]
  await page.getByRole("button", { name: "Add skill" }).click();
  await page.getByRole("button", { name: "draft reply" }).click();
  const draftChip = page.locator("li.chip", { hasText: "draft reply" });
  await expect(draftChip.getByLabel("Allow send")).not.toBeChecked();

  // Widen read/search to Read; remove draft reply. [3.4 AC2]
  await readChip.getByLabel("Permission scope").selectOption("read");
  await draftChip.getByRole("button", { name: "Remove draft reply" }).click();
  await expect(page.locator("li.chip", { hasText: "draft reply" })).toHaveCount(0);

  // Autosave persists the attached skill + widened scope across reload. [3.4 AC1]
  await expect(page.getByText("Saved")).toBeVisible({ timeout: 10000 });
  await page.reload();
  await expect(page.locator("li.chip", { hasText: "read/search" }).getByLabel("Permission scope")).toHaveValue("read");
  await expect(page.locator("li.chip", { hasText: "draft reply" })).toHaveCount(0);
});

test("cost caps: set per-run + per-day, persist, and block an invalid amount", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Create agent" }).first().click();
  await page.locator("a.agent").first().click();
  await expect(page).toHaveURL(/\/agents\/[0-9A-Z]{26}$/);

  // Set both caps. [3.5 AC1]
  await page.getByLabel("Per-run cap").fill("0.50");
  await page.getByLabel("Per-day cap").fill("5.00");
  await expect(page.getByText("Saved")).toBeVisible({ timeout: 10000 });

  // Both persist across reload. [3.5 AC1]
  await page.reload();
  await expect(page.getByLabel("Per-run cap")).toHaveValue("0.50");
  await expect(page.getByLabel("Per-day cap")).toHaveValue("5.00");

  // An invalid amount shows an inline error and does not persist. [3.5 AC2]
  await page.getByLabel("Per-run cap").fill("-1");
  await expect(page.getByText(/Enter a dollar amount/)).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Per-run cap")).toHaveValue("0.50"); // unchanged — the bad value wasn't saved
});

const CONTROL_API = "http://localhost:8080";

test("removing a provider surfaces dependent agents; agents list shows state + no meter for Draft", async ({ page }) => {
  await signIn(page);

  // Create an agent and set its model to openai/gpt-4o directly (no provider is connectable in
  // e2e to select from). page.request shares the browser session cookie. [3.6 AC2 setup]
  await page.getByRole("button", { name: "Create agent" }).first().click();
  await page.locator("a.agent").first().click();
  await expect(page).toHaveURL(/\/agents\/[0-9A-Z]{26}$/);
  const agentId = page.url().split("/").pop();
  const patch = await page.request.patch(`${CONTROL_API}/agents/${agentId}`, {
    data: { model: "openai/gpt-4o" },
    headers: { "content-type": "application/json" },
  });
  expect(patch.ok()).toBeTruthy();

  // Agents list: the agent shows its Draft status and NO cost meter (meter is Active-only). [3.6 AC1]
  await page.goto("/agents");
  await expect(page.locator("a.agent").first().locator(".status-dot")).toContainText("draft");
  await expect(page.locator(".meter")).toHaveCount(0);

  // Connect a bogus OpenAI provider (created with error status, still removable).
  await page.goto("/settings/providers");
  await page.getByLabel("API key").fill("sk-bogus-key-should-401");
  await page.getByRole("button", { name: "Connect provider" }).click();
  const card = page.locator("li.provider");
  await expect(card).toContainText("OpenAI · error", { timeout: 20000 });

  // Arm Remove → the dependent agent is surfaced before confirming. [3.6 AC2]
  await card.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText(/uses it/)).toBeVisible();
  await expect(page.getByText(/have no model/)).toBeVisible();

  // Cancel keeps the provider; Remove then deletes it.
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Remove" }).click(); // arm
  await card.getByRole("button", { name: "Remove" }).click(); // confirm
  await expect(page.getByText("No providers connected.")).toBeVisible();
});

test("test pane: stream a run → user turn, failed dot + agent turn + mono metrics; Cmd+Enter + Clear", async ({ page }) => {
  await signIn(page);

  // A fresh agent with a model set so a run can launch (no provider key → the model call fails,
  // which still streams end-to-end and resolves to a `failed` run-status dot). [4.2 AC1]
  await page.getByRole("button", { name: "Create agent" }).first().click();
  await page.locator("a.agent").first().click();
  await expect(page).toHaveURL(/\/agents\/[0-9A-Z]{26}$/);
  const agentId = page.url().split("/").pop();
  const patch = await page.request.patch(`${CONTROL_API}/agents/${agentId}`, {
    data: { model: "openai/gpt-4o" },
    headers: { "content-type": "application/json" },
  });
  expect(patch.ok()).toBeTruthy();
  await page.reload();

  // Empty state. [4.2 AC2]
  await expect(page.getByText("No test runs.")).toBeVisible();

  // Type a task and Run test → a user turn streams in, then the run resolves to a failed
  // run-status dot + word with an agent turn (the model error) and a mono metrics line. [4.2 AC1]
  await page.getByLabel("Task for this test run").fill("say hello");
  await page.getByRole("button", { name: "Run test" }).click();

  const transcript = page.locator(".transcript");
  await expect(transcript.locator(".turn", { hasText: "say hello" })).toBeVisible({ timeout: 20000 });
  // Resolves to a failed run-status dot + word (dot + text, never colour-only). [4.2 AC1]
  await expect(transcript.locator(".run-status")).toContainText("failed", { timeout: 20000 });
  // An agent turn (the model error) + a mono metrics line (latency · tokens). [4.2 AC1]
  await expect(transcript.getByText("agent")).toBeVisible();
  await expect(transcript.locator(".metrics")).toContainText(/ms · .*tokens/);

  // Clear resets the pane to the empty state. [4.2 AC3]
  await page.getByRole("button", { name: "Clear" }).click();
  await expect(page.getByText("No test runs.")).toBeVisible();

  // Cmd/Ctrl+Enter runs from anywhere in the editor. [4.2 AC1]
  await page.getByLabel("Task for this test run").fill("again");
  await page.locator(".config").click(); // move focus off the input, into the editor
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(transcript.locator(".turn", { hasText: "again" })).toBeVisible({ timeout: 20000 });
  await expect(transcript.locator(".run-status")).toContainText("failed", { timeout: 20000 });
});
