import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

export type Db = ReturnType<typeof drizzle<typeof schema>>;

export function createDb(connectionString: string) {
  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema });
  return { pool, db };
}
