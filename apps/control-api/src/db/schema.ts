import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

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
