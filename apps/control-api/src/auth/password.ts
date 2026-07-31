import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";

// argon2id is @node-rs/argon2's default variant. OWASP baseline params:
// 19 MiB memory, 2 iterations, parallelism 1.
const OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return argonHash(password, OPTS);
}

export function verifyPassword(hash: string, password: string): Promise<boolean> {
  return argonVerify(hash, password); // params read from the encoded hash
}

// A stable decoy hash so an unknown-email login still runs one argon2 verify —
// equalizes response time and prevents user enumeration by timing.
let decoy: string | null = null;
export async function decoyHash(): Promise<string> {
  if (!decoy) decoy = await hashPassword("unused-decoy-password-for-constant-time");
  return decoy;
}
