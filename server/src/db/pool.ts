import pg from "pg";

export type Db = pg.Pool;
export type Tx = pg.PoolClient;
export type Queryable = pg.Pool | pg.PoolClient;

export interface PoolOptions {
  max?: number;
  ssl?: pg.PoolConfig["ssl"];
}

export function createPool(connectionString: string, opts: PoolOptions = {}): Db {
  // Sessions always talk UTC; local time is applied explicitly per project timezone.
  return new pg.Pool({ connectionString, max: opts.max ?? 10, ssl: opts.ssl, options: "-c TimeZone=UTC" });
}

/**
 * Runs `fn` inside a transaction. Business mutations and their audit rows are written
 * through the same client so they commit (or roll back) together.
 */
export async function withTransaction<T>(
  db: Db,
  fn: (tx: Tx) => Promise<T>,
  isolation: "READ COMMITTED" | "REPEATABLE READ" = "READ COMMITTED",
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
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
