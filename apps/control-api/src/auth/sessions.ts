import { randomBytes, createHash } from "node:crypto";

export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

export function newToken(): string {
  return randomBytes(32).toString("hex");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
