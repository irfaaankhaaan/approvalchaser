import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgency, harness, hours, teardown } from "./helpers/db";
import {
  appendEvent,
  countApprovals,
  getApproval,
  getClient,
  listApprovals,
  listEvents,
  listReminders,
  transitionApproval,
  upsertClient,
} from "@/lib/db/repositories";
import { createApproval, cancelApproval, ApprovalError } from "@/lib/approvals/service";

/**
 * Multi-tenancy.
 *
 * These run against real Postgres with the real schema, so they test the
 * actual WHERE clauses rather than a mock's idea of them. The shape of every
 * test is the same: agency B holds a genuine id belonging to agency A, and
 * gets nothing back.
 */
describe("organization isolation", () => {
  let alpha: Awaited<ReturnType<typeof createAgency>>;
  let beta: Awaited<ReturnType<typeof createAgency>>;

  beforeEach(async () => {
    await harness();
    alpha = await createAgency("Alpha Agency", "TALPHA");
    beta = await createAgency("Beta Agency", "TBETA");
  });

  afterEach(teardown);

  async function approvalFor(
    agency: Awaited<ReturnType<typeof createAgency>>,
    creativeName: string,
  ) {
    const { approval } = await createApproval({
      organizationId: agency.organization.id,
      clientName: "A Client",
      clientEmail: `client-${creativeName}@example.com`,
      creativeName,
      deadline: new Date(Date.now() + hours(48)),
      reminderOffsets: [720, 240, 120],
    });
    return approval;
  }

  it("does not return another agency's approval by id", async () => {
    const approval = await approvalFor(alpha, "Alpha Reel");

    expect(await getApproval(alpha.organization.id, approval.id)).toBeDefined();
    expect(await getApproval(beta.organization.id, approval.id)).toBeUndefined();
  });

  it("does not list another agency's approvals", async () => {
    await approvalFor(alpha, "Alpha Reel");
    await approvalFor(beta, "Beta Reel");

    const alphaList = await listApprovals({ organizationId: alpha.organization.id });
    const betaList = await listApprovals({ organizationId: beta.organization.id });

    expect(alphaList.map((a) => a.creative_name)).toEqual(["Alpha Reel"]);
    expect(betaList.map((a) => a.creative_name)).toEqual(["Beta Reel"]);
  });

  it("does not count another agency's approvals", async () => {
    await approvalFor(alpha, "One");
    await approvalFor(alpha, "Two");
    await approvalFor(beta, "Three");

    expect(await countApprovals({ organizationId: alpha.organization.id })).toBe(2);
    expect(await countApprovals({ organizationId: beta.organization.id })).toBe(1);
  });

  it("refuses to cancel another agency's approval", async () => {
    const approval = await approvalFor(alpha, "Alpha Reel");

    await expect(
      cancelApproval({
        organizationId: beta.organization.id,
        approvalId: approval.id,
      }),
    ).rejects.toThrow(ApprovalError);

    // And it really is untouched.
    const after = await getApproval(alpha.organization.id, approval.id);
    expect(after!.status).toBe("waiting");
  });

  it("refuses a cross-tenant status transition even with a real id", async () => {
    const approval = await approvalFor(alpha, "Alpha Reel");

    const moved = await transitionApproval({
      organizationId: beta.organization.id,
      approvalId: approval.id,
      from: ["waiting"],
      to: "cancelled",
    });

    expect(moved).toBeUndefined();
    expect((await getApproval(alpha.organization.id, approval.id))!.status).toBe(
      "waiting",
    );
  });

  it("does not leak another agency's audit trail", async () => {
    const approval = await approvalFor(alpha, "Alpha Reel");
    await appendEvent({
      organizationId: alpha.organization.id,
      approvalId: approval.id,
      eventType: "agency_notified",
    });

    expect(
      (await listEvents(alpha.organization.id, approval.id)).length,
    ).toBeGreaterThan(0);
    expect(await listEvents(beta.organization.id, approval.id)).toEqual([]);
  });

  it("does not leak another agency's reminders", async () => {
    const approval = await approvalFor(alpha, "Alpha Reel");

    expect(
      (await listReminders(alpha.organization.id, approval.id)).length,
    ).toBe(3);
    expect(await listReminders(beta.organization.id, approval.id)).toEqual([]);
  });

  it("does not leak another agency's client records", async () => {
    const client = await upsertClient({
      organizationId: alpha.organization.id,
      name: "Shared Name",
      email: "shared@example.com",
    });

    expect(await getClient(alpha.organization.id, client.id)).toBeDefined();
    expect(await getClient(beta.organization.id, client.id)).toBeUndefined();
  });

  it("lets two agencies hold the same client email as separate records", async () => {
    const a = await upsertClient({
      organizationId: alpha.organization.id,
      name: "ABC Clothing",
      email: "sarah@example.com",
    });
    const b = await upsertClient({
      organizationId: beta.organization.id,
      name: "ABC Clothing",
      email: "sarah@example.com",
    });

    expect(a.id).not.toBe(b.id);
  });

  it("treats a repeat client email inside one agency as the same record", async () => {
    const first = await upsertClient({
      organizationId: alpha.organization.id,
      name: "ABC Clothing",
      email: "Sarah@Example.com",
    });
    const second = await upsertClient({
      organizationId: alpha.organization.id,
      name: "ABC Clothing Ltd",
      email: "sarah@example.com",
    });

    expect(second.id).toBe(first.id);
    expect(second.name).toBe("ABC Clothing Ltd");
  });
});
