import { escapeHtml, formatDeadlineLong, safeExternalUrl } from "@/lib/format";
import type { EmailMessage } from "@/lib/email/provider";

/**
 * The five emails.
 *
 * Deliberately plain: one paragraph, one button, no imagery. Agency clients
 * open these on a phone between other things, and a long email is a slower
 * approval. Every interpolated value is escaped — creative names and change
 * requests are attacker-controllable text.
 */

export interface EmailContext {
  agencyName: string;
  clientName: string;
  contactName?: string | null;
  creativeName: string;
  creativeVersion?: string | null;
  creativeUrl?: string | null;
  deadline: Date;
  timezone: string;
  approvalUrl: string;
  notes?: string | null;
}

const BUTTON_STYLE =
  "display:inline-block;padding:12px 22px;background:#111827;color:#ffffff;" +
  "text-decoration:none;border-radius:6px;font-weight:600;font-size:15px";

function layout(bodyHtml: string, agencyName: string): string {
  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:10px;padding:28px;border:1px solid #e5e7eb">
    ${bodyHtml}
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:28px 0 14px">
    <p style="font-size:12px;color:#6b7280;margin:0">
      Sent by ${escapeHtml(agencyName)} via Approval Chaser.
      This link is private — please don't forward it.
    </p>
  </div>
</body></html>`;
}

function greeting(context: EmailContext): string {
  return context.contactName ? `Hi ${context.contactName},` : "Hi,";
}

function creativeLine(context: EmailContext): string {
  return context.creativeVersion
    ? `${context.creativeName} (${context.creativeVersion})`
    : context.creativeName;
}

/** 1. The first request. */
export function approvalRequestEmail(context: EmailContext): EmailMessage {
  const creative = creativeLine(context);
  const deadline = formatDeadlineLong(context.deadline, context.timezone);
  const preview = safeExternalUrl(context.creativeUrl);

  const text = [
    greeting(context),
    "",
    `${context.agencyName} has a creative waiting for your approval.`,
    "",
    creative,
    preview ? `Preview: ${preview}` : "",
    `Deadline: ${deadline}`,
    context.notes ? `\nNotes: ${context.notes}` : "",
    "",
    `Review & approve: ${context.approvalUrl}`,
    "",
    "No account needed — the link opens straight onto the approval page.",
  ]
    .filter((line) => line !== "")
    .join("\n");

  const html = layout(
    `<p style="margin:0 0 16px">${escapeHtml(greeting(context))}</p>
     <p style="margin:0 0 16px">${escapeHtml(context.agencyName)} has a creative waiting for your approval.</p>
     <p style="margin:0 0 4px;font-size:18px;font-weight:600">${escapeHtml(creative)}</p>
     ${preview ? `<p style="margin:0 0 4px"><a href="${escapeHtml(preview)}" style="color:#2563eb">View the creative</a></p>` : ""}
     <p style="margin:0 0 20px;color:#6b7280">Deadline: ${escapeHtml(deadline)}</p>
     ${context.notes ? `<p style="margin:0 0 20px;padding:12px;background:#f9fafb;border-radius:6px;white-space:pre-wrap">${escapeHtml(context.notes)}</p>` : ""}
     <p style="margin:0 0 8px"><a href="${escapeHtml(context.approvalUrl)}" style="${BUTTON_STYLE}">Review &amp; Approve</a></p>
     <p style="margin:16px 0 0;font-size:13px;color:#6b7280">No account needed.</p>`,
    context.agencyName,
  );

  return {
    to: "",
    subject: `Approval required: ${creative}`,
    text,
    html,
  };
}

/** 2. A scheduled nudge. `body` is supplied by the message generator. */
export function reminderEmail(
  context: EmailContext,
  body: string,
): EmailMessage {
  const creative = creativeLine(context);
  const deadline = formatDeadlineLong(context.deadline, context.timezone);

  const text = [
    greeting(context),
    "",
    body,
    "",
    creative,
    `Deadline: ${deadline}`,
    "",
    `Review & approve: ${context.approvalUrl}`,
  ].join("\n");

  const html = layout(
    `<p style="margin:0 0 16px">${escapeHtml(greeting(context))}</p>
     <p style="margin:0 0 16px">${escapeHtml(body)}</p>
     <p style="margin:0 0 4px;font-size:18px;font-weight:600">${escapeHtml(creative)}</p>
     <p style="margin:0 0 20px;color:#6b7280">Deadline: ${escapeHtml(deadline)}</p>
     <p style="margin:0"><a href="${escapeHtml(context.approvalUrl)}" style="${BUTTON_STYLE}">Review &amp; Approve</a></p>`,
    context.agencyName,
  );

  return { to: "", subject: `Reminder: ${creative}`, text, html };
}

/** 3. The last call before the deadline. */
export function deadlineWarningEmail(
  context: EmailContext,
  body: string,
): EmailMessage {
  const creative = creativeLine(context);
  const deadline = formatDeadlineLong(context.deadline, context.timezone);

  const text = [
    greeting(context),
    "",
    body,
    "",
    creative,
    `Deadline: ${deadline}`,
    "",
    `Review & approve: ${context.approvalUrl}`,
  ].join("\n");

  const html = layout(
    `<p style="margin:0 0 16px">${escapeHtml(greeting(context))}</p>
     <p style="margin:0 0 16px;font-weight:600">${escapeHtml(body)}</p>
     <p style="margin:0 0 4px;font-size:18px;font-weight:600">${escapeHtml(creative)}</p>
     <p style="margin:0 0 20px;color:#b45309">Deadline: ${escapeHtml(deadline)}</p>
     <p style="margin:0"><a href="${escapeHtml(context.approvalUrl)}" style="${BUTTON_STYLE}">Review &amp; Approve</a></p>`,
    context.agencyName,
  );

  return { to: "", subject: `Deadline today: ${creative}`, text, html };
}

/** 4. Receipt for the client once they approve. */
export function approvalConfirmationEmail(
  context: EmailContext,
): EmailMessage {
  const creative = creativeLine(context);
  const text = [
    greeting(context),
    "",
    `Thanks — you approved ${creative}. ${context.agencyName} has been notified.`,
    "",
    "Nothing else is needed from you.",
  ].join("\n");

  const html = layout(
    `<p style="margin:0 0 16px">${escapeHtml(greeting(context))}</p>
     <p style="margin:0 0 16px">Thanks — you approved <strong>${escapeHtml(creative)}</strong>.
     ${escapeHtml(context.agencyName)} has been notified.</p>
     <p style="margin:0;color:#6b7280">Nothing else is needed from you.</p>`,
    context.agencyName,
  );

  return { to: "", subject: `Approved: ${creative}`, text, html };
}

/** 5. Receipt for the client once they ask for changes. */
export function changesRequestedEmail(
  context: EmailContext,
  comment: string,
): EmailMessage {
  const creative = creativeLine(context);
  const text = [
    greeting(context),
    "",
    `Thanks — your change request for ${creative} has been sent to ${context.agencyName}.`,
    "",
    "What you asked for:",
    comment,
  ].join("\n");

  const html = layout(
    `<p style="margin:0 0 16px">${escapeHtml(greeting(context))}</p>
     <p style="margin:0 0 16px">Your change request for <strong>${escapeHtml(creative)}</strong>
     has been sent to ${escapeHtml(context.agencyName)}.</p>
     <p style="margin:0 0 8px;font-weight:600">What you asked for</p>
     <p style="margin:0;padding:12px;background:#f9fafb;border-radius:6px;white-space:pre-wrap">${escapeHtml(comment)}</p>`,
    context.agencyName,
  );

  return { to: "", subject: `Changes requested: ${creative}`, text, html };
}
