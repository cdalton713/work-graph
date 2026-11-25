import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { describe } from "vitest";
import { postgresSql, safeQuery, type Database, type Query } from "../db/sql.ts";

export async function pgliteSql(): Promise<Database> {
  const db = new PGlite();
  function query(client: Pick<PGlite, "query">): Query {
    return safeQuery((text, params) => client.query(text, params));
  }
  return {
    query: query(db),
    transaction: (run) => db.transaction((tx) => run({ query: query(tx) })),
    close: () => db.close(),
  };
}

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
