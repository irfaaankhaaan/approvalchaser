import type { SlackBlock } from "@/lib/slack/client";
import type {
  ApprovalEvent,
  ApprovalStatus,
  ApprovalWithClient,
  Reminder,
} from "@/lib/db/types";
import { statusLabel, isTerminal } from "@/lib/approvals/state";
import {
  formatDeadline,
  formatDeadlineRelative,
  humanDuration,
  safeExternalUrl,
} from "@/lib/format";
import { REMINDER_PRESETS } from "@/lib/reminders/schedule";

/**
 * Slack surfaces.
 *
 * House style: short. An agency channel is a working channel, so a status
 * change is one line and one emoji, and the detail lives behind a button.
 */

export const ACTIONS = {
  view: "approval_view",
  remind: "approval_remind",
  cancel: "approval_cancel",
  reschedule: "approval_reschedule",
  listPage: "approval_list_page",
  create: "approval_create",
} as const;

export const CALLBACKS = {
  create: "approval_create_modal",
  reschedule: "approval_reschedule_modal",
  detail: "approval_detail_modal",
} as const;

const STATUS_EMOJI: Record<ApprovalStatus, string> = {
  draft: "📝",
  waiting: "⏳",
  viewed: "👀",
  approved: "✅",
  changes_requested: "✏️",
  overdue: "🔴",
  cancelled: "🚫",
};

function section(text: string): SlackBlock {
  return { type: "section", text: { type: "mrkdwn", text } };
}

function context(text: string): SlackBlock {
  return { type: "context", elements: [{ type: "mrkdwn", text }] };
}

/**
 * Slack renders `*bold*` and `<link>`, so any value that came from a human
 * has its control characters stripped before interpolation.
 */
function clean(value: string | null | undefined): string {
  return String(value ?? "")
    .replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!)
    .slice(0, 300);
}

function creativeLine(approval: ApprovalWithClient): string {
  return approval.creative_version
    ? `${clean(approval.creative_name)} (${clean(approval.creative_version)})`
    : clean(approval.creative_name);
}

// ---------------------------------------------------------------------------
// Install welcome — DM'd to whoever installed the app
// ---------------------------------------------------------------------------

/**
 * The message sent the moment installation finishes.
 *
 * The install page is a browser tab the installer may already have closed by
 * the time they're back in Slack; this puts the next step where they
 * actually are, so getting started is "click the button" rather than "recall
 * a slash command from a README."
 */
export function installWelcomeMessage(): { text: string; blocks: SlackBlock[] } {
  return {
    text: "Approval Chaser is connected. Run /approval create to send your first one.",
    blocks: [
      section(
        "👋 *Approval Chaser is connected.*\nSend a creative for approval and " +
          "I'll chase the client and keep this workspace posted — no more " +
          "manual follow-ups.",
      ),
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: ACTIONS.create,
            style: "primary",
            text: { type: "plain_text", text: "Create your first approval" },
            value: "welcome",
          },
        ],
      },
      context("Or type `/approval create` in any channel, any time."),
    ],
  };
}

// ---------------------------------------------------------------------------
// The approval message — posted once, then updated in place
// ---------------------------------------------------------------------------

export function approvalMessage(approval: ApprovalWithClient): {
  text: string;
  blocks: SlackBlock[];
} {
  const emoji = STATUS_EMOJI[approval.status];
  const deadline = formatDeadlineRelative(
    new Date(approval.deadline),
    approval.organization_timezone,
  );
  const creative = creativeLine(approval);
  const contact = approval.client_contact_name
    ? `${clean(approval.client_contact_name)} · ${clean(approval.client_email)}`
    : clean(approval.client_email);

  const blocks: SlackBlock[] = [
    section(
      `${emoji} *${clean(approval.client_name)}* — ${creative}\n` +
        `Deadline: *${deadline}* · Status: *${statusLabel(approval.status)}*`,
    ),
    context(`Client contact: ${contact}`),
  ];

  if (approval.status === "changes_requested" && approval.decision_comment) {
    blocks.push(section(`> ${clean(approval.decision_comment)}`));
  }

  // A closed approval keeps its detail button and loses the rest: there is
  // nothing left to remind about or cancel.
  const elements: SlackBlock[] = [
    {
      type: "button",
      action_id: ACTIONS.view,
      text: { type: "plain_text", text: "View approval" },
      value: approval.id,
    },
  ];

  if (!isTerminal(approval.status)) {
    elements.push(
      {
        type: "button",
        action_id: ACTIONS.remind,
        text: { type: "plain_text", text: "Send reminder" },
        value: approval.id,
      },
      {
        type: "button",
        action_id: ACTIONS.cancel,
        style: "danger",
        text: { type: "plain_text", text: "Cancel" },
        value: approval.id,
        confirm: {
          title: { type: "plain_text", text: "Cancel this approval?" },
          text: {
            type: "mrkdwn",
            text: `*${creative}* will stop chasing ${clean(approval.client_name)} and the link will stop working.`,
          },
          confirm: { type: "plain_text", text: "Cancel approval" },
          deny: { type: "plain_text", text: "Keep it" },
          style: "danger",
        },
      },
    );
  }

  blocks.push({ type: "actions", elements });

  return {
    text: `${statusLabel(approval.status)}: ${creative} for ${clean(approval.client_name)}`,
    blocks,
  };
}

// ---------------------------------------------------------------------------
// Threaded replies on status changes
// ---------------------------------------------------------------------------

export function approvedReply(approval: ApprovalWithClient): {
  text: string;
  blocks: SlackBlock[];
} {
  const who = clean(approval.client_contact_name ?? approval.client_email);
  const when = formatDeadlineRelative(
    approval.decided_at ? new Date(approval.decided_at) : new Date(),
    approval.organization_timezone,
  );
  const text = `✅ *Approved* — ${clean(approval.client_name)} approved ${creativeLine(approval)}`;
  return {
    text: `Approved: ${creativeLine(approval)}`,
    blocks: [section(text), context(`Approved by ${who} · ${when}`)],
  };
}

export function changesRequestedReply(approval: ApprovalWithClient): {
  text: string;
  blocks: SlackBlock[];
} {
  const blocks: SlackBlock[] = [
    section(
      `✏️ *Changes requested* — ${clean(approval.client_name)} wants edits to ${creativeLine(approval)}`,
    ),
  ];
  if (approval.decision_comment) {
    blocks.push(section(`> ${clean(approval.decision_comment)}`));
  }
  blocks.push(
    context("Reminders for this round have stopped. Reopen once the new cut is ready."),
  );
  return { text: `Changes requested: ${creativeLine(approval)}`, blocks };
}

export function atRiskReply(
  approval: ApprovalWithClient,
  now = new Date(),
): { text: string; blocks: SlackBlock[] } {
  const deadline = new Date(approval.deadline);
  const silentFor = humanDuration(
    now.getTime() -
      new Date(approval.first_viewed_at ?? approval.created_at).getTime(),
  );

  return {
    text: `At risk: ${creativeLine(approval)}`,
    blocks: [
      section(
        `⚠️ *Approval at risk* — ${clean(approval.client_name)} has not approved ${creativeLine(approval)}\n` +
          `Deadline: *${formatDeadline(deadline, approval.organization_timezone)}* · ` +
          `Time remaining: *${humanDuration(deadline.getTime() - now.getTime())}*`,
      ),
      context(`No response for ${silentFor}.`),
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: ACTIONS.remind,
            style: "primary",
            text: { type: "plain_text", text: "Send reminder" },
            value: approval.id,
          },
          {
            type: "button",
            action_id: ACTIONS.view,
            text: { type: "plain_text", text: "Open approval" },
            value: approval.id,
          },
        ],
      },
    ],
  };
}

export function overdueReply(approval: ApprovalWithClient): {
  text: string;
  blocks: SlackBlock[];
} {
  return {
    text: `Overdue: ${creativeLine(approval)}`,
    blocks: [
      section(
        `🔴 *Overdue* — ${clean(approval.client_name)} missed the deadline on ${creativeLine(approval)}\n` +
          `Deadline was *${formatDeadline(new Date(approval.deadline), approval.organization_timezone)}*`,
      ),
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: ACTIONS.remind,
            style: "primary",
            text: { type: "plain_text", text: "Send reminder" },
            value: approval.id,
          },
          {
            type: "button",
            action_id: ACTIONS.reschedule,
            text: { type: "plain_text", text: "Move deadline" },
            value: approval.id,
          },
        ],
      },
    ],
  };
}

export function reminderSentReply(
  approval: ApprovalWithClient,
  reminderNumber: number,
  manual: boolean,
): { text: string; blocks: SlackBlock[] } {
  const label = manual ? "Manual reminder sent" : `Reminder ${reminderNumber} sent`;
  return {
    text: `${label} to ${clean(approval.client_name)}`,
    blocks: [
      context(`📤 ${label} to ${clean(approval.client_email)}.`),
    ],
  };
}

// ---------------------------------------------------------------------------
// /approval list
// ---------------------------------------------------------------------------

export const LIST_PAGE_SIZE = 5;

/**
 * `default` gives each row an overflow menu with every action.
 * `remind` and `cancel` give it a single button, so `/approval remind` is a
 * list you press once rather than an id you have to type.
 */
export type ListMode = "default" | "remind" | "cancel";

export function listBlocks(input: {
  approvals: ApprovalWithClient[];
  page: number;
  total: number;
  timezone: string;
  mode?: ListMode;
}): { text: string; blocks: SlackBlock[] } {
  const mode: ListMode = input.mode ?? "default";

  if (input.approvals.length === 0) {
    return {
      text: "No active approvals.",
      blocks: [section("No active approvals. Start one with `/approval create`.")],
    };
  }

  const heading =
    mode === "remind"
      ? "*Which approval should I chase?*"
      : mode === "cancel"
        ? "*Which approval should I cancel?*"
        : `*Active approvals* (${input.total})`;

  const blocks: SlackBlock[] = [section(heading), { type: "divider" }];

  for (const approval of input.approvals) {
    const deadline = formatDeadlineRelative(
      new Date(approval.deadline),
      input.timezone,
    );
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `${STATUS_EMOJI[approval.status]} *${clean(approval.client_name)}* — ${creativeLine(approval)}\n` +
          `${statusLabel(approval.status)} · Deadline: ${deadline}`,
      },
      accessory: listAccessory(mode, approval),
    });
  }

  const lastPage = Math.max(0, Math.ceil(input.total / LIST_PAGE_SIZE) - 1);
  if (lastPage > 0) {
    const buttons: SlackBlock[] = [];
    if (input.page > 0) {
      buttons.push({
        type: "button",
        action_id: ACTIONS.listPage,
        text: { type: "plain_text", text: "← Previous" },
        value: String(input.page - 1),
      });
    }
    if (input.page < lastPage) {
      buttons.push({
        type: "button",
        action_id: ACTIONS.listPage,
        text: { type: "plain_text", text: "Next →" },
        value: String(input.page + 1),
      });
    }
    blocks.push(context(`Page ${input.page + 1} of ${lastPage + 1}`));
    if (buttons.length > 0) blocks.push({ type: "actions", elements: buttons });
  }

  return { text: `Active approvals (${input.total})`, blocks };
}

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------

export const FIELDS = {
  clientName: "client_name",
  clientEmail: "client_email",
  contactName: "contact_name",
  creativeName: "creative_name",
  creativeUrl: "creative_url",
  deadline: "deadline",
  schedule: "schedule",
  notes: "notes",
} as const;

/** The /approval create modal. */
/** The last client this Slack user sent an approval to. Prefills the modal. */
export interface ClientPrefill {
  name: string;
  email: string;
  contactName: string | null;
}

/**
 * The /approval create modal.
 *
 * When `prefill` is given — the requester's most recent client — the three
 * client fields arrive already filled in. An agency that sends the same
 * client three creatives a week should not retype that client's email three
 * times a week; they clear the field themselves on the rare approval that
 * goes somewhere new.
 */
export function createModalView(
  defaultDeadlineEpoch: number,
  prefill?: ClientPrefill,
): Record<string, unknown> {
  return {
    type: "modal",
    callback_id: CALLBACKS.create,
    title: { type: "plain_text", text: "New approval" },
    submit: { type: "plain_text", text: "Send to client" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: FIELDS.clientName,
        label: { type: "plain_text", text: "Client" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          max_length: 120,
          placeholder: { type: "plain_text", text: "ABC Clothing" },
          ...(prefill ? { initial_value: prefill.name } : {}),
        },
      },
      {
        type: "input",
        block_id: FIELDS.clientEmail,
        label: { type: "plain_text", text: "Client email" },
        element: {
          type: "email_text_input",
          action_id: "value",
          placeholder: { type: "plain_text", text: "sarah@example.com" },
          ...(prefill ? { initial_value: prefill.email } : {}),
        },
      },
      {
        type: "input",
        block_id: FIELDS.contactName,
        optional: true,
        label: { type: "plain_text", text: "Contact name" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          max_length: 80,
          placeholder: { type: "plain_text", text: "Sarah" },
          ...(prefill?.contactName ? { initial_value: prefill.contactName } : {}),
        },
      },
      {
        type: "input",
        block_id: FIELDS.creativeName,
        label: { type: "plain_text", text: "Creative" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          max_length: 200,
          placeholder: { type: "plain_text", text: "Instagram Reel #14" },
        },
      },
      {
        type: "input",
        block_id: FIELDS.creativeUrl,
        optional: true,
        label: { type: "plain_text", text: "Creative URL" },
        element: {
          type: "url_text_input",
          action_id: "value",
          placeholder: { type: "plain_text", text: "https://example.com/reel14" },
        },
      },
      {
        type: "input",
        block_id: FIELDS.deadline,
        label: { type: "plain_text", text: "Deadline" },
        // Slack's own picker returns a unix timestamp, which sidesteps every
        // date-parsing and timezone ambiguity a text field would introduce.
        element: {
          type: "datetimepicker",
          action_id: "value",
          initial_date_time: defaultDeadlineEpoch,
        },
      },
      {
        type: "input",
        block_id: FIELDS.schedule,
        label: { type: "plain_text", text: "Reminder schedule" },
        element: {
          type: "static_select",
          action_id: "value",
          initial_option: presetOption(0),
          options: REMINDER_PRESETS.map((_, index) => presetOption(index)),
        },
      },
      {
        type: "input",
        block_id: FIELDS.notes,
        optional: true,
        label: { type: "plain_text", text: "Notes for the client" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          multiline: true,
          max_length: 1000,
        },
      },
    ],
  };
}

function listAccessory(mode: ListMode, approval: ApprovalWithClient) {
  if (mode === "remind") {
    return {
      type: "button",
      action_id: ACTIONS.remind,
      style: "primary",
      text: { type: "plain_text", text: "Send reminder" },
      value: approval.id,
    };
  }

  if (mode === "cancel") {
    return {
      type: "button",
      action_id: ACTIONS.cancel,
      style: "danger",
      text: { type: "plain_text", text: "Cancel" },
      value: approval.id,
      confirm: {
        title: { type: "plain_text", text: "Cancel this approval?" },
        text: {
          type: "mrkdwn",
          text: `*${creativeLine(approval)}* will stop chasing ${clean(approval.client_name)}.`,
        },
        confirm: { type: "plain_text", text: "Cancel approval" },
        deny: { type: "plain_text", text: "Keep it" },
        style: "danger",
      },
    };
  }

  return {
    type: "overflow",
    action_id: ACTIONS.view,
    options: [
      { text: { type: "plain_text", text: "View" }, value: `view:${approval.id}` },
      { text: { type: "plain_text", text: "Remind" }, value: `remind:${approval.id}` },
      { text: { type: "plain_text", text: "Cancel" }, value: `cancel:${approval.id}` },
    ],
  };
}

function presetOption(index: number) {
  const preset = REMINDER_PRESETS[index]!;
  return {
    text: { type: "plain_text", text: preset.label },
    value: preset.id,
  };
}

/** The detail modal behind "View approval" — including the audit trail. */
export function detailModalView(input: {
  approval: ApprovalWithClient;
  events: ApprovalEvent[];
  reminders: Reminder[];
  browserUrl?: string | null;
}): Record<string, unknown> {
  const { approval } = input;
  const creativeUrl = safeExternalUrl(approval.creative_url);

  const blocks: SlackBlock[] = [
    section(
      `${STATUS_EMOJI[approval.status]} *${statusLabel(approval.status)}*\n` +
        `*${clean(approval.client_name)}* — ${creativeLine(approval)}`,
    ),
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*Deadline*\n${formatDeadline(new Date(approval.deadline), approval.organization_timezone)}`,
        },
        { type: "mrkdwn", text: `*Client contact*\n${clean(approval.client_email)}` },
      ],
    },
  ];

  if (creativeUrl) {
    blocks.push(section(`*Creative*\n<${creativeUrl}|Open the creative>`));
  }
  if (approval.notes) {
    blocks.push(section(`*Notes*\n${clean(approval.notes)}`));
  }
  if (approval.decision_comment) {
    blocks.push(section(`*Client comment*\n> ${clean(approval.decision_comment)}`));
  }

  const pending = input.reminders.filter((r) => r.status === "pending");
  const sent = input.reminders.filter((r) => r.status === "sent");
  blocks.push(
    { type: "divider" },
    section(
      `*Reminders*\n${sent.length} sent · ${pending.length} scheduled` +
        (pending[0]
          ? `\nNext: ${formatDeadline(new Date(pending[0].scheduled_for), approval.organization_timezone)}`
          : ""),
    ),
  );

  blocks.push({ type: "divider" }, section("*History*"));
  const recent = input.events.slice(-12);
  for (const event of recent) {
    blocks.push(
      context(
        `${formatDeadline(new Date(event.created_at), approval.organization_timezone)} · ` +
          `${clean(event.event_type)} · ${clean(event.actor_type)}`,
      ),
    );
  }

  if (input.browserUrl) {
    blocks.push(context(`<${input.browserUrl}|Open the full history in a browser>`));
  }

  return {
    type: "modal",
    callback_id: CALLBACKS.detail,
    title: { type: "plain_text", text: "Approval" },
    close: { type: "plain_text", text: "Close" },
    blocks,
  };
}

/** The "Move deadline" modal. */
export function rescheduleModalView(
  approval: ApprovalWithClient,
): Record<string, unknown> {
  return {
    type: "modal",
    callback_id: CALLBACKS.reschedule,
    private_metadata: approval.id,
    title: { type: "plain_text", text: "Move deadline" },
    submit: { type: "plain_text", text: "Save" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      section(`*${clean(approval.client_name)}* — ${creativeLine(approval)}`),
      {
        type: "input",
        block_id: FIELDS.deadline,
        label: { type: "plain_text", text: "New deadline" },
        element: {
          type: "datetimepicker",
          action_id: "value",
          initial_date_time: Math.floor(new Date(approval.deadline).getTime() / 1000),
        },
      },
      {
        type: "input",
        block_id: FIELDS.schedule,
        label: { type: "plain_text", text: "Reminder schedule" },
        element: {
          type: "static_select",
          action_id: "value",
          initial_option: presetOption(0),
          options: REMINDER_PRESETS.map((_, index) => presetOption(index)),
        },
      },
      context("Future reminders are recalculated. Reminders already sent are kept."),
    ],
  };
}

export function errorModalView(message: string): Record<string, unknown> {
  return {
    type: "modal",
    title: { type: "plain_text", text: "Approval Chaser" },
    close: { type: "plain_text", text: "Close" },
    blocks: [section(`:warning: ${clean(message)}`)],
  };
}
