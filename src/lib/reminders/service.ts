import {
  appendEvent,
  cancelPendingReminders,
  claimReminder,
  findDueReminders,
  findOverdueApprovals,
  getApproval,
  markAgencyNotifiedOverdue,
  markReminderFailed,
  markReminderSent,
  recordManualReminder,
  transitionApproval,
} from "@/lib/db/repositories";
import { isChaseable, assertTransition } from "@/lib/approvals/state";
import { reminderUrl } from "@/lib/approvals/service";
import { getEmailProvider } from "@/lib/email";
import { deadlineWarningEmail, reminderEmail, type EmailContext } from "@/lib/email/templates";
import { getReminderMessageGenerator } from "@/lib/ai";
import type { ReminderTone } from "@/lib/ai/generator";
import { formatDeadline, humanDuration } from "@/lib/format";
import {
  announceStatusChange,
  refreshApprovalMessage,
  replyInThread,
} from "@/lib/notifications/service";
import { atRiskReply, overdueReply, reminderSentReply } from "@/lib/slack/blocks";
import type { ApprovalWithClient } from "@/lib/db/types";

/**
 * The chaser.
 *
 * This is the part of the product that has to be boring and exactly right.
 * Two properties matter:
 *
 *   Deterministic — a reminder goes out because its row says so and its
 *   approval is still open. No heuristics, and nothing generated decides
 *   whether to send; the wording layer is called after the decision is made.
 *
 *   Idempotent — `claimReminder` is a conditional UPDATE, so two cron runs
 *   overlapping on the same row produce exactly one email. The loser gets
 *   nothing back and sends nothing.
 */

export interface SweepResult {
  considered: number;
  sent: number;
  skipped: number;
  failed: number;
}

function contextFor(
  approval: ApprovalWithClient,
  url: string,
): EmailContext {
  return {
    agencyName: approval.organization_name,
    clientName: approval.client_name,
    contactName: approval.client_contact_name,
    creativeName: approval.creative_name,
    creativeVersion: approval.creative_version,
    creativeUrl: approval.creative_url,
    deadline: new Date(approval.deadline),
    timezone: approval.organization_timezone,
    approvalUrl: url,
    notes: approval.notes,
  };
}

function toneFor(reminderNumber: number, isWarning: boolean): ReminderTone {
  if (isWarning) return "urgent";
  return reminderNumber <= 1 ? "friendly" : "neutral";
}

/** Compose and deliver one chase email. Shared by scheduled and manual sends. */
async function deliverReminder(input: {
  approval: ApprovalWithClient;
  reminderNumber: number;
  isDeadlineWarning: boolean;
  now: Date;
  idempotencyKey: string;
}): Promise<void> {
  const { approval, now } = input;
  const deadline = new Date(approval.deadline);

  // The plaintext token is not stored — only its hash — so a reminder cannot
  // rebuild the original link. It carries a signed pointer to the approval
  // instead, which grants exactly the same thing and nothing more.
  const url = reminderUrl(approval.id);

  const body = await getReminderMessageGenerator().generate({
    agencyName: approval.organization_name,
    clientName: approval.client_name,
    contactName: approval.client_contact_name,
    creativeName: approval.creative_name,
    reminderNumber: input.reminderNumber,
    timeRemaining: humanDuration(deadline.getTime() - now.getTime()),
    deadline: formatDeadline(deadline, approval.organization_timezone),
    tone: toneFor(input.reminderNumber, input.isDeadlineWarning),
    isDeadlineWarning: input.isDeadlineWarning,
  });

  const context = contextFor(approval, url);
  const message = input.isDeadlineWarning
    ? deadlineWarningEmail(context, body)
    : reminderEmail(context, body);

  await getEmailProvider().send({
    ...message,
    to: approval.client_email,
    idempotencyKey: input.idempotencyKey,
  });
}

/**
 * Send every reminder that is due.
 *
 * Called by the cron endpoint. Safe to call at any frequency and safe to run
 * twice concurrently.
 */
export async function runReminderSweep(
  now = new Date(),
  limit = 100,
): Promise<SweepResult> {
  const due = await findDueReminders(now, limit);
  const result: SweepResult = {
    considered: due.length,
    sent: 0,
    skipped: 0,
    failed: 0,
  };

  for (const row of due) {
    const claimed = await claimReminder(row.id);
    if (!claimed) {
      // Another worker got there first. Correct outcome, not an error.
      result.skipped += 1;
      continue;
    }

    try {
      const approval = await getApproval(claimed.organization_id, claimed.approval_id);

      // Re-check under the claim: the client may have approved in the seconds
      // between the query and now.
      if (!approval || !isChaseable(approval.status)) {
        await cancelPendingReminders(claimed.organization_id, claimed.approval_id);
        result.skipped += 1;
        continue;
      }

      const isWarning = claimed.kind === "deadline_warning";
      await deliverReminder({
        approval,
        reminderNumber: claimed.reminder_number,
        isDeadlineWarning: isWarning,
        now,
        idempotencyKey: `reminder:${claimed.id}`,
      });

      await markReminderSent(claimed.id);
      await appendEvent({
        organizationId: approval.organization_id,
        approvalId: approval.id,
        eventType: "reminder_sent",
        metadata: {
          reminder_number: claimed.reminder_number,
          kind: claimed.kind,
          to: approval.client_email,
        },
      });

      await replyInThread(
        approval,
        reminderSentReply(approval, claimed.reminder_number, false),
      );

      // The final pre-deadline nudge is also the moment the agency should
      // hear about it, while there is still time to pick up the phone.
      if (isWarning) {
        await replyInThread(approval, atRiskReply(approval, now));
        await appendEvent({
          organizationId: approval.organization_id,
          approvalId: approval.id,
          eventType: "agency_notified",
          metadata: { reason: "at_risk", reminder_number: claimed.reminder_number },
        });
      }

      result.sent += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await markReminderFailed(claimed.id, message);
      console.error(`[reminders] ${claimed.id} failed:`, message);
      result.failed += 1;
    }
  }

  return result;
}

/** The "Send reminder" button. Outside the sequence, and never duplicated. */
export async function sendManualReminder(input: {
  organizationId: string;
  approvalId: string;
  actorSlackUserId?: string | null;
  now?: Date;
}): Promise<ApprovalWithClient> {
  const now = input.now ?? new Date();
  const approval = await getApproval(input.organizationId, input.approvalId);
  if (!approval) throw new Error("Approval not found.");
  if (!isChaseable(approval.status)) {
    throw new Error(
      `This approval is ${approval.status}, so there is nothing to chase.`,
    );
  }

  await deliverReminder({
    approval,
    reminderNumber: 0,
    isDeadlineWarning: false,
    now,
    // Timestamped so a deliberate second press does go out — unlike the
    // scheduled path, a human pressing the button twice means it.
    idempotencyKey: `manual:${approval.id}:${now.getTime()}`,
  });

  await recordManualReminder(
    input.organizationId,
    input.approvalId,
    approval.reminder_cycle,
  );
  await appendEvent({
    organizationId: input.organizationId,
    approvalId: input.approvalId,
    eventType: "reminder_sent",
    actorType: "agency_user",
    actorId: input.actorSlackUserId ?? null,
    metadata: { kind: "manual", to: approval.client_email },
  });

  await replyInThread(approval, reminderSentReply(approval, 0, true));
  return approval;
}

/**
 * Move past-deadline approvals to overdue and tell the agency once.
 *
 * `markAgencyNotifiedOverdue` is a conditional UPDATE, so the escalation
 * message is posted exactly once however many times this sweep runs.
 */
export async function runOverdueSweep(
  now = new Date(),
  limit = 200,
): Promise<{ considered: number; markedOverdue: number; notified: number }> {
  const candidates = await findOverdueApprovals(now, limit);
  let markedOverdue = 0;
  let notified = 0;

  for (const candidate of candidates) {
    assertTransition(candidate.status, "overdue");
    const moved = await transitionApproval({
      organizationId: candidate.organization_id,
      approvalId: candidate.id,
      from: ["waiting", "viewed"],
      to: "overdue",
    });
    if (!moved) continue;
    markedOverdue += 1;

    // Past the deadline the pre-deadline sequence is meaningless.
    await cancelPendingReminders(candidate.organization_id, candidate.id);
    await appendEvent({
      organizationId: candidate.organization_id,
      approvalId: candidate.id,
      eventType: "approval_overdue",
      metadata: { deadline: new Date(candidate.deadline).toISOString() },
    });

    const fresh = await getApproval(candidate.organization_id, candidate.id);
    if (!fresh) continue;

    if (await markAgencyNotifiedOverdue(fresh.organization_id, fresh.id)) {
      await announceStatusChange(fresh, overdueReply(fresh));
      await appendEvent({
        organizationId: fresh.organization_id,
        approvalId: fresh.id,
        eventType: "agency_notified",
        metadata: { reason: "overdue" },
      });
      notified += 1;
    } else {
      await refreshApprovalMessage(fresh);
    }
  }

  return { considered: candidates.length, markedOverdue, notified };
}
