/**
 * Demo data for local development.
 *
 * Creates one agency with three approvals in different states, so that
 * `/approval list`, the client page and the audit trail all have something
 * real to show before a single Slack message has been sent. It prints the
 * client links, which is the whole point: you can click them.
 *
 * It refuses to run against a production database.
 */
import "./load-env";
import { applySchema, getDb } from "../src/lib/db/client";
import {
  createOrganization,
  insertApproval,
  upsertClient,
  appendEvent,
} from "../src/lib/db/repositories";
import {
  generateApprovalToken,
  hashApprovalToken,
} from "../src/lib/crypto/tokens";
import { scheduleReminders, approvalUrl } from "../src/lib/approvals/service";

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to seed a production database.");
  }

  await applySchema(await getDb());

  const org = await createOrganization("Northlight Studio", "Europe/London");
  console.info(`Organization: ${org.name} (${org.id})`);

  const cases = [
    {
      client: { name: "ABC Clothing", email: "sarah@example.com", contact: "Sarah" },
      creative: "Instagram Reel #14",
      url: "https://example.com/reel14",
      hoursOut: 26,
    },
    {
      client: { name: "Nova Cosmetics", email: "dev@example.com", contact: "Dev" },
      creative: "Product Video #3",
      url: "https://example.com/product3",
      hoursOut: 50,
    },
    {
      client: { name: "BuildPro", email: "mo@example.com", contact: "Mo" },
      creative: "Facebook Ad V7",
      url: null,
      hoursOut: 5,
    },
  ];

  for (const testCase of cases) {
    const client = await upsertClient({
      organizationId: org.id,
      name: testCase.client.name,
      email: testCase.client.email,
      contactName: testCase.client.contact,
    });

    const token = generateApprovalToken();
    const deadline = new Date(Date.now() + testCase.hoursOut * 3_600_000);

    const approval = await insertApproval({
      organizationId: org.id,
      clientId: client.id,
      creativeName: testCase.creative,
      creativeUrl: testCase.url,
      deadline,
      status: "waiting",
      secureTokenHash: hashApprovalToken(token),
      tokenExpiresAt: new Date(Date.now() + 30 * 86_400_000),
      reminderOffsets: [720, 240, 120],
    });

    await appendEvent({
      organizationId: org.id,
      approvalId: approval.id,
      eventType: "approval_created",
      metadata: { seeded: true },
    });
    await scheduleReminders({ ...approval, deadline });

    console.info(`\n${testCase.client.name} — ${testCase.creative}`);
    console.info(`  ${approvalUrl(token)}`);
  }

  console.info("\nSeed complete.");
  process.exit(0);
}

main().catch((error) => {
  console.error("Seed failed:", error);
  process.exit(1);
});
