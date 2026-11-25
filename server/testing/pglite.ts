import { PGlite } from "@electric-sql/pglite";
import { safeQuery, type Database, type Query } from "../db/sql.ts";

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
