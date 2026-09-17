import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgency, harness, hours, teardown, type Harness } from "./helpers/db";
import {
  ApprovalError,
  approveByToken,
  cancelApproval,
  createApproval,
  loadForClient,
  recordClientView,
  requestChangesByToken,
  rescheduleApproval,
} from "@/lib/approvals/service";
import {
  getApproval,
  listEvents,
  listReminders,
} from "@/lib/db/repositories";
import type { ApprovalWithClient } from "@/lib/db/types";

/** Pull the client's link out of the email we actually sent them. */
function tokenFrom(text: string): string {
  const match = text.match(/https:\/\/chaser\.test\/approve\/([A-Za-z0-9_-]+)/);
  if (!match) throw new Error("no approval link in the email");
  return match[1]!;
}

const CHANNEL = "C0AGENCY";

describe("the approval loop", () => {
  let h: Harness;
  let agency: Awaited<ReturnType<typeof createAgency>>;

  beforeEach(async () => {
    h = await harness();
    agency = await createAgency();
  });

  afterEach(teardown);

  async function create(overrides: Partial<{ deadlineHours: number; offsets: number[] }> = {}) {
    return createApproval({
      organizationId: agency.organization.id,
      actorSlackUserId: "U_DESIGNER",
      clientName: "ABC Clothing",
      clientEmail: "sarah@example.com",
      contactName: "Sarah",
      creativeName: "Instagram Reel #14",
      creativeUrl: "https://example.com/reel14",
      notes: "Focus on the first three seconds.",
      deadline: new Date(Date.now() + hours(overrides.deadlineHours ?? 48)),
      reminderOffsets: overrides.offsets ?? [720, 240, 120],
      slackChannelId: CHANNEL,
    });
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  it("creates an approval, emails the client and posts to Slack", async () => {
    const { approval, approvalUrl } = await create();

    expect(approval.status).toBe("waiting");
    expect(approval.client_name).toBe("ABC Clothing");

    const emails = h.email.messagesTo("sarah@example.com");
    expect(emails).toHaveLength(1);
    expect(emails[0]!.subject).toContain("Instagram Reel #14");
    expect(emails[0]!.text).toContain(approvalUrl);

    expect(h.slack.posted).toHaveLength(1);
    expect(h.slack.posted[0]!.channel).toBe(CHANNEL);
    expect(h.slack.posted[0]!.text).toContain("Instagram Reel #14");
  });

  it("remembers the Slack message so it can be updated later", async () => {
    const { approval } = await create();
    expect(approval.slack_channel_id).toBe(CHANNEL);
    expect(approval.slack_message_ts).toBe(h.slack.posted[0]!.ts);
  });

  it("stores only the hash of the token, never the token itself", async () => {
    const { approval, approvalUrl } = await create();
    const token = tokenFrom(approvalUrl);

    expect(approval.secure_token_hash).not.toContain(token);
    expect(approval.secure_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(approval)).not.toContain(token);
  });

  it("schedules the full reminder sequence", async () => {
    const { approval } = await create();
    const reminders = await listReminders(agency.organization.id, approval.id);

    expect(reminders).toHaveLength(3);
    expect(reminders.map((r) => r.status)).toEqual(["pending", "pending", "pending"]);
    expect(reminders.map((r) => r.kind)).toEqual([
      "reminder",
      "reminder",
      "deadline_warning",
    ]);
  });

  it("skips reminders whose moment already passed on a short-notice request", async () => {
    const { approval } = await create({ deadlineHours: 3 });
    const reminders = await listReminders(agency.organization.id, approval.id);

    // 12h and 4h are behind us; only the 2h warning is live.
    expect(reminders.map((r) => r.status)).toEqual(["skipped", "skipped", "pending"]);
    expect(h.email.outbox).toHaveLength(1); // the request only — no retro-nudges
  });

  it("records the creation and the email in the audit trail", async () => {
    const { approval } = await create();
    const events = await listEvents(agency.organization.id, approval.id);
    const types = events.map((e) => e.event_type);

    expect(types).toContain("approval_created");
    expect(types).toContain("email_sent");
    expect(types).toContain("reminder_scheduled");
    expect(events[0]!.actor_id).toBe("U_DESIGNER");
  });

  it("refuses a deadline in the past", async () => {
    await expect(
      createApproval({
        organizationId: agency.organization.id,
        clientName: "ABC",
        clientEmail: "a@example.com",
        creativeName: "Late",
        deadline: new Date(Date.now() - hours(1)),
        reminderOffsets: [120],
      }),
    ).rejects.toThrow(ApprovalError);
  });

  // -------------------------------------------------------------------------
  // The client opens the link
  // -------------------------------------------------------------------------

  it("moves waiting -> viewed the first time the client opens it", async () => {
    const { approvalUrl } = await create();
    const token = tokenFrom(approvalUrl);

    const viewed = await recordClientView({ kind: "token", value: token });
    expect(viewed.status).toBe("viewed");
    expect(viewed.first_viewed_at).not.toBeNull();

    const events = await listEvents(agency.organization.id, viewed.id);
    expect(events.map((e) => e.event_type)).toContain("client_viewed");
  });

  it("updates the Slack message when the client opens it", async () => {
    const { approvalUrl } = await create();
    await recordClientView({ kind: "token", value: tokenFrom(approvalUrl) });

    expect(h.slack.updated).toHaveLength(1);
    expect(h.slack.updated[0]!.ts).toBe(h.slack.posted[0]!.ts);
    expect(h.slack.updated[0]!.text).toContain("Viewed");
  });

  it("keeps the original first_viewed_at across repeat opens", async () => {
    const { approvalUrl } = await create();
    const token = tokenFrom(approvalUrl);

    const first = await recordClientView({ kind: "token", value: token });
    const second = await recordClientView({ kind: "token", value: token });

    expect(new Date(second.first_viewed_at!).getTime()).toBe(
      new Date(first.first_viewed_at!).getTime(),
    );
    // Every open is still logged, even though the status only moves once.
    const opens = (await listEvents(agency.organization.id, second.id)).filter(
      (e) => e.event_type === "client_opened",
    );
    expect(opens).toHaveLength(2);
  });

  it("rejects a token that does not exist", async () => {
    await expect(
      loadForClient({ kind: "token", value: "A".repeat(43) }),
    ).rejects.toThrow(/not valid/);
  });

  it("rejects a malformed token before it becomes a query", async () => {
    await expect(
      loadForClient({ kind: "token", value: "'; DROP TABLE approvals; --" }),
    ).rejects.toThrow(/not valid/);
  });

  it("rejects an expired link even though the row still exists", async () => {
    const { approval, approvalUrl } = await create();
    const token = tokenFrom(approvalUrl);
    const wayLater = new Date(
      new Date(approval.token_expires_at).getTime() + hours(24),
    );

    await expect(
      loadForClient({ kind: "token", value: token }, wayLater),
    ).rejects.toMatchObject({ code: "expired" });
  });

  // -------------------------------------------------------------------------
  // The client decides
  // -------------------------------------------------------------------------

  it("approves, stops the chasing and tells the agency", async () => {
    const { approval, approvalUrl } = await create();
    const token = tokenFrom(approvalUrl);
    await recordClientView({ kind: "token", value: token });

    const approved = await approveByToken({ kind: "token", value: token });
    expect(approved.status).toBe("approved");
    expect(approved.decided_at).not.toBeNull();

    const reminders = await listReminders(agency.organization.id, approval.id);
    expect(reminders.every((r) => r.status !== "pending")).toBe(true);

    // Receipt to the client.
    expect(
      h.email.messagesTo("sarah@example.com").some((m) =>
        m.subject.startsWith("Approved:"),
      ),
    ).toBe(true);

    // Threaded reply to the agency, under the original message.
    const reply = h.slack.posted.find((p) => p.threadTs);
    expect(reply).toBeDefined();
    expect(reply!.text).toContain("Approved");
    expect(reply!.threadTs).toBe(h.slack.posted[0]!.ts);
  });

  it("records approval in the audit trail", async () => {
    const { approval, approvalUrl } = await create();
    await approveByToken({ kind: "token", value: tokenFrom(approvalUrl) });

    const types = (await listEvents(agency.organization.id, approval.id)).map(
      (e) => e.event_type,
    );
    expect(types).toContain("client_approved");
    expect(types).toContain("agency_notified");
  });

  it("refuses a second decision on an already-approved request", async () => {
    const { approvalUrl } = await create();
    const token = tokenFrom(approvalUrl);
    await approveByToken({ kind: "token", value: token });

    await expect(
      approveByToken({ kind: "token", value: token }),
    ).rejects.toMatchObject({ code: "already_decided" });
    await expect(
      requestChangesByToken({ kind: "token", value: token }, "Actually, change it"),
    ).rejects.toMatchObject({ code: "already_decided" });
  });

  it("lets only one of two simultaneous decisions win", async () => {
    const { approvalUrl } = await create();
    const token = tokenFrom(approvalUrl);

    const outcomes = await Promise.allSettled([
      approveByToken({ kind: "token", value: token }),
      requestChangesByToken({ kind: "token", value: token }, "Swap the opening shot"),
    ]);

    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === "rejected")).toHaveLength(1);
  });

  it("requests changes, stores the comment and stops the sequence", async () => {
    const { approval, approvalUrl } = await create();
    const token = tokenFrom(approvalUrl);

    const changed = await requestChangesByToken(
      { kind: "token", value: token },
      "Please change the opening shot.",
    );

    expect(changed.status).toBe("changes_requested");
    expect(changed.decision_comment).toBe("Please change the opening shot.");

    const reminders = await listReminders(agency.organization.id, approval.id);
    expect(reminders.every((r) => r.status !== "pending")).toBe(true);

    const reply = h.slack.posted.find((p) => p.threadTs);
    expect(reply!.text).toContain("Changes requested");
  });

  it("refuses an empty change request", async () => {
    const { approvalUrl } = await create();
    await expect(
      requestChangesByToken({ kind: "token", value: tokenFrom(approvalUrl) }, "  "),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  // -------------------------------------------------------------------------
  // The agency side
  // -------------------------------------------------------------------------

  it("cancels, stops the chasing and updates the message", async () => {
    const { approval } = await create();

    const cancelled = await cancelApproval({
      organizationId: agency.organization.id,
      approvalId: approval.id,
      actorSlackUserId: "U_LEAD",
    });

    expect(cancelled.status).toBe("cancelled");
    const reminders = await listReminders(agency.organization.id, approval.id);
    expect(reminders.every((r) => r.status !== "pending")).toBe(true);
    expect(h.slack.updated.at(-1)!.text).toContain("Cancelled");
  });

  it("refuses to cancel an approval that is already approved", async () => {
    const { approval, approvalUrl } = await create();
    await approveByToken({ kind: "token", value: tokenFrom(approvalUrl) });

    await expect(
      cancelApproval({
        organizationId: agency.organization.id,
        approvalId: approval.id,
      }),
    ).rejects.toMatchObject({ code: "already_decided" });
  });

  it("recalculates future reminders when the deadline moves", async () => {
    const { approval } = await create({ deadlineHours: 48 });
    const before = await listReminders(agency.organization.id, approval.id);

    const newDeadline = new Date(Date.now() + hours(96));
    await rescheduleApproval({
      organizationId: agency.organization.id,
      approvalId: approval.id,
      deadline: newDeadline,
    });

    const after = await listReminders(agency.organization.id, approval.id);
    expect(after).toHaveLength(3);
    for (let i = 0; i < 3; i += 1) {
      expect(new Date(after[i]!.scheduled_for).getTime()).toBeGreaterThan(
        new Date(before[i]!.scheduled_for).getTime(),
      );
    }
    // Rescheduled in place, not duplicated.
    expect(after.map((r) => r.reminder_number)).toEqual([1, 2, 3]);

    const types = (await listEvents(agency.organization.id, approval.id)).map(
      (e) => e.event_type,
    );
    expect(types).toContain("deadline_changed");
  });

  it("reopens a changes_requested approval into a fresh waiting round", async () => {
    const { approval, approvalUrl } = await create();
    await requestChangesByToken(
      { kind: "token", value: tokenFrom(approvalUrl) },
      "Swap the opening shot",
    );

    const reopened = await rescheduleApproval({
      organizationId: agency.organization.id,
      approvalId: approval.id,
      deadline: new Date(Date.now() + hours(72)),
      reminderOffsets: [720, 240, 120],
    });

    expect(reopened.status).toBe("waiting");
    const reminders = await listReminders(agency.organization.id, approval.id);
    expect(reminders.filter((r) => r.status === "pending")).toHaveLength(3);
  });

  it("refuses to reschedule into the past", async () => {
    const { approval } = await create();
    await expect(
      rescheduleApproval({
        organizationId: agency.organization.id,
        approvalId: approval.id,
        deadline: new Date(Date.now() - hours(1)),
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("works when the agency has no Slack installation at all", async () => {
    // A tenant created over HTTP with no workspace connected. The email path
    // must still work; Slack is simply skipped.
    const { createOrganization } = await import("@/lib/db/repositories");
    const lonely = await createOrganization("No Slack Agency");

    const { approval } = await createApproval({
      organizationId: lonely.id,
      clientName: "Someone",
      clientEmail: "someone@example.com",
      creativeName: "A poster",
      deadline: new Date(Date.now() + hours(24)),
      reminderOffsets: [120],
    });

    expect(approval.status).toBe("waiting");
    expect(h.email.messagesTo("someone@example.com")).toHaveLength(1);
  });

  it("keeps the approval when the confirmation receipt fails to send", async () => {
    const { approvalUrl } = await create();
    const token = tokenFrom(approvalUrl);

    const { setEmailProvider } = await import("@/lib/email");
    setEmailProvider({
      name: "broken",
      async send() {
        throw new Error("SMTP exploded");
      },
    });

    // The decision is what matters; the receipt is not allowed to undo it.
    const approved = await approveByToken({ kind: "token", value: token });
    expect(approved.status).toBe("approved");

    setEmailProvider(h.email);
    const stored = (await getApproval(
      agency.organization.id,
      approved.id,
    )) as ApprovalWithClient;
    expect(stored.status).toBe("approved");
  });
});
