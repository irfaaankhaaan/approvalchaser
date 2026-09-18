import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { verifySlackRequest } from "@/lib/slack/verify";
import { resolveSlackContext } from "@/lib/slack/context";
import {
  countApprovals,
  getOrganization,
  listApprovals,
} from "@/lib/db/repositories";
import { LIST_PAGE_SIZE, listBlocks, type ListMode } from "@/lib/slack/blocks";
import { buildCreateModalView } from "@/lib/slack/create-modal";
import { OPEN_LIST_STATUSES, RECENT_LIST_STATUSES } from "@/lib/slack/list-statuses";
import { SLACK_NOT_CONFIGURED_MESSAGE, slackIsConfigured } from "@/lib/slack/env-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function ephemeral(text: string, blocks?: unknown[]) {
  return NextResponse.json({
    response_type: "ephemeral",
    text,
    ...(blocks ? { blocks } : {}),
  });
}

export async function POST(request: Request) {
  // A deployment missing its Slack secrets cannot verify anything Slack
  // sends it. Caught here, before the signing secret is even read, so that
  // a misconfigured deploy answers with a clean, expected status rather
  // than an unhandled exception.
  if (!slackIsConfigured()) {
    return new NextResponse(SLACK_NOT_CONFIGURED_MESSAGE, { status: 503 });
  }

  // The signature is checked against the raw bytes, before anything is parsed.
  const rawBody = await request.text();
  const verified = verifySlackRequest(request, rawBody, env.slackSigningSecret);
  if (!verified.ok) {
    console.warn("[slack] rejected a slash command:", verified.reason);
    return new NextResponse("Signature verification failed", { status: 401 });
  }

  const form = new URLSearchParams(rawBody);
  const teamId = form.get("team_id");
  const channelId = form.get("channel_id") ?? "";
  const userId = form.get("user_id") ?? "";
  const triggerId = form.get("trigger_id") ?? "";
  const args = (form.get("text") ?? "").trim().split(/\s+/).filter(Boolean);
  const subcommand = (args[0] ?? "help").toLowerCase();

  const context = await resolveSlackContext(teamId);
  if (!context) {
    return ephemeral(
      "Approval Chaser isn't connected to this workspace yet. Ask an admin to install it.",
    );
  }

  switch (subcommand) {
    case "create":
    case "new": {
      try {
        // Prefilled with whoever this person last sent an approval to, so a
        // repeat approval is "swap the creative and deadline" rather than
        // retyping a client's name and email for the third time this week.
        const view = await buildCreateModalView(context.organizationId, userId);
        // The channel travels in private_metadata so the confirmation lands
        // where the command was typed.
        await context.gateway.openView(triggerId, {
          ...view,
          private_metadata: channelId,
        });
        return new NextResponse(null, { status: 200 });
      } catch (error) {
        // No modal is open yet to show an error in, unlike a button click on
        // an already-open surface — a slow or failing lookup here (the
        // prefill query, or Slack rejecting an expired trigger_id) has to
        // fall back to an ephemeral message instead.
        console.error("[slack] could not open the create modal:", error);
        return ephemeral(
          "Couldn't open that just now. Please run `/approval create` again.",
        );
      }
    }

    case "list":
    case "remind":
    case "cancel": {
      const mode: ListMode =
        subcommand === "remind" ? "remind" : subcommand === "cancel" ? "cancel" : "default";
      const showAll = subcommand === "list" && args[1]?.toLowerCase() === "all";
      const statuses = showAll ? RECENT_LIST_STATUSES : OPEN_LIST_STATUSES;

      const [approvals, total, organization] = await Promise.all([
        listApprovals({
          organizationId: context.organizationId,
          statuses,
          limit: LIST_PAGE_SIZE,
        }),
        countApprovals({ organizationId: context.organizationId, statuses }),
        getOrganization(context.organizationId),
      ]);

      const { text, blocks } = listBlocks({
        approvals,
        page: 0,
        total,
        timezone: organization?.timezone ?? "UTC",
        mode,
        showAll,
      });
      return ephemeral(text, blocks);
    }

    default:
      return ephemeral(
        [
          "*Approval Chaser*",
          "`/approval create` — send a creative to a client for sign-off",
          "`/approval list` — what's still open (`list all` includes approved)",
          "`/approval remind` — chase a client now",
          "`/approval cancel` — stop chasing and close a request",
        ].join("\n"),
      );
  }
}
