import type { ApprovalStatus } from "@/lib/db/types";

/**
 * The approval state machine.
 *
 * Every status change in the system goes through `assertTransition`. Nothing
 * writes `approvals.status` directly, and nothing the client sends is trusted
 * to name a target state — the server picks the target from the action and
 * then checks that the move is legal from where the row actually is.
 */

export const ALLOWED_TRANSITIONS: Record<ApprovalStatus, readonly ApprovalStatus[]> = {
  // Created but not yet sent to the client.
  draft: ["waiting", "cancelled"],

  // Email sent, nothing heard back.
  waiting: ["viewed", "approved", "changes_requested", "overdue", "cancelled"],

  // The client opened the link. Opening is what moves waiting -> viewed, so
  // in practice decisions arrive from here.
  viewed: ["approved", "changes_requested", "overdue", "cancelled"],

  // Past the deadline with no decision. A late client can still respond, and
  // a late approval is worth far more than a tidy state diagram.
  overdue: ["viewed", "approved", "changes_requested", "cancelled"],

  // The client wants edits. The agency uploads a new cut and reopens the
  // request, which starts a fresh reminder sequence.
  changes_requested: ["waiting", "cancelled"],

  // Terminal.
  approved: [],
  cancelled: [],
} as const;

/** Statuses where the client still owes an answer. */
export const OPEN_STATUSES: readonly ApprovalStatus[] = [
  "waiting",
  "viewed",
  "overdue",
];

/** Statuses where a pending reminder should still be allowed to fire. */
export const CHASEABLE_STATUSES: readonly ApprovalStatus[] = ["waiting", "viewed"];

/** Statuses that can never change again. */
export const TERMINAL_STATUSES: readonly ApprovalStatus[] = [
  "approved",
  "cancelled",
];

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: ApprovalStatus,
    readonly to: ApprovalStatus,
  ) {
    super(`Cannot move an approval from "${from}" to "${to}".`);
    this.name = "InvalidTransitionError";
  }
}

export function canTransition(
  from: ApprovalStatus,
  to: ApprovalStatus,
): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(
  from: ApprovalStatus,
  to: ApprovalStatus,
): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export function isOpen(status: ApprovalStatus): boolean {
  return OPEN_STATUSES.includes(status);
}

export function isChaseable(status: ApprovalStatus): boolean {
  return CHASEABLE_STATUSES.includes(status);
}

export function isTerminal(status: ApprovalStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Wording for Slack, email and the client page. */
export function statusLabel(status: ApprovalStatus): string {
  const labels: Record<ApprovalStatus, string> = {
    draft: "Draft",
    waiting: "Waiting",
    viewed: "Viewed",
    approved: "Approved",
    changes_requested: "Changes requested",
    overdue: "Overdue",
    cancelled: "Cancelled",
  };
  return labels[status];
}
