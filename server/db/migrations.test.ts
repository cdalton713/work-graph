import { afterEach, expect, test } from "vitest";
import { databaseSuites } from "../testing/sql.ts";
import { migrate } from "./migrations.ts";

databaseSuites((open) => {
  const databases: Awaited<ReturnType<typeof open>>[] = [];
  async function database() {
    const sql = await open();
    databases.push(sql);
    return sql;
  }

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((sql) => sql.close()));
  });

  test("applies migrations once, including on concurrent starts", async () => {
    const sql = await database();
    await Promise.all([migrate(sql), migrate(sql)]);
    await migrate(sql);
    expect(await sql.query("SELECT version FROM schema_migrations ORDER BY version")).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }]);
    for (const table of ["users", "tenants", "linear_connections", "coordinator_tokens"]) {
      expect(await sql.query(`SELECT * FROM ${table}`)).toEqual([]);
    }
  });

  test("refuses a database from a newer version", async () => {
    const sql = await database();
    await migrate(sql);
    await sql.query("INSERT INTO schema_migrations (version) VALUES (999)");
    await expect(migrate(sql)).rejects.toThrow("Database schema is newer than this server");
  });

  test("disables the statement timeout only during migrations", async () => {
    const sql = await database();
    const original = await sql.query("SHOW statement_timeout");
    const timeouts: unknown[] = [];
    await migrate({
      query: sql.query,
      transaction: (run) => sql.transaction(async ({ query }) => {
        await query("SET LOCAL statement_timeout = 1000");
        return run({ query: async (statement, params) => {
          if (statement.startsWith("SELECT pg_advisory_xact_lock")) {
            timeouts.push(await query("SHOW statement_timeout"));
          }
          return query(statement, params);
        } });
      }),
    });
    expect(timeouts).toHaveLength(7);
    for (const timeout of timeouts) expect(timeout).toEqual([{ statement_timeout: "0" }]);
    expect(await sql.query("SHOW statement_timeout")).toEqual(original);
  });
});
