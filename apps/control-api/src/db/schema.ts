import { pgTable, text, timestamp, jsonb } from "drizzle-orm/pg-core";

// users + sessions — the first control-api tables (AD-7: control-api owns this state).
export const users = pgTable("users", {
  id: text("id").primaryKey(), // ULID (@turanga/domain)
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(), // sha256(raw token) — never store the raw token
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Connections — model providers (Story 2.1) and later data connections (Story 2.2).
// The real provider API key lives ENCRYPTED in LiteLLM (AD-10), never here; we keep
// only key_last4 for the masked display.
export const connections = pgTable("connections", {
  id: text("id").primaryKey(), // ULID
  kind: text("kind").notNull(), // 'model-provider' (| 'data' later)
  provider: text("provider").notNull(), // 'openai' | 'anthropic' | 'openai-compatible'
  name: text("name").notNull(),
  baseUrl: text("base_url"),
  keyLast4: text("key_last4"),
  status: text("status").notNull(), // 'connected' | 'error' | 'unconfigured'
  lastError: text("last_error"),
  models: jsonb("models").$type<string[]>().notNull().default([]),
  litellmModelIds: jsonb("litellm_model_ids").$type<string[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Data connections (Story 2.2). The OAuth refresh token is stored ENCRYPTED at rest
// (enc_refresh_token, AES-256-GCM) — never returned to the browser; the egress-guard
// reads+decrypts it for credential injection in Epic 4 (AD-10 realization).
export const dataConnections = pgTable("data_connections", {
  id: text("id").primaryKey(), // ULID
  provider: text("provider").notNull(), // 'gmail'
  name: text("name").notNull(),
  accountEmail: text("account_email"),
  scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
  destinations: jsonb("destinations").$type<string[]>().notNull().default([]),
  status: text("status").notNull(), // 'connected' | 'error' | 'unconfigured'
  lastError: text("last_error"),
  encRefreshToken: text("enc_refresh_token"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Agents (Story 3.1). Minimal now — create + list + lifecycle state; model/instructions/
// skills/cost-caps land in Stories 3.2-3.5. control-api is the only writer (AD-7).
export const agents = pgTable("agents", {
  id: text("id").primaryKey(), // ULID
  name: text("name").notNull(),
  state: text("state").notNull(), // 'draft' | 'active' (LifecycleState)
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
