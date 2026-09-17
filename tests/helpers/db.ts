import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { setDb, type SqlClient } from "@/lib/db/client";
import { MockEmailProvider } from "@/lib/email/mock";
import { setEmailProvider } from "@/lib/email";
import { RecordingSlackGateway, setSlackGatewayFactory } from "@/lib/slack/client";
import {
  createOrganization,
  upsertSlackInstallation,
} from "@/lib/db/repositories";

/**
 * A real Postgres for each test file.
 *
 * PGlite is Postgres compiled to WASM, so `db/schema.sql` is applied verbatim
 * and the repository layer runs the same statements production runs —
 * constraints, partial indexes, ON CONFLICT clauses and all. A hand-rolled
 * fake store would have proved nothing about the queries that matter here,
 * particularly the organization scoping.
 */
export async function freshDatabase(): Promise<PGlite> {
  const db = new PGlite();
  await db.waitReady;
  const schema = readFileSync(
    path.join(process.cwd(), "db", "schema.sql"),
    "utf8",
  );
  await db.exec(schema);
  setDb(db as unknown as SqlClient);
  return db;
}

export interface Harness {
  db: PGlite;
  email: MockEmailProvider;
  slack: RecordingSlackGateway;
}

export async function harness(): Promise<Harness> {
  const db = await freshDatabase();
  const email = new MockEmailProvider(false);
  const slack = new RecordingSlackGateway();
  setEmailProvider(email);
  setSlackGatewayFactory(() => slack);
  return { db, email, slack };
}

export function teardown(): void {
  setDb(undefined);
  setEmailProvider(undefined);
  setSlackGatewayFactory(undefined);
}

/** One agency, with a Slack installation so notifications have somewhere to go. */
export async function createAgency(
  name = "Northlight Studio",
  teamId = `T${Math.random().toString(36).slice(2, 10)}`,
) {
  const organization = await createOrganization(name, "UTC");
  const { installation } = await upsertSlackInstallation({
    organizationId: organization.id,
    teamId,
    teamName: name,
    botUserId: "B123",
    // Never decrypted in tests: the gateway factory is overridden.
    encryptedBotToken: "v1.stub.stub.stub",
  });
  return { organization, installation };
}

export const hours = (n: number) => n * 3_600_000;
export const minutes = (n: number) => n * 60_000;
