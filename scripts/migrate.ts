/**
 * Apply db/schema.sql to whatever DATABASE_URL points at.
 *
 * The schema is written with IF NOT EXISTS throughout, so this is safe to run
 * repeatedly and safe to run on a database that is already up to date.
 */
import "./load-env";
import { applySchema, getDb, dbKind } from "../src/lib/db/client";

async function main() {
  const db = await getDb();
  await applySchema(db);
  console.info(`Schema applied (${dbKind()}).`);
  process.exit(0);
}

main().catch((error) => {
  console.error("Migration failed:", error);
  process.exit(1);
});
