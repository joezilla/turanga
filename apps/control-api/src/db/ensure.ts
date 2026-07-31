import { Client } from "pg";

// Make control-api self-sufficient: if its target database doesn't exist yet (e.g. an
// older pgdata volume that predates the init script), create it. Connects to the default
// "postgres" maintenance database to do so.
export async function ensureDatabase(connectionString: string): Promise<void> {
  const target = new URL(connectionString);
  const dbName = decodeURIComponent(target.pathname.replace(/^\//, ""));
  if (!dbName) return;

  const admin = new URL(connectionString);
  admin.pathname = "/postgres";
  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const r = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
    if (r.rowCount === 0) {
      await client.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
      console.log(`[control-api] created database ${dbName}`);
    }
  } finally {
    await client.end();
  }
}
