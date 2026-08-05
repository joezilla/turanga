import { test, expect, type Page } from "@playwright/test";

// Story 9.3 — the chat surface (web). Config-only: the actual send→reply STREAMING needs a real model
// provider (gated/manual in dev, like the test-console run happy-path), so these assert the nav +
// published-agent gate + conversation create/list + the thread's empty state + composer — NOT the live
// reply. Requires the live stack seeded with deploy/.env creds; the send/stream path is unit-covered (9.2).

const EMAIL = "admin@turanga.local";
const PASSWORD = "changeme-dev";
const CONTROL_API = "http://localhost:8080";
let signInSeq = 0;

async function signIn(page: Page) {
  await page.setExtraHTTPHeaders({ "x-forwarded-for": `e2e-chat-${++signInSeq}` });
  await page.goto("/login");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/agents$/);
}

async function createAgent(page: Page, name: string): Promise<string> {
  const created = await page.request.post(`${CONTROL_API}/agents`, { data: { name }, headers: { "content-type": "application/json" } });
  expect(created.ok()).toBeTruthy();
  return ((await created.json()) as { agent: { id: string } }).agent.id;
}

// Create a PUBLISHED agent via the API (create → set model → publish). page.request shares the cookie.
async function createPublishedAgent(page: Page, name: string): Promise<string> {
  const id = await createAgent(page, name);
  const patch = await page.request.patch(`${CONTROL_API}/agents/${id}`, { data: { model: "openai/gpt-4o" }, headers: { "content-type": "application/json" } });
  expect(patch.ok()).toBeTruthy();
  const pub = await page.request.post(`${CONTROL_API}/agents/${id}/publish`, {});
  expect(pub.ok()).toBeTruthy();
  return id;
}

test("the Chat nav item is enabled and /chat loads (Story 9.3)", async ({ page }) => {
  await signIn(page);
  // Chat was a disabled button; it is now a link. Scope to the nav landmark (agent rows on /agents may
  // also be links whose name contains "chat") + exact.
  const nav = page.getByRole("navigation", { name: "Workspace" });
  await expect(nav.getByRole("link", { name: "Chat", exact: true })).toBeVisible();
  await nav.getByRole("link", { name: "Chat", exact: true }).click();
  await expect(page).toHaveURL(/\/chat$/);
  // The default detail pane states the fact + points at the one action.
  await expect(page.getByText("Pick a conversation, or start a new one")).toBeVisible();
});

test("the chat picker shows only PUBLISHED agents (the publish gate)", async ({ page }) => {
  await signIn(page);
  const published = `chat-pub-${Date.now()}`;
  const draftOnly = `chat-draft-${Date.now()}`;
  await createPublishedAgent(page, published);
  await createAgent(page, draftOnly); // never published — must NOT be chattable

  await page.goto("/chat");
  const picker = page.getByLabel("Choose a published agent");
  await expect(picker).toBeVisible();
  // The published agent is an option; the draft-only agent is not.
  await expect(picker.locator("option", { hasText: published })).toHaveCount(1);
  await expect(picker.locator("option", { hasText: draftOnly })).toHaveCount(0);
});

test("start a conversation → the thread opens with the composer + empty-thread state (Story 9.3)", async ({ page }) => {
  await signIn(page);
  const name = `chat-flow-${Date.now()}`;
  await createPublishedAgent(page, name);

  await page.goto("/chat");
  await page.getByLabel("Choose a published agent").selectOption({ label: `${name} · v1` });

  // A published agent with no threads → the empty state (fact + one action).
  await expect(page.getByText("No conversations yet.")).toBeVisible();
  await page.getByRole("button", { name: "Start one" }).click();

  // Lands in the thread pane (URL is /chat/<conversationId>).
  await expect(page).toHaveURL(/\/chat\/[0-9A-Z]{26}$/);
  await expect(page.getByText("pinned v1")).toBeVisible(); // the pinned published version
  await expect(page.getByText("No messages yet. Send one to start the conversation.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  // The new conversation appears in the list column.
  await expect(page.locator("a.row", { hasText: "Untitled conversation" })).toHaveCount(1);
  // (Sending a message spawns a real run against the published version — the live reply needs a model
  //  provider, gated in e2e; the send→stream→reply path is unit-covered in 9.2.)
});

test("rename a conversation → the new title shows in the header + list (Story 9.4)", async ({ page }) => {
  await signIn(page);
  const name = `chat-rename-${Date.now()}`;
  await createPublishedAgent(page, name);
  await page.goto("/chat");
  await page.getByLabel("Choose a published agent").selectOption({ label: `${name} · v1` });
  await page.getByRole("button", { name: "Start one" }).click();
  await expect(page).toHaveURL(/\/chat\/[0-9A-Z]{26}$/);

  // Rename via the thread header.
  await page.getByRole("button", { name: "Rename" }).click();
  const input = page.getByLabel("Conversation title");
  await input.fill("Portfolio review");
  await page.getByRole("button", { name: "Save" }).click();
  // The header shows the new title (scope to the thread pane), and the list row updates via the chat bus.
  await expect(page.getByRole("main").getByText("Portfolio review")).toBeVisible();
  await expect(page.locator("a.row", { hasText: "Portfolio review" })).toHaveCount(1);
});

test("delete a conversation → it disappears from the list and navigates back to /chat (Story 9.4)", async ({ page }) => {
  await signIn(page);
  const name = `chat-del-${Date.now()}`;
  await createPublishedAgent(page, name);
  await page.goto("/chat");
  await page.getByLabel("Choose a published agent").selectOption({ label: `${name} · v1` });
  await page.getByRole("button", { name: "Start one" }).click();
  await expect(page).toHaveURL(/\/chat\/[0-9A-Z]{26}$/);
  await expect(page.locator("a.row", { hasText: "Untitled conversation" })).toHaveCount(1);

  // Delete (confirm) from the thread header.
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click(); // the confirm
  // Navigates back to the empty pane and the row is gone.
  await expect(page).toHaveURL(/\/chat$/);
  await expect(page.locator("a.row", { hasText: "Untitled conversation" })).toHaveCount(0);
});
