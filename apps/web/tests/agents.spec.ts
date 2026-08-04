import { test, expect, type Page } from "@playwright/test";

// Requires the live stack (control-api :8080 owns its `control` DB) seeded with deploy/.env
// creds. Serial (workers:1). All agent e2e live in this ONE file so order is guaranteed:
// the empty-state assertion (3.1) runs first on a fresh DB, before any test creates agents.
// Story 3.1: create + list + Draft. Story 3.2: the agent editor. The surface is now the design's
// master/detail workspace: a persistent list column, a tabbed editor, an explicit Save draft, a
// separate Publish, and the test console as a drawer.

const EMAIL = "admin@turanga.local";
const PASSWORD = "changeme-dev";

// Distinct x-forwarded-for per login so control-api's per-key login throttle (20/min) buckets each
// test separately — the whole serial suite exceeds 20 logins on one control-api process otherwise.
let signInSeq = 0;
async function signIn(page: Page) {
  await page.setExtraHTTPHeaders({ "x-forwarded-for": `e2e-agents-${++signInSeq}` });
  await page.goto("/login");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/agents$/);
}

// The design's agents workspace is master/detail: the list column is always present and "New"
// lands straight in the editor, so there is no separate list page to click through.
async function newAgent(page: Page) {
  await page.getByRole("button", { name: "New" }).click();
  await expect(page).toHaveURL(/\/agents\/[0-9A-Z]{26}$/);
}

// The test console is a drawer toggled from the editor header; opening it twice would close it.
async function openConsole(page: Page) {
  const input = page.getByLabel("Task for this test run");
  if (!(await input.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: "Test" }).click();
    await expect(input).toBeVisible();
  }
}

// Edits are explicit now: type, then Save draft. Publishing is a separate, later step.
// Wait on the dirty bar itself, not the button — the button relabels to "Saving…" the instant
// it's clicked, so asserting on the label would pass while the PATCH is still in flight.
async function saveDraft(page: Page) {
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.locator(".dirty-bar:not(.quiet)")).toHaveCount(0, { timeout: 10000 });
}

test("create an agent → it appears as a Draft row; the filter focuses on '/' and narrows", async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();

  // Empty state (fresh DB): fact + one action. [3.1 AC1]
  await expect(page.getByText("No agents yet.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Create the first one" })).toBeVisible();

  // Create an agent — this lands in the editor; the list column stays put.
  await page.getByRole("button", { name: "Create the first one" }).click();
  await expect(page).toHaveURL(/\/agents\/[0-9A-Z]{26}$/);

  // A row appears with a Draft status shown as dot + the word "draft".
  const rows = page.locator("a.row");
  await expect(rows.first()).toBeVisible();
  await expect(rows.first()).toContainText("Untitled agent");
  await expect(rows.first().locator(".state-word")).toContainText("draft");

  // The filter is present, "/" focuses it, and typing narrows the list.
  const filter = page.getByPlaceholder("Search agents");
  await expect(filter).toBeVisible();
  await page.keyboard.press("/");
  await expect(filter).toBeFocused();
  await filter.fill("no-such-agent-xyz");
  await expect(page.locator("a.row")).toHaveCount(0);
  await expect(page.getByText(/No agents match/)).toBeVisible();
});

test("open an agent → tabbed editor, disabled model selector, explicit save", async ({ page }) => {
  await signIn(page);

  // Open an agent from the persistent list column. [3.2 AC3]
  await page.locator("a.row").first().click();
  await expect(page).toHaveURL(/\/agents\/[0-9A-Z]{26}$/);

  // Four tabs over one definition; Definition is the landing tab. [design: Agent Management]
  for (const tab of ["Definition", "Tools", "Skills", "Limits"]) {
    await expect(page.getByRole("button", { name: new RegExp(`^${tab}`) })).toBeVisible();
  }

  // The test console is a drawer — closed until asked for. [4.2 AC2]
  await expect(page.getByText("No test runs.")).toHaveCount(0);
  await openConsole(page);
  await expect(page.getByText("No test runs.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Run test" })).toBeVisible();

  // No provider connected → selector disabled state + Connect in Settings. [3.2 AC2]
  await expect(page.getByText("OpenAI · not connected")).toBeVisible();
  await expect(page.getByRole("link", { name: "Connect in Settings" })).toBeVisible();

  // Editing raises the dirty bar; nothing is written until Save draft. [design: save model]
  await page.getByLabel("Agent name").fill("Portfolio agent");
  await expect(page.getByText(/unsaved change/)).toBeVisible();
  await saveDraft(page);

  await page.reload();
  await expect(page.getByLabel("Agent name")).toHaveValue("Portfolio agent");
  await expect(page.locator("a.row", { hasText: "Portfolio agent" })).toBeVisible();
});

test("draft → publish: the version chip advances and the unpublished marker clears", async ({ page }) => {
  await signIn(page);
  await newAgent(page);

  // Never published: the chip says so, and so does the quiet bar. [design: publish model]
  await expect(page.locator(".version")).toHaveText("unpublished");
  await expect(page.getByText("Never published")).toBeVisible();

  // Publish v1 → the chip becomes v1 and nothing is left to publish.
  await page.getByRole("button", { name: "Publish v1" }).click();
  await expect(page.locator(".version")).toHaveText("v1", { timeout: 10000 });
  await expect(page.getByRole("button", { name: "Publish v2" })).toBeDisabled();

  // Edit + save → one field is unpublished; publishing again lands v2.
  await page.getByLabel("Agent description").fill("Watches the portfolio.");
  await saveDraft(page);
  await expect(page.getByText(/not published/)).toBeVisible();
  await page.getByRole("button", { name: "Publish v2" }).click();
  await expect(page.locator(".version")).toHaveText("v2", { timeout: 10000 });

  // History lists both versions, newest first.
  await page.getByRole("button", { name: "History" }).click();
  await expect(page.locator(".history li").first()).toContainText("v2");
  await expect(page.locator(".history li").nth(1)).toContainText("v1");
});

test("duplicate copies the definition into a new, never-published draft", async ({ page }) => {
  await signIn(page);
  await newAgent(page);
  await page.getByLabel("Agent name").fill("Original agent");
  await saveDraft(page);
  await page.getByRole("button", { name: "Publish v1" }).click();
  await expect(page.locator(".version")).toHaveText("v1", { timeout: 10000 });

  await page.getByRole("button", { name: "Duplicate" }).click();
  await expect(page).toHaveURL(/\/agents\/[0-9A-Z]{26}$/);
  await expect(page.getByLabel("Agent name")).toHaveValue("Original agent copy");
  await expect(page.locator(".version")).toHaveText("unpublished"); // a copy inherits no version
});

test("instructions editor: variable-token, undefined-variable caution, popover, and autosave", async ({ page }) => {
  await signIn(page);

  // Fresh agent for this flow.
  await newAgent(page);

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

  // Save draft persists instructions + the variable across a reload. [3.3 AC1]
  await saveDraft(page);
  await page.reload();
  await expect(page.getByLabel("Instructions")).toHaveValue(/Summarize \{portfolio\} for me\.\{portfolio\}/);
  await expect(page.getByLabel("Variable name")).toHaveValue("portfolio");
});

test("skills: attach via picker, default-deny scope, off-by-default send, persist", async ({ page }) => {
  await signIn(page);
  await newAgent(page);

  // Skills moved to their own tab in the design's editor.
  await page.getByRole("button", { name: /^Skills/ }).click();

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

  // Save draft persists the attached skill + widened scope across reload. [3.4 AC1]
  await saveDraft(page);
  await page.reload();
  await page.getByRole("button", { name: /^Skills/ }).click();
  await expect(page.locator("li.chip", { hasText: "read/search" }).getByLabel("Permission scope")).toHaveValue("read");
  await expect(page.locator("li.chip", { hasText: "draft reply" })).toHaveCount(0);
});

test("cost caps: set per-run + per-day, persist, and block an invalid amount", async ({ page }) => {
  await signIn(page);
  await newAgent(page);

  // Caps live on the Limits tab now. [design: Agent Management]
  await page.getByRole("button", { name: /^Limits/ }).click();

  // Set both caps. [3.5 AC1]
  await page.getByLabel("Per-run cap").fill("0.50");
  await page.getByLabel("Per-day cap").fill("5.00");
  await saveDraft(page);

  // Both persist across reload. [3.5 AC1]
  await page.reload();
  await page.getByRole("button", { name: /^Limits/ }).click();
  await expect(page.getByLabel("Per-run cap")).toHaveValue("0.50");
  await expect(page.getByLabel("Per-day cap")).toHaveValue("5.00");

  // An invalid amount shows an inline error and is never sent. [3.5 AC2]
  await page.getByLabel("Per-run cap").fill("-1");
  await expect(page.getByText(/Enter a dollar amount/)).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: /^Limits/ }).click();
  await expect(page.getByLabel("Per-run cap")).toHaveValue("0.50"); // unchanged — the bad value wasn't saved
});

const CONTROL_API = "http://localhost:8080";

test("removing a provider surfaces dependent agents; agents list shows state + no meter for Draft", async ({ page }) => {
  await signIn(page);

  // Create an agent and set its model to openai/gpt-4o directly (no provider is connectable in
  // e2e to select from). page.request shares the browser session cookie. [3.6 AC2 setup]
  await newAgent(page);
  const agentId = page.url().split("/").pop();
  const patch = await page.request.patch(`${CONTROL_API}/agents/${agentId}`, {
    data: { model: "openai/gpt-4o" },
    headers: { "content-type": "application/json" },
  });
  expect(patch.ok()).toBeTruthy();

  // Agents list: the agent shows its Draft status and NO cost meter (meter is Active-only). [3.6 AC1]
  await page.goto("/agents");
  await expect(page.locator("a.row").first().locator(".state-word")).toContainText("draft");
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
  await newAgent(page);
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
  await openConsole(page);
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
  await openConsole(page);
  await page.getByLabel("Task for this test run").fill("again");
  await page.locator(".form").click(); // move focus off the input, into the editor
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(transcript.locator(".turn", { hasText: "again" })).toBeVisible({ timeout: 20000 });
  await expect(transcript.locator(".run-status")).toContainText("failed", { timeout: 20000 });
});

test("test pane: a scoped-skill agent's off-allowlist egress is refused inline (default-deny)", async ({ page }) => {
  await signIn(page);

  // Agent with a model + a Gmail-scoped skill (read) but no connected Gmail connection / no OAuth
  // configured → the harness attempts the read, the Guard has nothing provisioned, and refuses it
  // (default-deny). [4.3 AC2/AC3]
  await newAgent(page);
  const agentId = page.url().split("/").pop();
  const patch = await page.request.patch(`${CONTROL_API}/agents/${agentId}`, {
    data: { model: "openai/gpt-4o", skills: [{ skill: "read-search", scope: "read", send: false }] },
    headers: { "content-type": "application/json" },
  });
  expect(patch.ok()).toBeTruthy();
  await page.reload();

  await openConsole(page);
  await page.getByLabel("Task for this test run").fill("read my mail");
  await page.getByRole("button", { name: "Run test" }).click();

  // The blocked egress surfaces inline as a refusal row: destination + reason (not a red banner). [4.3 AC2]
  const transcript = page.locator(".transcript");
  await expect(transcript.locator(".refusal")).toContainText(/not on this agent's allowlist/, { timeout: 20000 });
  await expect(transcript.locator(".refusal")).toContainText("gmail.googleapis.com");
  // The run still resolves terminally (a blocked egress refuses that egress; it doesn't kill the run). [4.3]
  await expect(transcript.locator(".run-status")).toContainText(/failed|succeeded/, { timeout: 20000 });
});

test("test pane: an out-of-scope skill op is refused (permission), before any credential — no OAuth", async ({ page }) => {
  await signIn(page);

  // flag-label attached at scope `read` (below the read-write its label op needs) → the Guard
  // refuses on PERMISSION, ahead of the egress/credential check, so it's observable with no OAuth. [4.4 AC2]
  await newAgent(page);
  const agentId = page.url().split("/").pop();
  const patch = await page.request.patch(`${CONTROL_API}/agents/${agentId}`, {
    data: { model: "openai/gpt-4o", skills: [{ skill: "flag-label", scope: "read", send: false }] },
    headers: { "content-type": "application/json" },
  });
  expect(patch.ok()).toBeTruthy();
  await page.reload();

  await openConsole(page);
  await page.getByLabel("Task for this test run").fill("label my mail");
  await page.getByRole("button", { name: "Run test" }).click();

  const transcript = page.locator(".transcript");
  await expect(transcript.locator(".refusal")).toContainText(/not permitted to modify|read-write skill scope/, { timeout: 20000 });
  await expect(transcript.locator(".run-status")).toContainText(/failed|succeeded/, { timeout: 20000 });
});

test("test pane: draft-reply without a send grant → send refused, the run still produces its draft + completes", async ({ page }) => {
  await signIn(page);

  // draft-reply at read-write but with send OFF → the send op is refused (permission), while the
  // draft (the model's agent turn) is still produced and the run completes — no auto-send. [4.4 AC3, FR-18]
  await newAgent(page);
  const agentId = page.url().split("/").pop();
  const patch = await page.request.patch(`${CONTROL_API}/agents/${agentId}`, {
    data: { model: "openai/gpt-4o", skills: [{ skill: "draft-reply", scope: "read-write", send: false }] },
    headers: { "content-type": "application/json" },
  });
  expect(patch.ok()).toBeTruthy();
  await page.reload();

  await openConsole(page);
  await page.getByLabel("Task for this test run").fill("draft a reply");
  await page.getByRole("button", { name: "Run test" }).click();

  const transcript = page.locator(".transcript");
  // The send is refused (permission) with the recovery stated…
  await expect(transcript.locator(".refusal")).toContainText(/Blocked send|Allow send/, { timeout: 20000 });
  // …the draft artifact (the agent turn) is still produced, and the run resolves (no auto-send).
  await expect(transcript.locator(".turn-role", { hasText: "agent" })).toBeVisible();
  await expect(transcript.locator(".run-status")).toContainText(/failed|succeeded/, { timeout: 20000 });
});

test("test pane: cost meters — the metrics line carries a cost + the run/today meter renders (from the Guard callback)", async ({ page }) => {
  await signIn(page);

  // An agent with a model + both caps set → the per-run cost key is minted, the Guard reports cost
  // out-of-band, and the meter renders. (No provider key in dev → $0.0000, but the cost path is exercised.) [4.5 AC1/AC3]
  await newAgent(page);
  const agentId = page.url().split("/").pop();
  const patch = await page.request.patch(`${CONTROL_API}/agents/${agentId}`, {
    data: { model: "openai/gpt-4o", costCap: { perRun: { minor: 50, currency: "USD" }, perDay: { minor: 500, currency: "USD" } } },
    headers: { "content-type": "application/json" },
  });
  expect(patch.ok()).toBeTruthy();
  await page.reload();

  await openConsole(page);
  await page.getByLabel("Task for this test run").fill("hello");
  await page.getByRole("button", { name: "Run test" }).click();

  const transcript = page.locator(".transcript");
  await expect(transcript.locator(".run-status")).toContainText(/failed|succeeded/, { timeout: 20000 });
  // The metrics line carries a cost (Guard-reported, E4-AD-10) joined with the middot. [4.5 AC1]
  await expect(transcript.locator(".metrics")).toContainText(/ms · .* tokens · \$/, { timeout: 20000 });
  // The live meter shows run + today spend vs the caps. [4.5 AC1]
  await expect(transcript.locator(".cost-meter")).toContainText(/run \$.* \/ \$0\.50/);
  await expect(transcript.locator(".cost-meter")).toContainText(/today \$.* \/ \$5\.00/);
});

test("lifecycle: Activate is disabled with a stated reason until fully configured (5.1)", async ({ page }) => {
  await signIn(page);
  await newAgent(page);
  const agentId = page.url().split("/").pop();

  // A fresh Draft has no model + no caps → Activate is disabled with a stated reason. [5.1 AC1]
  await expect(page.getByRole("button", { name: "Activate" })).toBeDisabled();
  await expect(page.locator(".head-note")).toContainText("Select a model.");

  // Set model + both caps via the API → the only remaining blocker is the (unconnectable-in-dev)
  // provider, so Activate stays disabled with the provider reason. [5.1 AC1]
  const patch = await page.request.patch(`${CONTROL_API}/agents/${agentId}`, {
    data: { model: "openai/gpt-4o", costCap: { perRun: { minor: 50, currency: "USD" }, perDay: { minor: 500, currency: "USD" } } },
    headers: { "content-type": "application/json" },
  });
  expect(patch.ok()).toBeTruthy();
  await page.reload();
  await expect(page.getByRole("button", { name: "Activate" })).toBeDisabled();
  await expect(page.locator(".head-note")).toContainText(/provider isn't connected/);
  // (A full Activate click + the Deactivate confirm need a connected provider — gated/manual; the
  //  Draft↔Active transitions + the gate are proven by control-api unit tests.)
});

test("agents list is live — a newly created agent appears without a manual reload (polling, 5.2)", async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();

  // Create an agent out-of-band (API) while the list stays open — no navigation, no reload. The
  // visibility-aware poll (5s) must surface it on its own, which is what makes the list's live
  // Lifecycle State "live" (an agent activated/deactivated elsewhere reflects the same way). [5.2 AC1]
  const name = `poll-probe-${Date.now()}`;
  const created = await page.request.post(`${CONTROL_API}/agents`, {
    data: { name },
    headers: { "content-type": "application/json" },
  });
  expect(created.ok()).toBeTruthy();

  const row = page.locator("a.row", { hasText: name });
  await expect(row).toBeVisible({ timeout: 15000 }); // appears via the poll, NOT a reload
  // It's a Draft → dot + word "draft", and NO meter (the daily-spend meter is Active-only). [5.2 AC1]
  await expect(row.locator(".state-word")).toContainText("draft");
  await expect(row.locator(".meter")).toHaveCount(0);
  // (The live daily-spend meter on an Active agent needs a connected model provider to activate —
  //  gated/manual in dev, mirroring the run happy-path + 5.1 Activate. The meter markup + tone are
  //  unit-proven via meterTone; the batch spend read via sumTodayMicrosByAgent.)
});

test("run history: empty state, then a completed run is listed and reviewable with its outcome + transcript (5.3)", async ({ page }) => {
  await signIn(page);
  await newAgent(page);
  const agentUrl = page.url();
  const agentId = agentUrl.split("/").pop();

  // A fresh agent has no runs → the history is the empty state. [5.3 AC1]
  await page.getByRole("link", { name: "Runs" }).click();
  await expect(page).toHaveURL(/\/agents\/[0-9A-Z]{26}\/runs$/);
  await expect(page.getByText("No runs yet.")).toBeVisible();

  // Give it a model + caps and run a Test so a run persists (dev has no provider key → the run
  // resolves failed, which is exactly a case AC2 wants legible).
  const patch = await page.request.patch(`${CONTROL_API}/agents/${agentId}`, {
    data: { model: "openai/gpt-4o", costCap: { perRun: { minor: 50, currency: "USD" }, perDay: { minor: 500, currency: "USD" } } },
    headers: { "content-type": "application/json" },
  });
  expect(patch.ok()).toBeTruthy();
  await page.goto(agentUrl);
  await openConsole(page);
  await page.getByLabel("Task for this test run").fill("history-probe");
  await page.getByRole("button", { name: "Run test" }).click();
  await expect(page.locator(".transcript .run-status")).toContainText(/failed|succeeded/, { timeout: 20000 });

  // Open Run history via the header link → the run is listed newest-first with its OUTCOME (dot +
  // word), a mono cost, and the task. [5.3 AC1/AC2]
  await page.getByRole("link", { name: "Runs" }).click();
  await expect(page).toHaveURL(/\/agents\/[0-9A-Z]{26}\/runs$/);
  const row = page.locator("a.run").first();
  await expect(row).toBeVisible();
  await expect(row.locator(".run-status")).toContainText(/failed|succeeded/); // outcome legible (AC2)
  await expect(row.locator(".cost")).toContainText("$"); // cost, mono
  await expect(row.locator(".task")).toContainText("history-probe");

  // Open the review → the persisted run's outcome + task + transcript render. [5.3 AC1/AC2]
  await row.click();
  await expect(page).toHaveURL(/\/agents\/[0-9A-Z]{26}\/runs\/[0-9A-Z]{26}$/);
  await expect(page.locator(".outcome .run-status")).toContainText(/failed|succeeded/); // outcome (AC2)
  await expect(page.locator(".task-text")).toContainText("history-probe"); // what it was asked (AC1)
  await expect(page.locator(".transcript")).toBeVisible(); // the transcript record (AC1)
  // AC2 cause legibility: a failed/killed run must always render a cause (the persisted reason or an
  //  honest fallback — never blank). Asserted whenever the dev run resolved failed/killed.
  const outcome = (await page.locator(".outcome .run-status").textContent()) ?? "";
  if (/failed|killed/.test(outcome)) {
    await expect(page.locator(".reason")).toBeVisible();
    await expect(page.locator(".reason")).not.toBeEmpty();
  }
  // (A killed-by-cap-breach review needs real spend > cap — a real model call — so the cap-breach
  //  cause string is unit-proven via the orchestrator killReason + runCause; the failed-run cause
  //  fallback is unit-proven via runCause and asserted above when the dev run fails.)
});
