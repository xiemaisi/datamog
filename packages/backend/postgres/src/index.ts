import type { Backend } from "datamog-engine";
import { PostgresSqlDialect } from "./dialect.ts";

export { PostgresSqlDialect } from "./dialect.ts";

/**
 * @param sql - Connection to run against, defaulting to the global `Bun.sql`
 *   (configured from `DATABASE_URL`). `close()` closes whatever it is handed,
 *   and the global cannot be reopened afterwards, so pass a dedicated
 *   `new Bun.SQL(url)` when two backends need independent lifetimes -- as two
 *   test suites in one `bun test` process do.
 */
export async function create(sql: typeof Bun.sql = Bun.sql): Promise<Backend> {
  return {
    sqlDialect: new PostgresSqlDialect(),
    async execute(query: string, params?: unknown[]): Promise<Record<string, unknown>[]> {
      if (params && params.length > 0) {
        return sql.unsafe(query, params) as Promise<Record<string, unknown>[]>;
      }
      return sql.unsafe(query) as Promise<Record<string, unknown>[]>;
    },
    async close(): Promise<void> {
      await sql.close();
    },
  };
}
