import {
  getInstallationForOrg,
  setApprovalSlackMessage,
} from "@/lib/db/repositories";
import { gatewayFor, type SlackBlock, type SlackGateway } from "@/lib/slack/client";
import { approvalMessage } from "@/lib/slack/blocks";
import type { ApprovalWithClient, SlackInstallation } from "@/lib/db/types";

/**
 * Talking to the agency.
 *
 * Every function here is best-effort and swallows its own errors. That is
 * deliberate and it is the important design decision in this file: if Slack
 * is down when a client approves, the approval is still recorded, the client
 * still gets their receipt, and the agency finds out when Slack comes back.
 * A notification failure must never roll back a decision.
 */

export interface OrgSlack {
  installation: SlackInstallation;
  gateway: SlackGateway;
}

export async function slackFor(
  organizationId: string,
): Promise<OrgSlack | null> {
  const installation = await getInstallationForOrg(organizationId);
  if (!installation) return null;
  return { installation, gateway: gatewayFor(installation) };
}

/** Post the approval message and remember where it landed. */
export async function publishApprovalMessage(
  approval: ApprovalWithClient,
  channelId: string,
  slack?: OrgSlack | null,
): Promise<{ channel: string; ts: string } | null> {
  const target = slack ?? (await slackFor(approval.organization_id));
  if (!target) return null;

  try {
    const { text, blocks } = approvalMessage(approval);
    const result = await target.gateway.postMessage({
      channel: channelId,
      text,
      blocks,
    });
    await setApprovalSlackMessage({
      organizationId: approval.organization_id,
      approvalId: approval.id,
      channelId: result.channel,
      messageTs: result.ts,
    });
    return result;
  } catch (error) {
    console.error("[slack] could not post the approval message:", error);
    return null;
  }
}

/** Rewrite the original message so its status line is current. */
export async function refreshApprovalMessage(
  approval: ApprovalWithClient,
  slack?: OrgSlack | null,
): Promise<void> {
  if (!approval.slack_channel_id || !approval.slack_message_ts) return;
  const target = slack ?? (await slackFor(approval.organization_id));
  if (!target) return;

  try {
    const { text, blocks } = approvalMessage(approval);
    await target.gateway.updateMessage({
      channel: approval.slack_channel_id,
      ts: approval.slack_message_ts,
      text,
      blocks,
    });
  } catch (error) {
    console.error("[slack] could not update the approval message:", error);
  }
}

/**
 * Reply under the approval message.
 *
 * Threading is what keeps a busy channel readable: one approval is one thread,
 * however many reminders and status changes it goes through. With no parent
 * message to thread under, the reply is skipped rather than dumped into the
 * channel as a loose message.
 */
export async function replyInThread(
  approval: ApprovalWithClient,
  message: { text: string; blocks: SlackBlock[] },
  slack?: OrgSlack | null,
): Promise<void> {
  if (!approval.slack_channel_id || !approval.slack_message_ts) return;
  const target = slack ?? (await slackFor(approval.organization_id));
  if (!target) return;

  try {
    await target.gateway.postMessage({
      channel: approval.slack_channel_id,
      text: message.text,
      blocks: message.blocks,
      threadTs: approval.slack_message_ts,
    });
  } catch (error) {
    console.error("[slack] could not post the thread reply:", error);
  }
}

/** Both halves of a status change: refresh the parent, then say what happened. */
export async function announceStatusChange(
  approval: ApprovalWithClient,
  message: { text: string; blocks: SlackBlock[] },
): Promise<void> {
  const slack = await slackFor(approval.organization_id);
  if (!slack) return;
  await refreshApprovalMessage(approval, slack);
  await replyInThread(approval, message, slack);
}
