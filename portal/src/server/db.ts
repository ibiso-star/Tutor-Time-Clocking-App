import pg from "pg";

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(connectionString: string, opts: { max?: number; ssl?: pg.PoolConfig["ssl"] } = {}): Db {
  return new pg.Pool({ connectionString, max: opts.max ?? 10, ssl: opts.ssl, options: "-c TimeZone=UTC" });
}

export async function withTransaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
