import type { ExtractTablesWithRelations } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export function createDb(databaseUrl: string) {
  const client = postgres(databaseUrl);
  return drizzle(client, { schema });
}

export type Database = ReturnType<typeof createDb>;

/**
 * Drizzle transaction type. Service helpers that need to accept either the
 * top-level Database or a transaction should use `Db = Database | DbTransaction`.
 */
export type DbTransaction = PgTransaction<
  PostgresJsQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

/** Either a base connection or a transaction. Use this in service signatures. */
export type Db = Database | DbTransaction;
