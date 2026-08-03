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
  // Empty state + the "Add a tool" affordance (active as of 6.2).
  await expect(page.getByText("No tools yet.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add a tool" })).toBeEnabled();
});

test("connecting a remote MCP tool verifies + discovers its operations (Story 6.2)", async ({ page }) => {
  await signIn(page);
  await page.goto("/settings/tools");

  // Open the connect form and point it at the in-network stub MCP server.
  await page.getByRole("button", { name: "Add a tool" }).click();
  await page.getByLabel("Name").fill("Stub MCP");
  await page.getByLabel("MCP server URL").fill("http://mcp-stub:9000/mcp");
  await page.getByRole("button", { name: "Connect" }).click();

  // control-api does a real MCP handshake against the stub → connected + its operations discovered.
  const card = page.locator("li.tool");
  await expect(card).toContainText("Stub MCP · connected", { timeout: 20000 });
  await expect(card).toContainText("echo");
  await expect(card).toContainText("get_time");
  // No credential was supplied → the "credential set" indicator is absent.
  await expect(card).not.toContainText("credential set");

  // Fail-closed: a bad URL surfaces the cause and persists nothing new.
  await page.getByRole("button", { name: "Add a tool" }).click();
  await page.getByLabel("Name").fill("Broken");
  await page.getByLabel("MCP server URL").fill("http://mcp-stub:9999/nope");
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByRole("alert")).toBeVisible({ timeout: 20000 });
  await expect(page.locator("li.tool")).toHaveCount(1); // only the good one persisted

  // Clean up so the pristine-DB assumption of the other tools test still holds on reruns.
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.locator("li.tool").getByRole("button", { name: "Remove" }).click(); // arm
  await page.locator("li.tool").getByRole("button", { name: "Remove" }).click(); // confirm
  await expect(page.getByText("No tools yet.")).toBeVisible();
});

test("attach a tool to an agent + grant an operation — persists (Story 6.3)", async ({ page }) => {
  await signIn(page);

  // Connect a tool to grant (reuse 6.2's flow).
  await page.goto("/settings/tools");
  await page.getByRole("button", { name: "Add a tool" }).click();
  await page.getByLabel("Name").fill("Grantable MCP");
  await page.getByLabel("MCP server URL").fill("http://mcp-stub:9000/mcp");
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.locator("li.tool")).toContainText("Grantable MCP · connected", { timeout: 20000 });

  // Create an agent and open it.
  await page.goto("/agents");
  await page.getByRole("button", { name: "Create agent" }).first().click();
  await page.locator("a.agent").first().click();
  await expect(page).toHaveURL(/\/agents\/[0-9A-Z]{26}$/);

  // The Tools section lists the connected tool via the picker; attach it (default-deny — no grant yet).
  const tools = page.locator("section", { has: page.getByRole("button", { name: "Tools" }) });
  await tools.getByRole("button", { name: "Add a tool" }).click();
  await page.getByRole("button", { name: "Grantable MCP" }).click();

  // Grant the `echo` operation (a checkbox per discovered operation).
  const echoGrant = tools.locator("label.op", { hasText: "echo" });
  await echoGrant.locator("input[type=checkbox]").check();
  await expect(page.getByText("Saved")).toBeVisible({ timeout: 10000 });

  // Reload → the grant persisted server-side (AD-7): echo checked, get_time not.
  await page.reload();
  await expect(tools.locator("label.op", { hasText: "echo" }).locator("input[type=checkbox]")).toBeChecked();
  await expect(tools.locator("label.op", { hasText: "get_time" }).locator("input[type=checkbox]")).not.toBeChecked();

  // Clean up the connected tool so the pristine-DB assumption holds on reruns.
  await page.goto("/settings/tools");
  await page.locator("li.tool").getByRole("button", { name: "Remove" }).click(); // arm
  await page.locator("li.tool").getByRole("button", { name: "Remove" }).click(); // confirm
  await expect(page.getByText("No tools yet.")).toBeVisible();
});

test("a run's tool call is recorded + surfaced as per-tool activity (Story 6.5)", async ({ page }) => {
  const CONTROL_API = "http://localhost:8080";
  await signIn(page);

  // Connect the stub tool.
  await page.goto("/settings/tools");
  await page.getByRole("button", { name: "Add a tool" }).click();
  await page.getByLabel("Name").fill("StubTime");
  await page.getByLabel("MCP server URL").fill("http://mcp-stub:9000/mcp");
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.locator("li.tool")).toContainText("StubTime · connected", { timeout: 20000 });

  // Create an agent and configure it (model + granted get_time) via the API for determinism.
  await page.goto("/agents");
  await page.getByRole("button", { name: "Create agent" }).first().click();
  await page.locator("a.agent").first().click();
  await expect(page).toHaveURL(/\/agents\/[0-9A-Z]{26}$/);
  const agentId = page.url().split("/").pop();
  // Resolve the tool id from the API (the card doesn't expose it in the DOM).
  const toolsRes = await page.request.get(`${CONTROL_API}/tools`);
  const tid = ((await toolsRes.json()) as { tools: { id: string; name: string }[] }).tools.find((t) => t.name === "StubTime")!.id;
  const patch = await page.request.patch(`${CONTROL_API}/agents/${agentId}`, {
    data: { model: "openai/gpt-4o", attachedTools: [{ toolId: tid, operations: ["get_time"] }] },
    headers: { "content-type": "application/json" },
  });
  expect(patch.ok()).toBeTruthy();

  // Run the agent until one run's tool call is recorded. The model call fails (bogus provider) but the
  // tool call runs in the sandbox + is recorded on the transcript. Retry absorbs the run-pipeline
  // cold-start flake (e.g. a LiteLLM cost-key mint that transiently fails right after a stack reset).
  let recorded = false;
  for (let attempt = 0; attempt < 5 && !recorded; attempt++) {
    const start = await page.request.post(`${CONTROL_API}/runs`, { data: { agentId, taskInput: "what time is it" }, headers: { "content-type": "application/json" } });
    const runId = ((await start.json()) as { run: { id: string } }).run.id;
    for (let i = 0; i < 30; i++) {
      const run = (await (await page.request.get(`${CONTROL_API}/runs/${runId}`)).json()) as { run: { status: string; transcript: { type: string }[] } };
      if (["succeeded", "failed", "killed"].includes(run.run.status)) {
        recorded = run.run.transcript.some((m) => m.type === "tool");
        break;
      }
      await page.waitForTimeout(500);
    }
  }
  expect(recorded, "a run should record a tool call (the run pipeline may be cold — retried)").toBeTruthy();

  // Reload the agent page → the Tools section shows the per-tool activity aggregated from the run (Story 6.5).
  await page.goto(`/agents/${agentId}`);
  const tools = page.locator("section", { has: page.getByRole("button", { name: "Tools" }) });
  await expect(tools.locator(".tool-activity")).toContainText("StubTime", { timeout: 10000 });
  await expect(tools.locator(".tool-activity")).toContainText(/call/);

  // Clean up every connected tool via the API (deterministic) so the pristine-DB assumption holds on reruns.
  const allTools = ((await (await page.request.get(`${CONTROL_API}/tools`)).json()) as { tools: { id: string }[] }).tools;
  for (const t of allTools) await page.request.delete(`${CONTROL_API}/tools/${t.id}`);
  await page.goto("/settings/tools");
  await expect(page.getByText("No tools yet.")).toBeVisible();
});

test("Data connections shows the not-configured state when no Google client is set", async ({ page }) => {
  await signIn(page);
  await page.goto("/settings/connections");
  await expect(page.getByRole("heading", { name: "Data connections" })).toBeVisible();
  await expect(page.getByText(/Google OAuth isn't configured/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect with Google" })).toHaveCount(0);
});
