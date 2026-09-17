-- Slack Approval Chaser — schema
--
-- Conventions
--   * Every table uses a UUID primary key. Public URLs never carry one.
--   * Every organization-owned row carries organization_id directly, even
--     where it could be reached by a join. Scoping is then a WHERE clause on
--     every single query, which is far harder to forget than a join path.
--   * Statuses are TEXT + CHECK rather than PG enums so they can be extended
--     with a plain migration.
--   * All timestamps are timestamptz. The database stores UTC; display
--     timezones are an organization setting.

CREATE TABLE IF NOT EXISTS organizations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  timezone     TEXT NOT NULL DEFAULT 'UTC',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  slack_user_id   TEXT,
  email           TEXT,
  name            TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One Slack user id is unique inside an installation, not globally.
CREATE UNIQUE INDEX IF NOT EXISTS users_org_slack_user_idx
  ON users (organization_id, slack_user_id) WHERE slack_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS users_org_idx ON users (organization_id);

CREATE TABLE IF NOT EXISTS slack_installations (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  team_id              TEXT NOT NULL,
  team_name            TEXT,
  enterprise_id        TEXT,
  app_id               TEXT,
  bot_user_id          TEXT NOT NULL,
  -- AES-256-GCM ciphertext. Never the raw xoxb- token.
  encrypted_bot_token  TEXT NOT NULL,
  -- Where escalations and status changes are posted when a request did not
  -- come from a channel we can reply in.
  default_channel_id   TEXT,
  installed_by         TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A workspace maps to exactly one organization. Re-installing updates in place.
CREATE UNIQUE INDEX IF NOT EXISTS slack_installations_team_idx
  ON slack_installations (team_id);
CREATE INDEX IF NOT EXISTS slack_installations_org_idx
  ON slack_installations (organization_id);

CREATE TABLE IF NOT EXISTS clients (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  email           TEXT NOT NULL,
  contact_name    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The same email may belong to two different agencies. Uniqueness is per org.
CREATE UNIQUE INDEX IF NOT EXISTS clients_org_email_idx
  ON clients (organization_id, lower(email));
CREATE INDEX IF NOT EXISTS clients_org_idx ON clients (organization_id);

CREATE TABLE IF NOT EXISTS approvals (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id          UUID NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  created_by         UUID REFERENCES users(id) ON DELETE SET NULL,

  creative_name      TEXT NOT NULL,
  creative_url       TEXT,
  creative_version   TEXT,
  notes              TEXT,

  deadline           TIMESTAMPTZ NOT NULL,
  status             TEXT NOT NULL DEFAULT 'waiting'
                       CHECK (status IN ('draft','waiting','viewed','approved',
                                         'changes_requested','overdue','cancelled')),

  -- SHA-256 of the token that appears in the client URL. The plaintext token
  -- exists only in the email we send; a database leak does not yield links.
  secure_token_hash  TEXT NOT NULL,
  token_expires_at   TIMESTAMPTZ NOT NULL,

  -- Minutes before the deadline at which reminders fire, e.g. {720,240,120}.
  reminder_offsets   INTEGER[] NOT NULL DEFAULT '{720,240,120}',

  -- Which round of review this approval is on. Asking for changes and then
  -- reopening starts cycle 2, which gets its own reminder sequence without
  -- disturbing the record of what cycle 1 sent.
  reminder_cycle     INTEGER NOT NULL DEFAULT 1,

  -- The Slack message that announced this approval, so it can be updated in
  -- place instead of spamming the channel with new messages.
  slack_channel_id   TEXT,
  slack_message_ts   TEXT,

  first_viewed_at    TIMESTAMPTZ,
  decided_at         TIMESTAMPTZ,
  decision_comment   TEXT,
  agency_notified_overdue_at TIMESTAMPTZ,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS approvals_token_hash_idx
  ON approvals (secure_token_hash);
CREATE INDEX IF NOT EXISTS approvals_org_status_idx
  ON approvals (organization_id, status, deadline);
CREATE INDEX IF NOT EXISTS approvals_client_idx ON approvals (client_id);
-- Drives the overdue sweep.
CREATE INDEX IF NOT EXISTS approvals_open_deadline_idx
  ON approvals (deadline) WHERE status IN ('waiting','viewed');

CREATE TABLE IF NOT EXISTS reminders (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  approval_id      UUID NOT NULL REFERENCES approvals(id) ON DELETE CASCADE,

  -- Which round of review this belongs to; see approvals.reminder_cycle.
  cycle            INTEGER NOT NULL DEFAULT 1,
  -- 1-based position in the sequence. Number 0 is reserved for manual sends.
  reminder_number  INTEGER NOT NULL,
  kind             TEXT NOT NULL DEFAULT 'reminder'
                     CHECK (kind IN ('reminder','deadline_warning','manual')),
  scheduled_for    TIMESTAMPTZ NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','sending','sent','cancelled','failed','skipped')),
  sent_at          TIMESTAMPTZ,
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The duplicate-send guard. One row per (approval, cycle, sequence position);
-- a rescheduled deadline updates these rows rather than inserting new ones,
-- and a new cycle gets a clean set without rewriting the old one.
CREATE UNIQUE INDEX IF NOT EXISTS reminders_approval_cycle_number_idx
  ON reminders (approval_id, cycle, reminder_number);
-- Drives the due-reminder sweep.
CREATE INDEX IF NOT EXISTS reminders_due_idx
  ON reminders (scheduled_for) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS reminders_org_idx ON reminders (organization_id);

CREATE TABLE IF NOT EXISTS approval_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  approval_id      UUID NOT NULL REFERENCES approvals(id) ON DELETE CASCADE,

  event_type       TEXT NOT NULL,
  actor_type       TEXT NOT NULL DEFAULT 'system'
                     CHECK (actor_type IN ('agency_user','client','system','slack')),
  actor_id         TEXT,
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS approval_events_approval_idx
  ON approval_events (approval_id, created_at);
CREATE INDEX IF NOT EXISTS approval_events_org_idx
  ON approval_events (organization_id, created_at DESC);

-- Fixed-window rate limiting for the public approval endpoints. Kept in the
-- database on purpose: serverless instances share no memory, so an in-process
-- counter would not actually limit anything.
CREATE TABLE IF NOT EXISTS rate_limit_counters (
  bucket        TEXT NOT NULL,
  window_start  TIMESTAMPTZ NOT NULL,
  hits          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);

CREATE INDEX IF NOT EXISTS rate_limit_window_idx
  ON rate_limit_counters (window_start);
