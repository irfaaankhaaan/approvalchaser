import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freshDatabase, teardown } from "./helpers/db";
import {
  createOrganization,
  getInstallationByTeamId,
  upsertSlackInstallation,
} from "@/lib/db/repositories";

/**
 * `upsertSlackInstallation`'s `wasInserted` flag is what the OAuth callback
 * uses to decide whether to DM the installer. It has to come from the
 * upsert's own row (an `xmax = 0` check on the statement that just ran), not
 * a separate read taken beforehand — that's what makes two concurrent
 * callbacks for the same team (a double-clicked install button, Slack
 * retrying the redirect) resolve to exactly one "yes, this was the insert".
 */
describe("upsertSlackInstallation", () => {
  beforeEach(async () => {
    await freshDatabase();
  });
  afterEach(teardown);

  async function install(organizationId: string, teamId: string) {
    return upsertSlackInstallation({
      organizationId,
      teamId,
      teamName: "Test Agency",
      botUserId: "B1",
      encryptedBotToken: "v1.stub.stub.stub",
    });
  }

  it("reports wasInserted on a genuine first install", async () => {
    const org = await createOrganization("Agency");
    const { wasInserted, installation } = await install(org.id, "TFIRST");
    expect(wasInserted).toBe(true);
    expect(installation.team_id).toBe("TFIRST");
  });

  it("reports wasInserted: false on a re-install of the same team", async () => {
    const org = await createOrganization("Agency");
    await install(org.id, "TREPEAT");
    const second = await install(org.id, "TREPEAT");
    expect(second.wasInserted).toBe(false);
  });

  it("updates the row in place on a re-install rather than creating a second one", async () => {
    const org = await createOrganization("Agency");
    const first = await install(org.id, "TSAME");
    const second = await upsertSlackInstallation({
      organizationId: org.id,
      teamId: "TSAME",
      teamName: "Renamed Agency",
      botUserId: "B2",
      encryptedBotToken: "v1.new.new.new",
    });

    expect(second.installation.id).toBe(first.installation.id);
    expect(second.installation.team_name).toBe("Renamed Agency");
    expect((await getInstallationByTeamId("TSAME"))!.bot_user_id).toBe("B2");
  });

  it("lets exactly one of two concurrent first-install callbacks see wasInserted: true", async () => {
    // The exact race a double-clicked install button or a retried OAuth
    // redirect produces: two requests for the same brand-new team_id,
    // running their upserts at the same moment.
    const org = await createOrganization("Agency");
    const [a, b] = await Promise.all([
      install(org.id, "TRACE"),
      install(org.id, "TRACE"),
    ]);

    const insertedCount = [a.wasInserted, b.wasInserted].filter(Boolean).length;
    expect(insertedCount).toBe(1);
    // And both calls still resolve to the one row that exists.
    expect(a.installation.id).toBe(b.installation.id);
  });
});
