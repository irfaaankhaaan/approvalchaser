import { sql, sqlOne } from "@/lib/db/client";
import type {
  ActorType,
  Approval,
  ApprovalEvent,
  ApprovalStatus,
  ApprovalWithClient,
  Client,
  EventType,
  Organization,
  Reminder,
  ReminderKind,
  SlackInstallation,
  User,
} from "@/lib/db/types";

/**
 * The data layer.
 *
 * Rule for this file: any function that touches an organization-owned table
 * takes an organizationId and puts it in the WHERE clause. There is exactly
 * one deliberate exception — `findApprovalByTokenHash` — and it is documented
 * where it sits. Nothing here interpolates a value into SQL; every parameter
 * is bound.
 */

const APPROVAL_WITH_CLIENT_SELECT = `
  SELECT a.*,
         c.name         AS client_name,
         c.email        AS client_email,
         c.contact_name AS client_contact_name,
         o.name         AS organization_name,
         o.timezone     AS organization_timezone
    FROM approvals a
    JOIN clients c       ON c.id = a.client_id
    JOIN organizations o ON o.id = a.organization_id
`;

// ---------------------------------------------------------------------------
// Organizations and users
// ---------------------------------------------------------------------------

export async function createOrganization(
  name: string,
  timezone = "UTC",
): Promise<Organization> {
  const row = await sqlOne<Organization>(
    `INSERT INTO organizations (name, timezone) VALUES ($1, $2) RETURNING *`,
    [name, timezone],
  );
  return row!;
}

export async function getOrganization(
  id: string,
): Promise<Organization | undefined> {
  return sqlOne<Organization>(`SELECT * FROM organizations WHERE id = $1`, [id]);
}

export async function updateOrganizationTimezone(
  organizationId: string,
  timezone: string,
): Promise<void> {
  await sql(`UPDATE organizations SET timezone = $2 WHERE id = $1`, [
    organizationId,
    timezone,
  ]);
}

/** Find or create the agency-side user behind a Slack user id. */
export async function upsertUserBySlackId(input: {
  organizationId: string;
  slackUserId: string;
  name: string;
  email?: string | null;
}): Promise<User> {
  const existing = await sqlOne<User>(
    `SELECT * FROM users WHERE organization_id = $1 AND slack_user_id = $2`,
    [input.organizationId, input.slackUserId],
  );
  if (existing) return existing;

  const row = await sqlOne<User>(
    `INSERT INTO users (organization_id, slack_user_id, name, email)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (organization_id, slack_user_id)
       WHERE slack_user_id IS NOT NULL
       DO UPDATE SET name = EXCLUDED.name
     RETURNING *`,
    [input.organizationId, input.slackUserId, input.name, input.email ?? null],
  );
  return row!;
}

// ---------------------------------------------------------------------------
// Slack installations
// ---------------------------------------------------------------------------

export interface UpsertSlackInstallationResult {
  installation: SlackInstallation;
  /**
   * True only when this call created the row — a genuine first install of
   * this team, not a concurrent duplicate. Reading `wasInserted` off this
   * single statement's own result, rather than a separate SELECT taken
   * beforehand, is what makes it race-proof: two OAuth callbacks racing on
   * the same team_id (a double-clicked install button, a retried redirect)
   * both hit this one atomic INSERT ... ON CONFLICT, and Postgres guarantees
   * only one of them sees `xmax = 0`.
   */
  wasInserted: boolean;
}

export async function upsertSlackInstallation(input: {
  organizationId: string;
  teamId: string;
  teamName?: string | null;
  enterpriseId?: string | null;
  appId?: string | null;
  botUserId: string;
  encryptedBotToken: string;
  installedBy?: string | null;
}): Promise<UpsertSlackInstallationResult> {
  const row = await sqlOne<SlackInstallation & { was_inserted: boolean }>(
    `INSERT INTO slack_installations
       (organization_id, team_id, team_name, enterprise_id, app_id,
        bot_user_id, encrypted_bot_token, installed_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (team_id) DO UPDATE SET
       team_name           = EXCLUDED.team_name,
       enterprise_id       = EXCLUDED.enterprise_id,
       app_id              = EXCLUDED.app_id,
       bot_user_id         = EXCLUDED.bot_user_id,
       encrypted_bot_token = EXCLUDED.encrypted_bot_token,
       installed_by        = EXCLUDED.installed_by,
       updated_at          = now()
     RETURNING *, (xmax = 0) AS was_inserted`,
    [
      input.organizationId,
      input.teamId,
      input.teamName ?? null,
      input.enterpriseId ?? null,
      input.appId ?? null,
      input.botUserId,
      input.encryptedBotToken,
      input.installedBy ?? null,
    ],
  );
  const { was_inserted, ...installation } = row!;
  return { installation, wasInserted: was_inserted };
}

export async function getInstallationByTeamId(
  teamId: string,
): Promise<SlackInstallation | undefined> {
  return sqlOne<SlackInstallation>(
    `SELECT * FROM slack_installations WHERE team_id = $1`,
    [teamId],
  );
}

export async function getInstallationForOrg(
  organizationId: string,
): Promise<SlackInstallation | undefined> {
  return sqlOne<SlackInstallation>(
    `SELECT * FROM slack_installations WHERE organization_id = $1
      ORDER BY created_at LIMIT 1`,
    [organizationId],
  );
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

export async function upsertClient(input: {
  organizationId: string;
  name: string;
  email: string;
  contactName?: string | null;
}): Promise<Client> {
  const row = await sqlOne<Client>(
    `INSERT INTO clients (organization_id, name, email, contact_name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (organization_id, lower(email)) DO UPDATE SET
       name         = EXCLUDED.name,
       contact_name = COALESCE(EXCLUDED.contact_name, clients.contact_name)
     RETURNING *`,
    [
      input.organizationId,
      input.name,
      input.email,
      input.contactName ?? null,
    ],
  );
  return row!;
}

export async function getClient(
  organizationId: string,
  clientId: string,
): Promise<Client | undefined> {
  return sqlOne<Client>(
    `SELECT * FROM clients WHERE organization_id = $1 AND id = $2`,
    [organizationId, clientId],
  );
}

/**
 * The client this Slack user most recently sent an approval to.
 *
 * Used to prefill the create modal: the person running `/approval create`
 * is, most weeks, chasing the same handful of clients, and retyping a name,
 * email and contact every single time is exactly the kind of busywork this
 * product exists to remove. A read-only lookup, so it costs nothing on a
 * user's very first approval — there is simply nothing to find yet.
 */
export async function getMostRecentClientForActor(
  organizationId: string,
  slackUserId: string,
): Promise<Pick<Client, "name" | "email" | "contact_name"> | undefined> {
  return sqlOne<Pick<Client, "name" | "email" | "contact_name">>(
    `SELECT c.name, c.email, c.contact_name
       FROM approvals a
       JOIN clients c ON c.id = a.client_id
       JOIN users u   ON u.id = a.created_by
      WHERE a.organization_id = $1 AND u.slack_user_id = $2
      ORDER BY a.created_at DESC
      LIMIT 1`,
    [organizationId, slackUserId],
  );
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export async function insertApproval(input: {
  organizationId: string;
  clientId: string;
  createdBy?: string | null;
  creativeName: string;
  creativeUrl?: string | null;
  creativeVersion?: string | null;
  notes?: string | null;
  deadline: Date;
  status: ApprovalStatus;
  secureTokenHash: string;
  tokenExpiresAt: Date;
  reminderOffsets: number[];
}): Promise<Approval> {
  const row = await sqlOne<Approval>(
    `INSERT INTO approvals
       (organization_id, client_id, created_by, creative_name, creative_url,
        creative_version, notes, deadline, status, secure_token_hash,
        token_expires_at, reminder_offsets)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::int[])
     RETURNING *`,
    [
      input.organizationId,
      input.clientId,
      input.createdBy ?? null,
      input.creativeName,
      input.creativeUrl ?? null,
      input.creativeVersion ?? null,
      input.notes ?? null,
      input.deadline,
      input.status,
      input.secureTokenHash,
      input.tokenExpiresAt,
      input.reminderOffsets,
    ],
  );
  return row!;
}

/** Scoped read. Used by every agency-side path. */
export async function getApproval(
  organizationId: string,
  approvalId: string,
): Promise<ApprovalWithClient | undefined> {
  return sqlOne<ApprovalWithClient>(
    `${APPROVAL_WITH_CLIENT_SELECT} WHERE a.organization_id = $1 AND a.id = $2`,
    [organizationId, approvalId],
  );
}

/**
 * The one unscoped lookup in this file.
 *
 * The client has no account and no organization context — the 256-bit token
 * in their link is the entire credential, and the hash of it is what selects
 * the row. There is nothing to scope by, and nothing to scope against: a
 * token identifies exactly one approval or none.
 */
export async function findApprovalByTokenHash(
  tokenHash: string,
): Promise<ApprovalWithClient | undefined> {
  return sqlOne<ApprovalWithClient>(
    `${APPROVAL_WITH_CLIENT_SELECT} WHERE a.secure_token_hash = $1`,
    [tokenHash],
  );
}

export async function listApprovals(input: {
  organizationId: string;
  statuses?: readonly ApprovalStatus[];
  limit?: number;
  offset?: number;
}): Promise<ApprovalWithClient[]> {
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 100);
  const offset = Math.max(input.offset ?? 0, 0);

  if (input.statuses && input.statuses.length > 0) {
    return sql<ApprovalWithClient>(
      `${APPROVAL_WITH_CLIENT_SELECT}
        WHERE a.organization_id = $1 AND a.status = ANY($2::text[])
        ORDER BY a.deadline ASC
        LIMIT $3 OFFSET $4`,
      [input.organizationId, [...input.statuses], limit, offset],
    );
  }

  return sql<ApprovalWithClient>(
    `${APPROVAL_WITH_CLIENT_SELECT}
      WHERE a.organization_id = $1
      ORDER BY a.created_at DESC
      LIMIT $2 OFFSET $3`,
    [input.organizationId, limit, offset],
  );
}

export async function countApprovals(input: {
  organizationId: string;
  statuses?: readonly ApprovalStatus[];
}): Promise<number> {
  const row = input.statuses?.length
    ? await sqlOne<{ count: string }>(
        `SELECT count(*)::text AS count FROM approvals
          WHERE organization_id = $1 AND status = ANY($2::text[])`,
        [input.organizationId, [...input.statuses]],
      )
    : await sqlOne<{ count: string }>(
        `SELECT count(*)::text AS count FROM approvals WHERE organization_id = $1`,
        [input.organizationId],
      );
  return Number(row?.count ?? 0);
}

/**
 * Compare-and-set on status.
 *
 * The expected current status is part of the WHERE clause, so two concurrent
 * decisions cannot both succeed: the second one matches no row and gets
 * undefined back. The legality of the move itself is checked by the state
 * machine before this is called.
 */
export async function transitionApproval(input: {
  organizationId: string;
  approvalId: string;
  from: readonly ApprovalStatus[];
  to: ApprovalStatus;
  decidedAt?: Date | null;
  decisionComment?: string | null;
  markViewed?: boolean;
}): Promise<Approval | undefined> {
  return sqlOne<Approval>(
    `UPDATE approvals
        SET status           = $4,
            decided_at       = COALESCE($5, decided_at),
            decision_comment = COALESCE($6, decision_comment),
            first_viewed_at  = CASE WHEN $7 THEN COALESCE(first_viewed_at, now())
                                    ELSE first_viewed_at END,
            updated_at       = now()
      WHERE organization_id = $1
        AND id = $2
        AND status = ANY($3::text[])
      RETURNING *`,
    [
      input.organizationId,
      input.approvalId,
      [...input.from],
      input.to,
      input.decidedAt ?? null,
      input.decisionComment ?? null,
      input.markViewed ?? false,
    ],
  );
}

export async function setApprovalSlackMessage(input: {
  organizationId: string;
  approvalId: string;
  channelId: string;
  messageTs: string;
}): Promise<void> {
  await sql(
    `UPDATE approvals
        SET slack_channel_id = $3, slack_message_ts = $4, updated_at = now()
      WHERE organization_id = $1 AND id = $2`,
    [input.organizationId, input.approvalId, input.channelId, input.messageTs],
  );
}

export async function setApprovalDeadline(input: {
  organizationId: string;
  approvalId: string;
  deadline: Date;
  reminderOffsets?: number[];
}): Promise<Approval | undefined> {
  return sqlOne<Approval>(
    `UPDATE approvals
        SET deadline         = $3,
            reminder_offsets = COALESCE($4::int[], reminder_offsets),
            updated_at       = now()
      WHERE organization_id = $1 AND id = $2
      RETURNING *`,
    [
      input.organizationId,
      input.approvalId,
      input.deadline,
      input.reminderOffsets ?? null,
    ],
  );
}

/**
 * Find approvals that have run past their deadline without a decision.
 *
 * Unscoped by organization because it is the cron sweep, which by definition
 * runs for every tenant. It returns rows rather than mutating them, and each
 * one is then transitioned through the ordinary scoped path.
 */
export async function findOverdueApprovals(
  now: Date,
  limit = 200,
): Promise<ApprovalWithClient[]> {
  return sql<ApprovalWithClient>(
    `${APPROVAL_WITH_CLIENT_SELECT}
      WHERE a.status IN ('waiting','viewed') AND a.deadline <= $1
      ORDER BY a.deadline ASC
      LIMIT $2`,
    [now, limit],
  );
}

export async function markAgencyNotifiedOverdue(
  organizationId: string,
  approvalId: string,
): Promise<boolean> {
  const row = await sqlOne<{ id: string }>(
    `UPDATE approvals
        SET agency_notified_overdue_at = now(), updated_at = now()
      WHERE organization_id = $1 AND id = $2
        AND agency_notified_overdue_at IS NULL
      RETURNING id`,
    [organizationId, approvalId],
  );
  return row !== undefined;
}

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

export interface ReminderUpsert {
  reminderNumber: number;
  kind: ReminderKind;
  scheduledFor: Date;
  status: "pending" | "skipped";
}

/**
 * Write the reminder sequence for one cycle of one approval.
 *
 * Two rules decide what may be overwritten. A row that was actually delivered
 * — sent, or failed after its attempts ran out — is history and is never
 * touched. A row that was only ever scheduled (pending) or passed over
 * (skipped) may be moved, which is what makes a deadline change reschedule in
 * place rather than duplicate, and what lets a deadline pushed further out
 * revive a reminder that was previously too late to send.
 *
 * Pending rows in this cycle that the new plan has no place for are cancelled.
 */
export async function replaceReminderSequence(input: {
  organizationId: string;
  approvalId: string;
  cycle: number;
  reminders: readonly ReminderUpsert[];
}): Promise<void> {
  for (const reminder of input.reminders) {
    await sql(
      `INSERT INTO reminders
         (organization_id, approval_id, cycle, reminder_number, kind,
          scheduled_for, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (approval_id, cycle, reminder_number) DO UPDATE SET
         kind          = EXCLUDED.kind,
         scheduled_for = EXCLUDED.scheduled_for,
         status        = EXCLUDED.status
       WHERE reminders.status IN ('pending', 'skipped')`,
      [
        input.organizationId,
        input.approvalId,
        input.cycle,
        reminder.reminderNumber,
        reminder.kind,
        reminder.scheduledFor,
        reminder.status,
      ],
    );
  }

  const keep = input.reminders.map((r) => r.reminderNumber);
  await sql(
    `UPDATE reminders
        SET status = 'cancelled'
      WHERE organization_id = $1 AND approval_id = $2 AND cycle = $3
        AND status = 'pending'
        AND NOT (reminder_number = ANY($4::int[]))`,
    [input.organizationId, input.approvalId, input.cycle, keep],
  );
}

/**
 * Start a new round of review.
 *
 * Called when an approval that had changes requested is reopened with a fresh
 * deadline. The previous cycle's rows keep their statuses and their place in
 * the audit trail; the new cycle starts empty.
 */
export async function startNewReminderCycle(
  organizationId: string,
  approvalId: string,
): Promise<number> {
  const row = await sqlOne<{ reminder_cycle: number }>(
    `UPDATE approvals
        SET reminder_cycle = reminder_cycle + 1, updated_at = now()
      WHERE organization_id = $1 AND id = $2
      RETURNING reminder_cycle`,
    [organizationId, approvalId],
  );
  return Number(row?.reminder_cycle ?? 1);
}

export async function cancelPendingReminders(
  organizationId: string,
  approvalId: string,
): Promise<number> {
  const rows = await sql<{ id: string }>(
    `UPDATE reminders SET status = 'cancelled'
      WHERE organization_id = $1 AND approval_id = $2 AND status = 'pending'
      RETURNING id`,
    [organizationId, approvalId],
  );
  return rows.length;
}

export async function listReminders(
  organizationId: string,
  approvalId: string,
): Promise<Reminder[]> {
  return sql<Reminder>(
    `SELECT * FROM reminders
      WHERE organization_id = $1 AND approval_id = $2
      ORDER BY cycle, reminder_number`,
    [organizationId, approvalId],
  );
}

/** Due reminders across all tenants. The cron sweep's input. */
export async function findDueReminders(
  now: Date,
  limit = 100,
): Promise<Reminder[]> {
  return sql<Reminder>(
    `SELECT r.* FROM reminders r
       JOIN approvals a ON a.id = r.approval_id
      WHERE r.status = 'pending'
        AND r.scheduled_for <= $1
        AND a.status IN ('waiting','viewed')
      ORDER BY r.scheduled_for ASC
      LIMIT $2`,
    [now, limit],
  );
}

/**
 * Take ownership of a reminder before sending it.
 *
 * This single statement is the duplicate-send guard. Two workers racing on
 * the same row both run the UPDATE; only one matches `status = 'pending'` and
 * gets a row back. The loser sends nothing.
 */
export async function claimReminder(
  reminderId: string,
): Promise<Reminder | undefined> {
  return sqlOne<Reminder>(
    `UPDATE reminders
        SET status = 'sending', attempts = attempts + 1
      WHERE id = $1 AND status = 'pending'
      RETURNING *`,
    [reminderId],
  );
}

export async function markReminderSent(reminderId: string): Promise<void> {
  await sql(
    `UPDATE reminders SET status = 'sent', sent_at = now(), last_error = NULL
      WHERE id = $1`,
    [reminderId],
  );
}

/**
 * Close out a claimed reminder that turned out not to be needed — the
 * approval was decided in the gap between the sweep reading it as due and
 * claiming it.
 *
 * `claimReminder` moves a row to 'sending' precisely so nothing else can pick
 * it up; that also means nothing else can ever finish it. Without this call,
 * such a row is stuck in 'sending' forever — `findDueReminders` only selects
 * 'pending' rows, and `cancelPendingReminders` only touches 'pending' ones
 * too, so neither the retry path nor the bulk-cancel path can ever reach it.
 */
export async function markReminderCancelled(reminderId: string): Promise<void> {
  await sql(`UPDATE reminders SET status = 'cancelled' WHERE id = $1`, [
    reminderId,
  ]);
}

/**
 * Hand a claimed reminder back.
 *
 * Below the attempt ceiling it returns to 'pending' so the next sweep retries
 * it; at the ceiling it is marked failed and left alone, so a permanently bad
 * address cannot spin forever.
 */
export async function markReminderFailed(
  reminderId: string,
  error: string,
  maxAttempts = 3,
): Promise<void> {
  await sql(
    `UPDATE reminders
        SET status = CASE WHEN attempts >= $3 THEN 'failed' ELSE 'pending' END,
            last_error = $2
      WHERE id = $1`,
    [reminderId, error.slice(0, 500), maxAttempts],
  );
}

/** Record a manual "Send reminder" press. Numbered 0, outside the sequence. */
export async function recordManualReminder(
  organizationId: string,
  approvalId: string,
  cycle: number,
): Promise<void> {
  await sql(
    `INSERT INTO reminders
       (organization_id, approval_id, cycle, reminder_number, kind,
        scheduled_for, status, sent_at, attempts)
     VALUES ($1, $2, $3, 0, 'manual', now(), 'sent', now(), 1)
     ON CONFLICT (approval_id, cycle, reminder_number) DO UPDATE SET
       sent_at  = now(),
       attempts = reminders.attempts + 1,
       status   = 'sent'`,
    [organizationId, approvalId, cycle],
  );
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export async function appendEvent(input: {
  organizationId: string;
  approvalId: string;
  eventType: EventType | string;
  actorType?: ActorType;
  actorId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<ApprovalEvent> {
  const row = await sqlOne<ApprovalEvent>(
    `INSERT INTO approval_events
       (organization_id, approval_id, event_type, actor_type, actor_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     RETURNING *`,
    [
      input.organizationId,
      input.approvalId,
      input.eventType,
      input.actorType ?? "system",
      input.actorId ?? null,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  return row!;
}

export async function listEvents(
  organizationId: string,
  approvalId: string,
  limit = 200,
): Promise<ApprovalEvent[]> {
  return sql<ApprovalEvent>(
    `SELECT * FROM approval_events
      WHERE organization_id = $1 AND approval_id = $2
      ORDER BY created_at ASC, id ASC
      LIMIT $3`,
    [organizationId, approvalId, limit],
  );
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/**
 * Fixed-window counter. Returns whether the caller is allowed through.
 *
 * The INSERT ... ON CONFLICT DO UPDATE is atomic, so concurrent requests
 * cannot both read a stale count.
 */
export async function hitRateLimit(input: {
  bucket: string;
  windowSeconds: number;
  max: number;
  now?: Date;
}): Promise<{ allowed: boolean; hits: number }> {
  const now = input.now ?? new Date();
  const windowMs = input.windowSeconds * 1000;
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);

  const row = await sqlOne<{ hits: number }>(
    `INSERT INTO rate_limit_counters (bucket, window_start, hits)
     VALUES ($1, $2, 1)
     ON CONFLICT (bucket, window_start)
       DO UPDATE SET hits = rate_limit_counters.hits + 1
     RETURNING hits`,
    [input.bucket, windowStart],
  );

  const hits = Number(row?.hits ?? 1);
  return { allowed: hits <= input.max, hits };
}

/** Housekeeping, called by the cron sweep. */
export async function pruneRateLimits(olderThan: Date): Promise<void> {
  await sql(`DELETE FROM rate_limit_counters WHERE window_start < $1`, [
    olderThan,
  ]);
}

/**
 * Lookup by primary key with no organization scope.
 *
 * Reachable only from a signed reminder pointer, where the signature is the
 * credential and there is no organization context to scope by — exactly the
 * same position as `findApprovalByTokenHash`. Nothing agency-facing may call
 * this; agency paths use `getApproval`, which requires an organization id.
 */
export async function findApprovalByIdUnscoped(
  approvalId: string,
): Promise<ApprovalWithClient | undefined> {
  return sqlOne<ApprovalWithClient>(
    `${APPROVAL_WITH_CLIENT_SELECT} WHERE a.id = $1`,
    [approvalId],
  );
}
