import { readFileSync } from "node:fs";
import path from "node:path";
import { env } from "@/lib/env";

/**
 * The database handle.
 *
 * Everything in the data layer is written against this one interface, which
 * both `pg.Pool` and PGlite satisfy. That is what lets the test suite run the
 * real SQL — the same statements production runs — against an in-process
 * Postgres, instead of mocking the database and proving nothing.
 */
export interface SqlClient {
  query<T = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
  /**
   * Run a script of several statements. PGlite exposes this; node-postgres
   * does not, because its `query` already accepts multi-statement text when
   * no parameters are bound.
   */
  exec?(text: string): Promise<unknown>;
}

let handle: SqlClient | undefined;
let handleKind: "postgres" | "pglite" | "injected" | undefined;

/**
 * Point the application at a specific client. Used by the test suite and by
 * scripts; the app itself never calls this.
 */
export function setDb(client: SqlClient | undefined): void {
  handle = client;
  handleKind = client ? "injected" : undefined;
}

export function dbKind(): string {
  return handleKind ?? "unset";
}

async function connect(): Promise<SqlClient> {
  const url = env.databaseUrl;

  if (url) {
    const { Pool } = await import("pg");
    const pool = new Pool({
      connectionString: url,
      // Managed Postgres (Supabase, Neon, RDS) terminates TLS with a chain
      // the container may not carry. Verification stays on unless the URL
      // explicitly opts out, which is a deliberate, visible choice.
      ssl: /sslmode=(require|no-verify)/.test(url)
        ? { rejectUnauthorized: !url.includes("sslmode=no-verify") }
        : undefined,
      max: 5,
      idleTimeoutMillis: 30_000,
    });
    handleKind = "postgres";
    return pool as unknown as SqlClient;
  }

  if (env.isProduction) {
    throw new Error("DATABASE_URL is required in production.");
  }

  // Local development with no Postgres to hand: a real Postgres compiled to
  // WASM, persisted under .pgdata. Same SQL, same behaviour, no server.
  const { PGlite } = await import("@electric-sql/pglite");
  const lite = new PGlite(path.join(process.cwd(), ".pgdata"));
  await lite.waitReady;
  handleKind = "pglite";
  const client = lite as unknown as SqlClient;
  await applySchema(client);
  return client;
}

export async function getDb(): Promise<SqlClient> {
  if (!handle) handle = await connect();
  return handle;
}

/**
 * Apply schema.sql. It is written with IF NOT EXISTS throughout, so running
 * it against an existing database is a no-op.
 */
export async function applySchema(client: SqlClient): Promise<void> {
  const file = path.join(process.cwd(), "db", "schema.sql");
  const script = readFileSync(file, "utf8");
  if (typeof client.exec === "function") {
    await client.exec(script);
  } else {
    await client.query(script);
  }
}

/** Convenience wrapper so call sites read as one line. */
export async function sql<T = Record<string, unknown>>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const db = await getDb();
  const result = await db.query<T>(text, params);
  return result.rows;
}

/** The single-row variant. Returns undefined rather than throwing. */
export async function sqlOne<T = Record<string, unknown>>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T | undefined> {
  const rows = await sql<T>(text, params);
  return rows[0];
}
