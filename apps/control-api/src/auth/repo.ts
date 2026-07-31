import { eq, sql } from "drizzle-orm";
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

export interface AuthRepo {
  findUserByEmail(email: string): Promise<UserRow | null>;
  userCount(): Promise<number>;
  createUser(u: UserRow): Promise<void>;
  createSession(s: NewSession): Promise<void>;
  /** Returns the session's user email if the session exists and is not expired. */
  findSessionUser(tokenHash: string, now: Date): Promise<{ email: string } | null>;
  deleteSession(tokenHash: string): Promise<void>;
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
      await db.insert(users).values({ id: u.id, email: u.email, passwordHash: u.passwordHash });
    },
    async createSession(s) {
      await db.insert(sessions).values(s);
    },
    async findSessionUser(tokenHash, now) {
      const rows = await db
        .select({ email: users.email, expiresAt: sessions.expiresAt })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(eq(sessions.tokenHash, tokenHash))
        .limit(1);
      const r = rows[0];
      if (!r || r.expiresAt.getTime() <= now.getTime()) return null;
      return { email: r.email };
    },
    async deleteSession(tokenHash) {
      await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
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
      return u ? { email: u.email } : null;
    },
    async deleteSession(tokenHash) {
      sess.delete(tokenHash);
    },
  };
}
