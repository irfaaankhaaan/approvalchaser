import { env } from "@/lib/env";
import {
  appendEvent,
  cancelPendingReminders,
  findApprovalByIdUnscoped,
  findApprovalByTokenHash,
  getApproval,
  insertApproval,
  listEvents,
  listReminders,
  replaceReminderSequence,
  setApprovalDeadline,
  startNewReminderCycle,
  transitionApproval,
  upsertClient,
} from "@/lib/db/repositories";
import {
  generateApprovalToken,
  hashApprovalToken,
  looksLikeApprovalToken,
} from "@/lib/crypto/tokens";
import { assertTransition, isTerminal } from "@/lib/approvals/state";
import { mintReminderLink, readReminderLink } from "@/lib/crypto/reminder-link";
import { planReminders } from "@/lib/reminders/schedule";
import { getEmailProvider } from "@/lib/email";
import {
  approvalConfirmationEmail,
  approvalRequestEmail,
  changesRequestedEmail,
  type EmailContext,
} from "@/lib/email/templates";
import {
  announceStatusChange,
  publishApprovalMessage,
  refreshApprovalMessage,
} from "@/lib/notifications/service";
import { approvedReply, changesRequestedReply } from "@/lib/slack/blocks";
import type { ApprovalStatus, ApprovalWithClient } from "@/lib/db/types";

/**
 * The approval engine.
 *
 * Two invariants hold everywhere in this file:
 *
 *   1. A status is never written directly. `assertTransition` checks the move
 *      is legal, then the repository's compare-and-set only lands it if the
 *      row is still where we thought it was. Two clients clicking Approve and
 *      Request changes at the same moment cannot both win.
 *
 *   2. Reminders follow status, automatically. Anything that closes or pauses
 *      an approval cancels its pending reminders in the same call, so there is
 *      no path that leaves a chaser running against a decided approval.
 */

export class ApprovalError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_found"
      | "expired"
      | "already_decided"
      | "invalid_state"
      | "invalid_input",
  ) {
    super(message);
    this.name = "ApprovalError";
  }
}

export function approvalUrl(token: string): string {
  return `${env.appUrl}/approve/${token}`;
}

export function reminderUrl(approvalId: string): string {
  return `${env.appUrl}/approve/r/${mintReminderLink(approvalId)}`;
}

/**
 * How a client proves they may act on an approval.
 *
 * Two forms, both bearer credentials for exactly one approval and nothing
 * else: the high-entropy token from the original email, and the signed
 * pointer carried by reminders (needed because the token is stored only as a
 * hash and cannot be reproduced later). Everything client-facing takes this
 * union, so approve and request-changes have one implementation each rather
 * than one per link format.
 */
export type ClientCredential =
  | { kind: "token"; value: string }
  | { kind: "pointer"; value: string };

/** The link to put in front of this client, matching how they arrived. */
function clientUrl(credential: ClientCredential, approvalId: string): string {
  return credential.kind === "token"
    ? approvalUrl(credential.value)
    : reminderUrl(approvalId);
}

function emailContext(
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

/**
 * Schedule (or reschedule) the chasing sequence for an approval.
 *
 * Reminders whose moment has already passed are written as 'skipped' rather
 * than fired: creating an approval an hour before its deadline should not
 * dispatch the 12-hour and 4-hour nudges retroactively, all at once.
 */
export async function scheduleReminders(
  approval: {
    id: string;
    organization_id: string;
    deadline: Date | string;
    reminder_offsets: number[];
    reminder_cycle?: number;
  },
  now = new Date(),
): Promise<void> {
  const planned = planReminders({
    deadline: new Date(approval.deadline),
    offsetsMinutes: approval.reminder_offsets,
    now,
  });

  await replaceReminderSequence({
    organizationId: approval.organization_id,
    approvalId: approval.id,
    cycle: approval.reminder_cycle ?? 1,
    reminders: planned.map((reminder) => ({
      reminderNumber: reminder.reminderNumber,
      kind: reminder.kind,
      scheduledFor: reminder.scheduledFor,
      status: reminder.alreadyPast ? "skipped" : "pending",
    })),
  });

  await appendEvent({
    organizationId: approval.organization_id,
    approvalId: approval.id,
    eventType: "reminder_scheduled",
    metadata: {
      cycle: approval.reminder_cycle ?? 1,
      scheduled: planned.filter((r) => !r.alreadyPast).length,
      skipped: planned.filter((r) => r.alreadyPast).length,
      offsets: approval.reminder_offsets,
    },
  });
}

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

export interface CreateApprovalInput {
  organizationId: string;
  createdBy?: string | null;
  actorSlackUserId?: string | null;
  clientName: string;
  clientEmail: string;
  contactName?: string | null;
  creativeName: string;
  creativeUrl?: string | null;
  creativeVersion?: string | null;
  notes?: string | null;
  deadline: Date;
  reminderOffsets: number[];
  /** Where to post the Slack message. Omitted when created over HTTP. */
  slackChannelId?: string | null;
}

export async function createApproval(
  input: CreateApprovalInput,
  now = new Date(),
): Promise<{ approval: ApprovalWithClient; approvalUrl: string }> {
  if (input.deadline.getTime() <= now.getTime()) {
    throw new ApprovalError("The deadline has to be in the future.", "invalid_input");
  }

  const client = await upsertClient({
    organizationId: input.organizationId,
    name: input.clientName,
    email: input.clientEmail,
    contactName: input.contactName,
  });

  // The plaintext token exists only in this function and in the email. What
  // the database gets is its SHA-256.
  const token = generateApprovalToken();
  const url = approvalUrl(token);

  const created = await insertApproval({
    organizationId: input.organizationId,
    clientId: client.id,
    createdBy: input.createdBy,
    creativeName: input.creativeName,
    creativeUrl: input.creativeUrl,
    creativeVersion: input.creativeVersion,
    notes: input.notes,
    deadline: input.deadline,
    // Born as a draft. It only becomes "waiting" once the client has actually
    // been written to, so a failed send never looks like a sent request.
    status: "draft",
    secureTokenHash: hashApprovalToken(token),
    tokenExpiresAt: new Date(
      Math.max(
        input.deadline.getTime(),
        now.getTime() + env.approvalTokenTtlDays * 86_400_000,
      ),
    ),
    reminderOffsets: input.reminderOffsets,
  });

  await appendEvent({
    organizationId: input.organizationId,
    approvalId: created.id,
    eventType: "approval_created",
    actorType: input.actorSlackUserId ? "agency_user" : "system",
    actorId: input.actorSlackUserId ?? null,
    metadata: {
      creative_name: input.creativeName,
      client_email: input.clientEmail,
      deadline: input.deadline.toISOString(),
      reminder_offsets: input.reminderOffsets,
    },
  });

  const approval = (await getApproval(input.organizationId, created.id))!;

  // Send first, promote second.
  const message = approvalRequestEmail(emailContext(approval, url));
  await getEmailProvider().send({
    ...message,
    to: approval.client_email,
    idempotencyKey: `approval:${approval.id}:request`,
  });

  await appendEvent({
    organizationId: input.organizationId,
    approvalId: created.id,
    eventType: "email_sent",
    metadata: { kind: "approval_request", to: approval.client_email },
  });

  assertTransition("draft", "waiting");
  const promoted = await transitionApproval({
    organizationId: input.organizationId,
    approvalId: created.id,
    from: ["draft"],
    to: "waiting",
  });
  if (!promoted) {
    throw new ApprovalError("The approval was changed while being created.", "invalid_state");
  }

  await scheduleReminders(promoted, now);

  const live = (await getApproval(input.organizationId, created.id))!;
  if (input.slackChannelId) {
    await publishApprovalMessage(live, input.slackChannelId);
  }

  return {
    approval: (await getApproval(input.organizationId, created.id))!,
    approvalUrl: url,
  };
}

// ---------------------------------------------------------------------------
// The client side, reached only by token
// ---------------------------------------------------------------------------

/**
 * Resolve a credential to an approval.
 *
 * The token's shape is checked before the database is touched, and the
 * pointer's signature before its id is used, so malformed input never becomes
 * a query. An expired link is refused even though the row still exists — a
 * link that has outlived its purpose should stop working on its own.
 */
export async function loadForClient(
  credential: ClientCredential,
  now = new Date(),
): Promise<ApprovalWithClient> {
  const invalid = new ApprovalError("This approval link is not valid.", "not_found");

  let approval: ApprovalWithClient | undefined;

  if (credential.kind === "token") {
    if (!looksLikeApprovalToken(credential.value)) throw invalid;
    approval = await findApprovalByTokenHash(hashApprovalToken(credential.value));
  } else {
    const approvalId = readReminderLink(credential.value);
    if (!approvalId) throw invalid;
    approval = await findApprovalByIdUnscoped(approvalId);
  }

  if (!approval) throw invalid;
  if (new Date(approval.token_expires_at).getTime() < now.getTime()) {
    throw new ApprovalError("This approval link has expired.", "expired");
  }
  return approval;
}

/** Convenience for callers that only ever hold a token. */
export function tokenCredential(token: string): ClientCredential {
  return { kind: "token", value: token };
}

/** The client opened the page. First open moves waiting -> viewed. */
export async function recordClientView(
  credential: ClientCredential,
  now = new Date(),
): Promise<ApprovalWithClient> {
  const approval = await loadForClient(credential, now);

  await appendEvent({
    organizationId: approval.organization_id,
    approvalId: approval.id,
    eventType: "client_opened",
    actorType: "client",
    actorId: approval.client_email,
  });

  if (approval.status !== "waiting" && approval.status !== "overdue") {
    return approval;
  }

  assertTransition(approval.status, "viewed");
  const moved = await transitionApproval({
    organizationId: approval.organization_id,
    approvalId: approval.id,
    from: [approval.status],
    to: "viewed",
    markViewed: true,
  });
  if (!moved) return approval;

  await appendEvent({
    organizationId: approval.organization_id,
    approvalId: approval.id,
    eventType: "client_viewed",
    actorType: "client",
    actorId: approval.client_email,
  });

  const fresh = (await getApproval(approval.organization_id, approval.id))!;
  await refreshApprovalMessage(fresh);
  return fresh;
}

const DECIDABLE_FROM: ApprovalStatus[] = ["waiting", "viewed", "overdue"];

/** The client approved. */
export async function approveByToken(
  credential: ClientCredential,
  now = new Date(),
): Promise<ApprovalWithClient> {
  const approval = await loadForClient(credential, now);
  if (isTerminal(approval.status)) {
    throw new ApprovalError(
      "This approval has already been settled.",
      "already_decided",
    );
  }
  assertTransition(approval.status, "approved");

  const moved = await transitionApproval({
    organizationId: approval.organization_id,
    approvalId: approval.id,
    from: DECIDABLE_FROM,
    to: "approved",
    decidedAt: now,
    markViewed: true,
  });
  if (!moved) {
    throw new ApprovalError(
      "This approval has already been settled.",
      "already_decided",
    );
  }

  // Approved means stop. Nothing further is ever sent to this client.
  await cancelPendingReminders(approval.organization_id, approval.id);
  await appendEvent({
    organizationId: approval.organization_id,
    approvalId: approval.id,
    eventType: "client_approved",
    actorType: "client",
    actorId: approval.client_email,
  });

  const fresh = (await getApproval(approval.organization_id, approval.id))!;

  const receipt = approvalConfirmationEmail(
    emailContext(fresh, clientUrl(credential, fresh.id)),
  );
  try {
    await getEmailProvider().send({
      ...receipt,
      to: fresh.client_email,
      idempotencyKey: `approval:${fresh.id}:approved`,
    });
    await appendEvent({
      organizationId: fresh.organization_id,
      approvalId: fresh.id,
      eventType: "email_sent",
      metadata: { kind: "approval_confirmation", to: fresh.client_email },
    });
  } catch (error) {
    // The decision is already recorded; a failed receipt must not undo it.
    console.error("[email] confirmation failed:", error);
  }

  await announceStatusChange(fresh, approvedReply(fresh));
  await appendEvent({
    organizationId: fresh.organization_id,
    approvalId: fresh.id,
    eventType: "agency_notified",
    metadata: { reason: "approved" },
  });

  return fresh;
}

/** The client wants edits. */
export async function requestChangesByToken(
  credential: ClientCredential,
  comment: string,
  now = new Date(),
): Promise<ApprovalWithClient> {
  const trimmed = comment.trim();
  if (trimmed.length < 3) {
    throw new ApprovalError(
      "Please say what you'd like changed.",
      "invalid_input",
    );
  }

  const approval = await loadForClient(credential, now);
  if (isTerminal(approval.status)) {
    throw new ApprovalError(
      "This approval has already been settled.",
      "already_decided",
    );
  }
  assertTransition(approval.status, "changes_requested");

  const moved = await transitionApproval({
    organizationId: approval.organization_id,
    approvalId: approval.id,
    from: DECIDABLE_FROM,
    to: "changes_requested",
    decidedAt: now,
    decisionComment: trimmed.slice(0, 4000),
    markViewed: true,
  });
  if (!moved) {
    throw new ApprovalError(
      "This approval has already been settled.",
      "already_decided",
    );
  }

  // The current round is over. A new round gets a new sequence when the
  // agency reopens it with a fresh deadline.
  await cancelPendingReminders(approval.organization_id, approval.id);
  await appendEvent({
    organizationId: approval.organization_id,
    approvalId: approval.id,
    eventType: "changes_requested",
    actorType: "client",
    actorId: approval.client_email,
    metadata: { comment: trimmed.slice(0, 4000) },
  });

  const fresh = (await getApproval(approval.organization_id, approval.id))!;

  const receipt = changesRequestedEmail(
    emailContext(fresh, clientUrl(credential, fresh.id)),
    trimmed,
  );
  try {
    await getEmailProvider().send({
      ...receipt,
      to: fresh.client_email,
      idempotencyKey: `approval:${fresh.id}:changes`,
    });
    await appendEvent({
      organizationId: fresh.organization_id,
      approvalId: fresh.id,
      eventType: "email_sent",
      metadata: { kind: "changes_requested", to: fresh.client_email },
    });
  } catch (error) {
    console.error("[email] change-request receipt failed:", error);
  }

  await announceStatusChange(fresh, changesRequestedReply(fresh));
  await appendEvent({
    organizationId: fresh.organization_id,
    approvalId: fresh.id,
    eventType: "agency_notified",
    metadata: { reason: "changes_requested" },
  });

  return fresh;
}

// ---------------------------------------------------------------------------
// The agency side, always organization-scoped
// ---------------------------------------------------------------------------

export async function cancelApproval(input: {
  organizationId: string;
  approvalId: string;
  actorSlackUserId?: string | null;
}): Promise<ApprovalWithClient> {
  const approval = await getApproval(input.organizationId, input.approvalId);
  if (!approval) throw new ApprovalError("Approval not found.", "not_found");
  if (isTerminal(approval.status)) {
    throw new ApprovalError(
      `This approval is already ${approval.status}.`,
      "already_decided",
    );
  }
  assertTransition(approval.status, "cancelled");

  const moved = await transitionApproval({
    organizationId: input.organizationId,
    approvalId: input.approvalId,
    from: ["draft", "waiting", "viewed", "overdue", "changes_requested"],
    to: "cancelled",
  });
  if (!moved) {
    throw new ApprovalError("The approval changed underneath you.", "invalid_state");
  }

  await cancelPendingReminders(input.organizationId, input.approvalId);
  await appendEvent({
    organizationId: input.organizationId,
    approvalId: input.approvalId,
    eventType: "approval_cancelled",
    actorType: "agency_user",
    actorId: input.actorSlackUserId ?? null,
  });

  const fresh = (await getApproval(input.organizationId, input.approvalId))!;
  await refreshApprovalMessage(fresh);
  return fresh;
}

/**
 * Move the deadline, and recalculate everything that hangs off it.
 *
 * On a `changes_requested` approval this doubles as "reopen": a new deadline
 * is the agency saying the next cut is coming, which starts a fresh round and
 * a fresh reminder sequence.
 */
export async function rescheduleApproval(input: {
  organizationId: string;
  approvalId: string;
  deadline: Date;
  reminderOffsets?: number[];
  actorSlackUserId?: string | null;
  now?: Date;
}): Promise<ApprovalWithClient> {
  const now = input.now ?? new Date();
  const approval = await getApproval(input.organizationId, input.approvalId);
  if (!approval) throw new ApprovalError("Approval not found.", "not_found");
  if (isTerminal(approval.status)) {
    throw new ApprovalError(
      `A ${approval.status} approval cannot be rescheduled.`,
      "already_decided",
    );
  }
  if (input.deadline.getTime() <= now.getTime()) {
    throw new ApprovalError("The new deadline has to be in the future.", "invalid_input");
  }

  const previous = new Date(approval.deadline).toISOString();
  const updated = await setApprovalDeadline({
    organizationId: input.organizationId,
    approvalId: input.approvalId,
    deadline: input.deadline,
    reminderOffsets: input.reminderOffsets,
  });
  if (!updated) throw new ApprovalError("Approval not found.", "not_found");

  await appendEvent({
    organizationId: input.organizationId,
    approvalId: input.approvalId,
    eventType: "deadline_changed",
    actorType: "agency_user",
    actorId: input.actorSlackUserId ?? null,
    metadata: { from: previous, to: input.deadline.toISOString() },
  });

  // A reopened or previously-overdue approval goes back to waiting so that
  // the new sequence has something to chase.
  if (approval.status === "changes_requested" || approval.status === "overdue") {
    const target = approval.status === "overdue" ? "viewed" : "waiting";
    assertTransition(approval.status, target);
    await transitionApproval({
      organizationId: input.organizationId,
      approvalId: input.approvalId,
      from: [approval.status],
      to: target,
    });

    // Both paths leave the current cycle's reminder rows consumed — sent for
    // an approval that ran its course before going overdue, sent-or-cancelled
    // for one reopened after changes were requested. Either way, the new
    // schedule needs reminder_number slots that are still free: writing into
    // the old cycle would silently insert nothing (replaceReminderSequence
    // only touches pending/skipped rows), leaving the agency believing a
    // fresh sequence was scheduled when none was.
    await startNewReminderCycle(input.organizationId, input.approvalId);
  }

  const fresh = (await getApproval(input.organizationId, input.approvalId))!;
  await scheduleReminders(fresh, now);
  await refreshApprovalMessage(fresh);
  return fresh;
}

/** The detail view behind "View approval". */
export async function approvalDetail(
  organizationId: string,
  approvalId: string,
) {
  const approval = await getApproval(organizationId, approvalId);
  if (!approval) throw new ApprovalError("Approval not found.", "not_found");
  const [events, reminders] = await Promise.all([
    listEvents(organizationId, approvalId),
    listReminders(organizationId, approvalId),
  ]);
  return { approval, events, reminders };
}
