import { randomUUID } from "node:crypto";
import { describe } from "vitest";
import { postgresSql, type Database } from "../db/sql.ts";

import { pgliteSql } from "./pglite.ts";
export { pgliteSql } from "./pglite.ts";

async function isolatedPostgres(url: string): Promise<Database> {
  const schema = "test_" + randomUUID().replaceAll("-", "");
  const admin = await postgresSql(url);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const sql = await postgresSql(url, { options: `-c search_path=${schema}` });
  return {
    ...sql,
    async close() {
      try {
        await sql.close();
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      } finally {
        await admin.close();
      }
    },
  };
}

export function databaseSuites(suite: (open: () => Promise<Database>) => void) {
  describe("PGlite", () => suite(pgliteSql));
  const url = process.env.TEST_DATABASE_URL;
  if (url) describe("Postgres", () => suite(() => isolatedPostgres(url)));
}
