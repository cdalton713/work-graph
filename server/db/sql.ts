import type { PoolConfig } from "pg";

export type Query = <Row extends Record<string, unknown> = Record<string, unknown>>(
  text: string, params?: unknown[],
) => Promise<Row[]>;

export interface Sql {
  query: Query;
  transaction<T>(run: (tx: { query: Query }) => Promise<T>): Promise<T>;
}

export interface Database extends Sql {
  close(): Promise<void>;
}

export function safeQuery(run: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>): Query {
  return async <Row>(text: string, params?: unknown[]) => {
    try {
      return (await run(text, params)).rows as Row[];
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === "23505") throw new Error("Database record already exists");
      throw new Error("Database query failed");
    }
  };
}

export async function postgresSql(url: string, options: Pick<PoolConfig, "options"> = {}): Promise<Database> {
  try {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: url, ...options });
    pool.on("error", () => console.error("An idle database connection failed"));
    return {
      query: safeQuery((text, params) => pool.query(text, params)),
      async transaction(run) {
        const client = await pool.connect().catch(() => { throw new Error("Database connection failed"); });
        const query = safeQuery((text, params) => client.query(text, params));
        let discard = false;
        try {
          await query("BEGIN");
          const result = await run({ query });
          await query("COMMIT");
          return result;
        } catch (error) {
          await query("ROLLBACK").catch(() => { discard = true; });
          throw error;
        } finally {
          client.release(discard);
        }
      },
      close: () => pool.end(),
    };
  } catch {
    throw new Error("Database setup failed");
  }
}
