import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

export type Db = ReturnType<typeof drizzle<typeof schema>>;

export function createDb(connectionString: string) {
  const pool = new Pool({ connectionString });
  // An idle backend connection can error (Postgres restart / network drop). Without a
  // listener, node-postgres surfaces it as an unhandled 'error' and crashes the process.
  pool.on("error", (err) => {
    console.error("[control-api] postgres pool error:", err.message);
  });
  const db = drizzle(pool, { schema });
  return { pool, db };
}
