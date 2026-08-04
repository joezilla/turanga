import { eq, sql, lte, and, ne } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { users, sessions } from "../db/schema.js";

export interface UserRow {
  id: string;
  email: string;
  passwordHash: string;
}
export interface NewSession {
  id: string;
  tokenHash: string;
  userId: string;
  expiresAt: Date;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface AuthRepo {
  findUserByEmail(email: string): Promise<UserRow | null>;
  userCount(): Promise<number>;
  createUser(u: UserRow): Promise<void>;
  createSession(s: NewSession): Promise<void>;
  /** Returns the session's user if the session exists and is not expired. */
  findSessionUser(tokenHash: string, now: Date): Promise<{ id: string; email: string } | null>;
  deleteSession(tokenHash: string): Promise<void>;
  deleteExpiredSessions(now: Date): Promise<void>;
  /** Replace a user's password hash (account settings). */
  updatePassword(userId: string, passwordHash: string): Promise<void>;
  /** Drop every session for a user except the one making the change — a password change
   *  must not leave a stolen session alive. */
  deleteUserSessionsExcept(userId: string, keepTokenHash: string): Promise<void>;
}

export function drizzleAuthRepo(db: Db): AuthRepo {
  return {
    async findUserByEmail(email) {
      const rows = await db.select().from(users).where(eq(users.email, email)).limit(1);
      const u = rows[0];
      return u ? { id: u.id, email: u.email, passwordHash: u.passwordHash } : null;
    },
    async userCount() {
      const rows = await db.select({ c: sql<number>`count(*)::int` }).from(users);
      return rows[0]?.c ?? 0;
    },
    async createUser(u) {
      await db.insert(users).values({ id: u.id, email: u.email, passwordHash: u.passwordHash }).onConflictDoNothing();
    },
    async createSession(s) {
      await db.insert(sessions).values(s);
    },
    async findSessionUser(tokenHash, now) {
      const rows = await db
        .select({ id: users.id, email: users.email, expiresAt: sessions.expiresAt })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(eq(sessions.tokenHash, tokenHash))
        .limit(1);
      const r = rows[0];
      if (!r || r.expiresAt.getTime() <= now.getTime()) return null;
      return { id: r.id, email: r.email };
    },
    async deleteSession(tokenHash) {
      await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
    },
    async deleteExpiredSessions(now) {
      await db.delete(sessions).where(lte(sessions.expiresAt, now));
    },
    async updatePassword(userId, passwordHash) {
      await db.update(users).set({ passwordHash }).where(eq(users.id, userId));
    },
    async deleteUserSessionsExcept(userId, keepTokenHash) {
      await db.delete(sessions).where(and(eq(sessions.userId, userId), ne(sessions.tokenHash, keepTokenHash)));
    },
  };
}

export function memoryAuthRepo(): AuthRepo {
  const byId = new Map<string, UserRow>();
  const byEmail = new Map<string, UserRow>();
  const sess = new Map<string, NewSession>();
  return {
    async findUserByEmail(email) {
      return byEmail.get(email) ?? null;
    },
    async userCount() {
      return byEmail.size;
    },
    async createUser(u) {
      byId.set(u.id, u);
      byEmail.set(u.email, u);
    },
    async createSession(s) {
      sess.set(s.tokenHash, s);
    },
    async findSessionUser(tokenHash, now) {
      const s = sess.get(tokenHash);
      if (!s || s.expiresAt.getTime() <= now.getTime()) return null;
      const u = byId.get(s.userId);
      return u ? { id: u.id, email: u.email } : null;
    },
    async deleteSession(tokenHash) {
      sess.delete(tokenHash);
    },
    async deleteExpiredSessions(now) {
      for (const [k, v] of sess) if (v.expiresAt.getTime() <= now.getTime()) sess.delete(k);
    },
    async updatePassword(userId, passwordHash) {
      const u = byId.get(userId);
      if (!u) return;
      const next = { ...u, passwordHash };
      byId.set(u.id, next);
      byEmail.set(u.email, next);
    },
    async deleteUserSessionsExcept(userId, keepTokenHash) {
      for (const [k, v] of sess) if (v.userId === userId && k !== keepTokenHash) sess.delete(k);
    },
  };
}
