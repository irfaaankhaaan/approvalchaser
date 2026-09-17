import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { verifySlackRequest } from "@/lib/slack/verify";
import { resolveSlackContext } from "@/lib/slack/context";
import {
  countApprovals,
  getOrganization,
  listApprovals,
} from "@/lib/db/repositories";
import {
  LIST_PAGE_SIZE,
  createModalView,
  listBlocks,
  type ListMode,
} from "@/lib/slack/blocks";
import type { ApprovalStatus } from "@/lib/db/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Everything still waiting on somebody. */
const OPEN: ApprovalStatus[] = ["waiting", "viewed", "overdue", "changes_requested"];
const RECENT: ApprovalStatus[] = [...OPEN, "approved"];

function ephemeral(text: string, blocks?: unknown[]) {
  return NextResponse.json({
    response_type: "ephemeral",
    text,
    ...(blocks ? { blocks } : {}),
  });
}

export async function POST(request: Request) {
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
      // Two days out, on the hour — a sensible starting point the picker can
      // be dragged from, rather than "now", which is never the answer.
      const suggested = new Date(Date.now() + 2 * 86_400_000);
      suggested.setMinutes(0, 0, 0);

      const view = createModalView(Math.floor(suggested.getTime() / 1000));
      // The channel travels in private_metadata so the confirmation lands
      // where the command was typed.
      await context.gateway.openView(triggerId, {
        ...view,
        private_metadata: channelId,
      });
      return new NextResponse(null, { status: 200 });
    }

    case "list":
    case "remind":
    case "cancel": {
      const mode: ListMode =
        subcommand === "remind" ? "remind" : subcommand === "cancel" ? "cancel" : "default";
      const showAll = subcommand === "list" && args[1]?.toLowerCase() === "all";
      const statuses = showAll ? RECENT : OPEN;

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
