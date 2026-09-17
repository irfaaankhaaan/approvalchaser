import type { ApprovalStatus } from "@/lib/db/types";

/**
 * What `/approval list`, `/approval remind` and `/approval cancel` show by
 * default — everything the agency might still act on, including a
 * changes-requested approval waiting to be reopened. Shared between the
 * slash command and the interactions handler (list paging), so the two
 * never drift into showing different sets for the same view.
 */
export const OPEN_LIST_STATUSES: ApprovalStatus[] = [
  "waiting",
  "viewed",
  "overdue",
  "changes_requested",
];

/** `/approval list all` — the above, plus approved, for recent history. */
export const RECENT_LIST_STATUSES: ApprovalStatus[] = [
  ...OPEN_LIST_STATUSES,
  "approved",
];
