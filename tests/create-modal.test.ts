import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgency, harness, hours, teardown, type Harness } from "./helpers/db";
import { createApproval } from "@/lib/approvals/service";
import { getMostRecentClientForActor, upsertUserBySlackId } from "@/lib/db/repositories";
import { buildCreateModalView } from "@/lib/slack/create-modal";
import { installWelcomeMessage } from "@/lib/slack/blocks";
import { sendInstallWelcome } from "@/lib/notifications/service";

/**
 * The prefill that removes retyping on a repeat approval, and the welcome
 * message the OAuth callback DMs to whoever just installed the app.
 */
describe("create-modal prefill", () => {
  let agency: Awaited<ReturnType<typeof createAgency>>;

  beforeEach(async () => {
    await harness();
    agency = await createAgency();
  });
  afterEach(teardown);

  async function approvalCreatedBy(slackUserId: string, clientName: string, clientEmail: string) {
    const user = await upsertUserBySlackId({
      organizationId: agency.organization.id,
      slackUserId,
      name: "Designer",
    });
    return createApproval({
      organizationId: agency.organization.id,
      createdBy: user.id,
      actorSlackUserId: slackUserId,
      clientName,
      clientEmail,
      contactName: "Sarah",
      creativeName: "A creative",
      deadline: new Date(Date.now() + hours(48)),
      reminderOffsets: [120],
    });
  }

  it("finds nothing for a user who has never created an approval", async () => {
    expect(
      await getMostRecentClientForActor(agency.organization.id, "U_NEW"),
    ).toBeUndefined();
  });

  it("returns the client from that user's most recent approval", async () => {
    await approvalCreatedBy("U_A", "ABC Clothing", "sarah@example.com");

    const recent = await getMostRecentClientForActor(agency.organization.id, "U_A");
    expect(recent).toMatchObject({ name: "ABC Clothing", email: "sarah@example.com" });
  });

  it("tracks per user, not per organization", async () => {
    await approvalCreatedBy("U_A", "ABC Clothing", "sarah@example.com");
    await approvalCreatedBy("U_B", "Nova Cosmetics", "dev@example.com");

    expect(await getMostRecentClientForActor(agency.organization.id, "U_A")).toMatchObject({
      name: "ABC Clothing",
    });
    expect(await getMostRecentClientForActor(agency.organization.id, "U_B")).toMatchObject({
      name: "Nova Cosmetics",
    });
  });

  it("returns the most recent of several, not the first", async () => {
    await approvalCreatedBy("U_A", "First Client", "first@example.com");
    await approvalCreatedBy("U_A", "Second Client", "second@example.com");

    expect(await getMostRecentClientForActor(agency.organization.id, "U_A")).toMatchObject({
      name: "Second Client",
      email: "second@example.com",
    });
  });

  it("does not leak another organization's client as a prefill", async () => {
    const other = await createAgency("Other Agency", "TOTHER");
    const user = await upsertUserBySlackId({
      organizationId: other.organization.id,
      slackUserId: "U_SHARED_ID",
      name: "Someone",
    });
    await createApproval({
      organizationId: other.organization.id,
      createdBy: user.id,
      clientName: "Other Org Client",
      clientEmail: "other@example.com",
      creativeName: "Something",
      deadline: new Date(Date.now() + hours(48)),
      reminderOffsets: [120],
    });

    // Same raw Slack user id string, different organization: nothing found.
    expect(
      await getMostRecentClientForActor(agency.organization.id, "U_SHARED_ID"),
    ).toBeUndefined();
  });

  it("builds a modal with no prefill for a first-time user", async () => {
    const view = await buildCreateModalView(agency.organization.id, "U_BRAND_NEW");
    const blocks = (view.blocks as { block_id?: string; element?: { initial_value?: string } }[]);
    const clientBlock = blocks.find((b) => b.block_id === "client_name");
    expect(clientBlock?.element?.initial_value).toBeUndefined();
  });

  it("builds a modal prefilled with the client, email and contact", async () => {
    await approvalCreatedBy("U_A", "ABC Clothing", "sarah@example.com");

    const view = await buildCreateModalView(agency.organization.id, "U_A");
    const blocks = (view.blocks as { block_id?: string; element?: { initial_value?: string } }[]);

    expect(blocks.find((b) => b.block_id === "client_name")?.element?.initial_value).toBe(
      "ABC Clothing",
    );
    expect(blocks.find((b) => b.block_id === "client_email")?.element?.initial_value).toBe(
      "sarah@example.com",
    );
    expect(blocks.find((b) => b.block_id === "contact_name")?.element?.initial_value).toBe(
      "Sarah",
    );
  });

  it("does not prefill for an empty Slack user id", async () => {
    await approvalCreatedBy("U_A", "ABC Clothing", "sarah@example.com");
    const view = await buildCreateModalView(agency.organization.id, "");
    const blocks = (view.blocks as { block_id?: string; element?: { initial_value?: string } }[]);
    expect(blocks.find((b) => b.block_id === "client_name")?.element?.initial_value).toBeUndefined();
  });
});

describe("install welcome message", () => {
  it("names the product and the way to get started", () => {
    const { text, blocks } = installWelcomeMessage();
    expect(text).toContain("Approval Chaser");
    expect(JSON.stringify(blocks)).toContain("/approval create");
  });

  it("carries one real, wired-up button rather than a decorative one", () => {
    const { blocks } = installWelcomeMessage();
    const actionsBlock = blocks.find((b) => b.type === "actions") as
      | { elements: { action_id: string }[] }
      | undefined;
    expect(actionsBlock).toBeDefined();
    expect(actionsBlock!.elements).toHaveLength(1);
    expect(actionsBlock!.elements[0]!.action_id).toBe("approval_create");
  });
});

describe("sendInstallWelcome", () => {
  let h: Harness;
  let agency: Awaited<ReturnType<typeof createAgency>>;

  beforeEach(async () => {
    h = await harness();
    agency = await createAgency();
  });
  afterEach(teardown);

  it("DMs the installer directly, not a channel", async () => {
    await sendInstallWelcome(agency.installation, "U_INSTALLER");

    expect(h.slack.posted).toHaveLength(1);
    expect(h.slack.posted[0]!.channel).toBe("U_INSTALLER");
    expect(h.slack.posted[0]!.text).toContain("Approval Chaser");
  });

  it("does nothing when Slack never says who installed it", async () => {
    await sendInstallWelcome(agency.installation, undefined);
    expect(h.slack.posted).toHaveLength(0);
  });
});
