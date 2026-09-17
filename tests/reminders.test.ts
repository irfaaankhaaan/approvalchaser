import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgency, harness, hours, minutes, teardown, type Harness } from "./helpers/db";
import {
  approveByToken,
  cancelApproval,
  createApproval,
  requestChangesByToken,
  rescheduleApproval,
} from "@/lib/approvals/service";
import {
  runOverdueSweep,
  runReminderSweep,
  sendManualReminder,
} from "@/lib/reminders/service";
import {
  cancelPendingReminders,
  claimReminder,
  findDueReminders,
  getApproval,
  listEvents,
  markReminderCancelled,
  listReminders,
} from "@/lib/db/repositories";

function tokenFrom(text: string): string {
  const match = text.match(/https:\/\/chaser\.test\/approve\/([A-Za-z0-9_-]+)/);
  if (!match) throw new Error("no approval link in the email");
  return match[1]!;
}

const CHANNEL = "C0AGENCY";

describe("the reminder engine", () => {
  let h: Harness;
  let agency: Awaited<ReturnType<typeof createAgency>>;

  beforeEach(async () => {
    h = await harness();
    agency = await createAgency();
  });

  afterEach(teardown);

  /** An approval whose deadline is `hoursOut` away, with the default schedule. */
  async function create(hoursOut = 48, offsets = [720, 240, 120]) {
    const result = await createApproval({
      organizationId: agency.organization.id,
      clientName: "ABC Clothing",
      clientEmail: "sarah@example.com",
      contactName: "Sarah",
      creativeName: "Instagram Reel #14",
      deadline: new Date(Date.now() + hours(hoursOut)),
      reminderOffsets: offsets,
      slackChannelId: CHANNEL,
    });
    h.email.clear();
    h.slack.clear();
    return result;
  }

  // -------------------------------------------------------------------------
  // Firing
  // -------------------------------------------------------------------------

  it("sends nothing before a reminder is due", async () => {
    await create(48);
    const result = await runReminderSweep(new Date());

    expect(result).toMatchObject({ considered: 0, sent: 0 });
    expect(h.email.outbox).toHaveLength(0);
  });

  it("sends the first reminder once its moment arrives", async () => {
    const { approval } = await create(48);
    // 12 hours before a deadline 48 hours out.
    const when = new Date(new Date(approval.deadline).getTime() - hours(12) + minutes(1));

    const result = await runReminderSweep(when);

    expect(result.sent).toBe(1);
    expect(h.email.messagesTo("sarah@example.com")).toHaveLength(1);
    expect(h.email.outbox[0]!.subject).toContain("Reminder");

    const reminders = await listReminders(agency.organization.id, approval.id);
    expect(reminders[0]!.status).toBe("sent");
    expect(reminders[0]!.sent_at).not.toBeNull();
    expect(reminders[1]!.status).toBe("pending");
  });

  it("puts a working link in the reminder, since the token cannot be rebuilt", async () => {
    const { approval } = await create(48);
    await runReminderSweep(
      new Date(new Date(approval.deadline).getTime() - hours(12) + minutes(1)),
    );

    const link = h.email.outbox[0]!.text.match(/https:\/\/chaser\.test\/approve\/r\/\S+/);
    expect(link).not.toBeNull();

    const { loadForClient } = await import("@/lib/approvals/service");
    const pointer = link![0].replace("https://chaser.test/approve/r/", "");
    await expect(
      loadForClient({ kind: "pointer", value: pointer }),
    ).resolves.toMatchObject({ id: approval.id });
  });

  it("sends every overdue-but-unsent reminder in one sweep", async () => {
    const { approval } = await create(48);
    // Two hours before the deadline: all three moments have passed.
    const when = new Date(new Date(approval.deadline).getTime() - hours(2) + minutes(1));

    const result = await runReminderSweep(when);
    expect(result.sent).toBe(3);
    expect(h.email.outbox).toHaveLength(3);
  });

  it("marks only the final message as the deadline warning", async () => {
    const { approval } = await create(48);
    await runReminderSweep(
      new Date(new Date(approval.deadline).getTime() - hours(2) + minutes(1)),
    );
    const subjects = h.email.outbox.map((m) => m.subject);
    expect(subjects.filter((s) => s.startsWith("Deadline today"))).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------------------

  it("does not send the same reminder twice across repeated sweeps", async () => {
    const { approval } = await create(48);
    const when = new Date(new Date(approval.deadline).getTime() - hours(12) + minutes(1));

    await runReminderSweep(when);
    await runReminderSweep(when);
    await runReminderSweep(when);

    expect(h.email.outbox).toHaveLength(1);
  });

  it("sends once when two sweeps run at the same moment", async () => {
    const { approval } = await create(48);
    const when = new Date(new Date(approval.deadline).getTime() - hours(12) + minutes(1));

    const [a, b] = await Promise.all([
      runReminderSweep(when),
      runReminderSweep(when),
    ]);

    expect(a.sent + b.sent).toBe(1);
    expect(h.email.outbox).toHaveLength(1);
  });

  it("lets only one caller claim a reminder", async () => {
    const { approval } = await create(48);
    const [due] = await findDueReminders(
      new Date(new Date(approval.deadline).getTime() - hours(12) + minutes(1)),
    );

    expect(await claimReminder(due!.id)).toBeDefined();
    // The second claim finds no row still pending.
    expect(await claimReminder(due!.id)).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Stopping
  // -------------------------------------------------------------------------

  it("stops all reminders once the client approves", async () => {
    const created = await createApproval({
      organizationId: agency.organization.id,
      clientName: "ABC Clothing",
      clientEmail: "sarah@example.com",
      creativeName: "Instagram Reel #14",
      deadline: new Date(Date.now() + hours(48)),
      reminderOffsets: [720, 240, 120],
      slackChannelId: CHANNEL,
    });
    const token = tokenFrom(h.email.outbox[0]!.text);
    h.email.clear();

    await approveByToken({ kind: "token", value: token });

    const when = new Date(
      new Date(created.approval.deadline).getTime() - hours(2) + minutes(1),
    );
    const result = await runReminderSweep(when);

    expect(result.sent).toBe(0);
    // Only the approval receipt, no chasing.
    expect(h.email.outbox.every((m) => !m.subject.startsWith("Reminder"))).toBe(true);
  });

  it("stops the current sequence when changes are requested", async () => {
    const created = await createApproval({
      organizationId: agency.organization.id,
      clientName: "ABC Clothing",
      clientEmail: "sarah@example.com",
      creativeName: "Instagram Reel #14",
      deadline: new Date(Date.now() + hours(48)),
      reminderOffsets: [720, 240, 120],
      slackChannelId: CHANNEL,
    });
    const token = tokenFrom(h.email.outbox[0]!.text);

    await requestChangesByToken({ kind: "token", value: token }, "Swap the opening shot");
    h.email.clear();

    const when = new Date(
      new Date(created.approval.deadline).getTime() - hours(2) + minutes(1),
    );
    expect((await runReminderSweep(when)).sent).toBe(0);
    expect(h.email.outbox).toHaveLength(0);
  });

  it("stops reminders when the agency cancels", async () => {
    const { approval } = await create(48);
    await cancelApproval({
      organizationId: agency.organization.id,
      approvalId: approval.id,
    });

    const when = new Date(new Date(approval.deadline).getTime() - hours(2) + minutes(1));
    expect((await runReminderSweep(when)).sent).toBe(0);
  });

  it("gives a reopened approval a fresh sequence without resending the old one", async () => {
    const created = await createApproval({
      organizationId: agency.organization.id,
      clientName: "ABC Clothing",
      clientEmail: "sarah@example.com",
      creativeName: "Instagram Reel #14",
      deadline: new Date(Date.now() + hours(48)),
      reminderOffsets: [720, 240, 120],
      slackChannelId: CHANNEL,
    });
    const token = tokenFrom(h.email.outbox[0]!.text);

    // Round one: one reminder goes out, then the client asks for changes.
    await runReminderSweep(
      new Date(new Date(created.approval.deadline).getTime() - hours(12) + minutes(1)),
    );
    await requestChangesByToken({ kind: "token", value: token }, "Swap the opening shot");
    h.email.clear();

    // Round two.
    const reopened = await rescheduleApproval({
      organizationId: agency.organization.id,
      approvalId: created.approval.id,
      deadline: new Date(Date.now() + hours(96)),
      reminderOffsets: [720, 240, 120],
    });
    expect(reopened.status).toBe("waiting");
    expect(reopened.reminder_cycle).toBe(2);

    const all = await listReminders(agency.organization.id, created.approval.id);
    // Cycle one's record survives intact; cycle two is freshly pending.
    expect(all.filter((r) => r.cycle === 1 && r.status === "sent")).toHaveLength(1);
    expect(all.filter((r) => r.cycle === 2 && r.status === "pending")).toHaveLength(3);

    const sent = await runReminderSweep(
      new Date(new Date(reopened.deadline).getTime() - hours(2) + minutes(1)),
    );
    expect(sent.sent).toBe(3);
  });

  it("revives skipped reminders when the deadline moves further out", async () => {
    // Deadline in three hours: the 12h and 4h nudges start out skipped.
    const { approval } = await create(3);
    expect(
      (await listReminders(agency.organization.id, approval.id)).map((r) => r.status),
    ).toEqual(["skipped", "skipped", "pending"]);

    await rescheduleApproval({
      organizationId: agency.organization.id,
      approvalId: approval.id,
      deadline: new Date(Date.now() + hours(72)),
    });

    expect(
      (await listReminders(agency.organization.id, approval.id)).map((r) => r.status),
    ).toEqual(["pending", "pending", "pending"]);
  });

  it("actually schedules new reminders when an overdue approval's deadline is pushed out", async () => {
    // Every cycle-1 reminder gets consumed by the time an approval goes
    // overdue — sent if it fired before the deadline, cancelled if it was
    // still pending when the overdue sweep ran. Rescheduling has to give the
    // new sequence a cycle where those reminder_number slots are free, or
    // the new rows are silently discarded by the upsert's own guard.
    const { approval } = await create(4, [720, 240, 120]);
    await runOverdueSweep(new Date(new Date(approval.deadline).getTime() + minutes(5)));
    expect(
      (await listReminders(agency.organization.id, approval.id)).every(
        (r) => r.status !== "pending",
      ),
    ).toBe(true);
    h.email.clear();

    const reopened = await rescheduleApproval({
      organizationId: agency.organization.id,
      approvalId: approval.id,
      deadline: new Date(Date.now() + hours(48)),
      reminderOffsets: [720, 240, 120],
    });
    expect(reopened.status).toBe("viewed");
    expect(reopened.reminder_cycle).toBe(2);

    const fresh = await listReminders(agency.organization.id, approval.id);
    expect(fresh.filter((r) => r.cycle === 2 && r.status === "pending")).toHaveLength(3);

    // And the sweep can actually reach them before the new deadline.
    const sent = await runReminderSweep(
      new Date(new Date(reopened.deadline).getTime() - hours(2) + minutes(1)),
    );
    expect(sent.sent).toBe(3);
    expect(h.email.messagesTo("sarah@example.com").length).toBeGreaterThan(0);
  });

  it("resolves a claimed reminder directly, since cancelPendingReminders alone cannot reach it", async () => {
    // This is the exact mechanism behind the bug the sweep's re-check guards
    // against: the approval can be decided in the narrow window between
    // findDueReminders reading a row as due and the sweep's chaseability
    // check running for it (a real window when many reminders are due in one
    // sweep and earlier ones take time to process). claimReminder has
    // already moved the row from 'pending' to 'sending' by then, and
    // cancelPendingReminders' own WHERE clause only ever matches 'pending'
    // rows — so, reproduced directly:
    const { approval } = await create(48);
    const [due] = await findDueReminders(
      new Date(new Date(approval.deadline).getTime() - hours(12) + minutes(1)),
    );
    const claimed = await claimReminder(due!.id);
    expect(claimed!.status).toBe("sending");

    // The bug: this call alone, the only thing the sweep did before the fix,
    // leaves a 'sending' row untouched.
    await cancelPendingReminders(agency.organization.id, approval.id);
    const stillStuck = (await listReminders(agency.organization.id, approval.id)).find(
      (r) => r.id === claimed!.id,
    );
    expect(stillStuck!.status).toBe("sending");

    // The fix: resolve the claimed row itself.
    await markReminderCancelled(claimed!.id);
    const resolved = (await listReminders(agency.organization.id, approval.id)).find(
      (r) => r.id === claimed!.id,
    );
    expect(resolved!.status).toBe("cancelled");

    // And once cancelled, it is truly done — not eligible to be picked up
    // by any later sweep, unlike a row stuck at 'sending' which is also
    // never picked up again but for the wrong reason: nothing ever resolves it.
    expect(await claimReminder(claimed!.id)).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Escalation
  // -------------------------------------------------------------------------

  it("tells the agency in Slack when the deadline warning goes out", async () => {
    const { approval } = await create(48);
    await runReminderSweep(
      new Date(new Date(approval.deadline).getTime() - hours(2) + minutes(1)),
    );

    const atRisk = h.slack.posted.find((p) => p.text.startsWith("At risk:"));
    expect(atRisk).toBeDefined();
    expect(atRisk!.threadTs).toBe(approval.slack_message_ts);

    const types = (await listEvents(agency.organization.id, approval.id)).map(
      (e) => e.event_type,
    );
    expect(types).toContain("agency_notified");
  });

  it("marks an approval overdue once the deadline passes", async () => {
    const { approval } = await create(4);
    const after = new Date(new Date(approval.deadline).getTime() + minutes(5));

    const result = await runOverdueSweep(after);

    expect(result.markedOverdue).toBe(1);
    expect((await getApproval(agency.organization.id, approval.id))!.status).toBe(
      "overdue",
    );
  });

  it("escalates an overdue approval to Slack exactly once", async () => {
    const { approval } = await create(4);
    const after = new Date(new Date(approval.deadline).getTime() + minutes(5));

    await runOverdueSweep(after);
    await runOverdueSweep(after);
    await runOverdueSweep(new Date(after.getTime() + hours(1)));

    const overdueMessages = h.slack.posted.filter((p) =>
      p.text.startsWith("Overdue:"),
    );
    expect(overdueMessages).toHaveLength(1);
  });

  it("cancels the pre-deadline sequence when an approval goes overdue", async () => {
    const { approval } = await create(4, [720, 240, 120]);
    await runOverdueSweep(new Date(new Date(approval.deadline).getTime() + minutes(5)));

    const reminders = await listReminders(agency.organization.id, approval.id);
    expect(reminders.every((r) => r.status !== "pending")).toBe(true);
  });

  it("leaves a decided approval alone in the overdue sweep", async () => {
    const created = await createApproval({
      organizationId: agency.organization.id,
      clientName: "ABC Clothing",
      clientEmail: "sarah@example.com",
      creativeName: "Instagram Reel #14",
      deadline: new Date(Date.now() + hours(4)),
      reminderOffsets: [120],
      slackChannelId: CHANNEL,
    });
    await approveByToken({
      kind: "token",
      value: tokenFrom(h.email.outbox[0]!.text),
    });

    const result = await runOverdueSweep(
      new Date(new Date(created.approval.deadline).getTime() + minutes(5)),
    );
    expect(result.markedOverdue).toBe(0);
    expect(
      (await getApproval(agency.organization.id, created.approval.id))!.status,
    ).toBe("approved");
  });

  it("records the overdue transition in the audit trail", async () => {
    const { approval } = await create(4);
    await runOverdueSweep(new Date(new Date(approval.deadline).getTime() + minutes(5)));

    const types = (await listEvents(agency.organization.id, approval.id)).map(
      (e) => e.event_type,
    );
    expect(types).toContain("approval_overdue");
  });

  // -------------------------------------------------------------------------
  // Manual reminders
  // -------------------------------------------------------------------------

  it("sends a manual reminder on demand", async () => {
    const { approval } = await create(48);

    await sendManualReminder({
      organizationId: agency.organization.id,
      approvalId: approval.id,
      actorSlackUserId: "U_LEAD",
    });

    expect(h.email.messagesTo("sarah@example.com")).toHaveLength(1);
    const manual = (await listReminders(agency.organization.id, approval.id)).find(
      (r) => r.kind === "manual",
    );
    expect(manual!.status).toBe("sent");
  });

  it("does not consume a scheduled reminder when one is sent by hand", async () => {
    const { approval } = await create(48);
    await sendManualReminder({
      organizationId: agency.organization.id,
      approvalId: approval.id,
    });

    const scheduled = (
      await listReminders(agency.organization.id, approval.id)
    ).filter((r) => r.kind !== "manual");
    expect(scheduled.every((r) => r.status === "pending")).toBe(true);
  });

  it("refuses a manual reminder on an approval nobody is waiting on", async () => {
    const { approval } = await create(48);
    await cancelApproval({
      organizationId: agency.organization.id,
      approvalId: approval.id,
    });

    await expect(
      sendManualReminder({
        organizationId: agency.organization.id,
        approvalId: approval.id,
      }),
    ).rejects.toThrow(/nothing to chase/);
  });

  // -------------------------------------------------------------------------
  // Failure handling
  // -------------------------------------------------------------------------

  it("retries a reminder whose send failed, rather than losing it", async () => {
    const { approval } = await create(48);
    const when = new Date(new Date(approval.deadline).getTime() - hours(12) + minutes(1));

    const { setEmailProvider } = await import("@/lib/email");
    setEmailProvider({
      name: "broken",
      async send() {
        throw new Error("SMTP exploded");
      },
    });

    const failed = await runReminderSweep(when);
    expect(failed.failed).toBe(1);

    const afterFailure = (
      await listReminders(agency.organization.id, approval.id)
    )[0]!;
    expect(afterFailure.status).toBe("pending");
    expect(afterFailure.attempts).toBe(1);
    expect(afterFailure.last_error).toContain("SMTP exploded");

    // The next sweep, with a working provider, delivers it.
    setEmailProvider(h.email);
    expect((await runReminderSweep(when)).sent).toBe(1);
  });

  it("gives up on a reminder after its attempts run out", async () => {
    const { approval } = await create(48);
    const when = new Date(new Date(approval.deadline).getTime() - hours(12) + minutes(1));

    const { setEmailProvider } = await import("@/lib/email");
    setEmailProvider({
      name: "broken",
      async send() {
        throw new Error("SMTP exploded");
      },
    });

    await runReminderSweep(when);
    await runReminderSweep(when);
    await runReminderSweep(when);

    const stuck = (await listReminders(agency.organization.id, approval.id))[0]!;
    expect(stuck.status).toBe("failed");
    expect(stuck.attempts).toBe(3);

    setEmailProvider(h.email);
  });
});
