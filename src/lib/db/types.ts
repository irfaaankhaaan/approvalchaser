/** Row shapes, mirroring db/schema.sql exactly. */

export type ApprovalStatus =
  | "draft"
  | "waiting"
  | "viewed"
  | "approved"
  | "changes_requested"
  | "overdue"
  | "cancelled";

export type ReminderStatus =
  | "pending"
  | "sending"
  | "sent"
  | "cancelled"
  | "failed"
  | "skipped";

export type ReminderKind = "reminder" | "deadline_warning" | "manual";

export type ActorType = "agency_user" | "client" | "system" | "slack";

export type EventType =
  | "approval_created"
  | "email_sent"
  | "client_opened"
  | "client_viewed"
  | "reminder_sent"
  | "reminder_scheduled"
  | "client_approved"
  | "changes_requested"
  | "deadline_changed"
  | "approval_cancelled"
  | "approval_overdue"
  | "agency_notified";

export interface Organization {
  id: string;
  name: string;
  timezone: string;
  created_at: Date;
}

export interface User {
  id: string;
  organization_id: string;
  slack_user_id: string | null;
  email: string | null;
  name: string;
  created_at: Date;
}

export interface SlackInstallation {
  id: string;
  organization_id: string;
  team_id: string;
  team_name: string | null;
  enterprise_id: string | null;
  app_id: string | null;
  bot_user_id: string;
  encrypted_bot_token: string;
  default_channel_id: string | null;
  installed_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface Client {
  id: string;
  organization_id: string;
  name: string;
  email: string;
  contact_name: string | null;
  created_at: Date;
}

export interface Approval {
  id: string;
  organization_id: string;
  client_id: string;
  created_by: string | null;
  creative_name: string;
  creative_url: string | null;
  creative_version: string | null;
  notes: string | null;
  deadline: Date;
  status: ApprovalStatus;
  secure_token_hash: string;
  token_expires_at: Date;
  reminder_offsets: number[];
  reminder_cycle: number;
  slack_channel_id: string | null;
  slack_message_ts: string | null;
  first_viewed_at: Date | null;
  decided_at: Date | null;
  decision_comment: string | null;
  agency_notified_overdue_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** An approval joined to the client it belongs to — what the UI usually wants. */
export interface ApprovalWithClient extends Approval {
  client_name: string;
  client_email: string;
  client_contact_name: string | null;
  organization_name: string;
  organization_timezone: string;
}

export interface Reminder {
  id: string;
  organization_id: string;
  approval_id: string;
  cycle: number;
  reminder_number: number;
  kind: ReminderKind;
  scheduled_for: Date;
  status: ReminderStatus;
  sent_at: Date | null;
  attempts: number;
  last_error: string | null;
  created_at: Date;
}

export interface ApprovalEvent {
  id: string;
  organization_id: string;
  approval_id: string;
  event_type: EventType | string;
  actor_type: ActorType;
  actor_id: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}
