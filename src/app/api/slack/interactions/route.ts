import { NextResponse, after } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { verifySlackRequest } from "@/lib/slack/verify";
import {
  actingUser,
  resolveSlackContext,
  type SlackContext,
} from "@/lib/slack/context";
import {
  countApprovals,
  getApproval,
  getOrganization,
  listApprovals,
} from "@/lib/db/repositories";
import {
  ACTIONS,
  CALLBACKS,
  FIELDS,
  LIST_PAGE_SIZE,
  decodeListPage,
  detailModalView,
  errorModalView,
  listBlocks,
  rescheduleModalView,
} from "@/lib/slack/blocks";
import {
  ApprovalError,
  approvalDetail,
  cancelApproval,
  createApproval,
  rescheduleApproval,
} from "@/lib/approvals/service";
import { sendManualReminder } from "@/lib/reminders/service";
import { presetOffsets } from "@/lib/reminders/schedule";
import { mintAgencyLink } from "@/lib/crypto/signed-link";
import { buildCreateModalView } from "@/lib/slack/create-modal";
import { safeExternalUrl } from "@/lib/format";
import { OPEN_LIST_STATUSES, RECENT_LIST_STATUSES } from "@/lib/slack/list-statuses";
import { SLACK_NOT_CONFIGURED_MESSAGE, slackIsConfigured } from "@/lib/slack/env-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Slack interactivity.
 *
 * Slack expects an answer within three seconds, and creating an approval means
 * a database write, an email and a Slack post — comfortably more than that on
 * a cold start. So each handler splits in two: validate and acknowledge
 * synchronously, then do the work in `after()`, which runs once the response
 * has been flushed. Validation that the user should see as a form error stays
 * on the synchronous side.
 */

export async function POST(request: Request) {
  if (!slackIsConfigured()) {
    return new NextResponse(SLACK_NOT_CONFIGURED_MESSAGE, { status: 503 });
  }

  const rawBody = await request.text();
  const verified = verifySlackRequest(request, rawBody, env.slackSigningSecret);
  if (!verified.ok) {
    console.warn("[slack] rejected an interaction:", verified.reason);
    return new NextResponse("Signature verification failed", { status: 401 });
  }

  const encoded = new URLSearchParams(rawBody).get("payload");
  if (!encoded) return new NextResponse("Missing payload", { status: 400 });

  let payload: SlackInteraction;
  try {
    payload = JSON.parse(encoded) as SlackInteraction;
  } catch {
    return new NextResponse("Malformed payload", { status: 400 });
  }

  // The organization comes from the signed team id and nowhere else.
  const context = await resolveSlackContext(payload.team?.id);
  if (!context) {
    return NextResponse.json({
      response_action: "errors",
      errors: { [FIELDS.clientName]: "This workspace is not connected." },
    });
  }

  if (payload.type === "block_actions") return handleBlockAction(payload, context);
  if (payload.type === "view_submission") return handleViewSubmission(payload, context);

  return new NextResponse(null, { status: 200 });
}

// ---------------------------------------------------------------------------
// Buttons and menus
// ---------------------------------------------------------------------------

async function handleBlockAction(
  payload: SlackInteraction,
  context: SlackContext,
): Promise<NextResponse> {
  const action = payload.actions?.[0];
  if (!action) return new NextResponse(null, { status: 200 });

  const userId = payload.user?.id ?? "";
  const channelId = payload.channel?.id ?? "";
  const triggerId = payload.trigger_id ?? "";

  // An overflow menu carries "verb:id"; a button carries the id alone.
  const rawValue = action.selected_option?.value ?? action.value ?? "";
  const [maybeVerb, maybeId] = rawValue.includes(":")
    ? (rawValue.split(":", 2) as [string, string])
    : [null, rawValue];
  const actionId = maybeVerb
    ? ({ view: ACTIONS.view, remind: ACTIONS.remind, cancel: ACTIONS.cancel }[
        maybeVerb
      ] ?? action.action_id)
    : action.action_id;
  const approvalId = maybeId ?? "";

  // The welcome DM's button. Same modal `/approval create` opens, same
  // prefill — one way in, reached from two places.
  if (actionId === ACTIONS.create) {
    try {
      const view = await buildCreateModalView(context.organizationId, userId);
      await context.gateway.openView(triggerId, { ...view, private_metadata: channelId });
    } catch (error) {
      console.error("[slack] could not open the create modal:", error);
      await context.gateway.openView(
        triggerId,
        errorModalView("Couldn't open that just now. Please try `/approval create` instead."),
      );
    }
    return new NextResponse(null, { status: 200 });
  }

  if (actionId === ACTIONS.listPage) {
    // The button's value carries page, mode and status set together — losing
    // any of them on "Next" would silently swap the user back to the default
    // overflow-menu list, or drop approved items out of a `list all` view.
    const { page, mode: pageMode, showAll } = decodeListPage(action.value);
    const statuses = showAll ? RECENT_LIST_STATUSES : OPEN_LIST_STATUSES;

    const [approvals, total, organization] = await Promise.all([
      listApprovals({
        organizationId: context.organizationId,
        statuses,
        limit: LIST_PAGE_SIZE,
        offset: page * LIST_PAGE_SIZE,
      }),
      countApprovals({ organizationId: context.organizationId, statuses }),
      getOrganization(context.organizationId),
    ]);
    const { text, blocks } = listBlocks({
      approvals,
      page,
      total,
      timezone: organization?.timezone ?? "UTC",
      mode: pageMode,
      showAll,
    });
    return NextResponse.json({ response_type: "ephemeral", replace_original: true, text, blocks });
  }

  // "View" opens a modal, which needs the trigger_id while it is still fresh,
  // so this one is done inline rather than deferred.
  if (actionId === ACTIONS.view) {
    try {
      const detail = await approvalDetail(context.organizationId, approvalId);
      await context.gateway.openView(triggerId, {
        ...detailModalView({
          ...detail,
          browserUrl: `${env.appUrl}/a/${mintAgencyLink(context.organizationId, approvalId)}`,
        }),
      });
    } catch (error) {
      await context.gateway.openView(
        triggerId,
        errorModalView(
          error instanceof ApprovalError
            ? error.message
            : "That approval could not be opened.",
        ),
      );
    }
    return new NextResponse(null, { status: 200 });
  }

  if (actionId === ACTIONS.reschedule) {
    const approval = await getApproval(context.organizationId, approvalId);
    await context.gateway.openView(
      triggerId,
      approval
        ? rescheduleModalView(approval)
        : errorModalView("That approval could not be found."),
    );
    return new NextResponse(null, { status: 200 });
  }

  if (actionId === ACTIONS.remind || actionId === ACTIONS.cancel) {
    after(async () => {
      try {
        const actorId = await actingUser(context, userId, payload.user?.name);
        if (actionId === ACTIONS.remind) {
          await sendManualReminder({
            organizationId: context.organizationId,
            approvalId,
            actorSlackUserId: userId,
          });
        } else {
          await cancelApproval({
            organizationId: context.organizationId,
            approvalId,
            actorSlackUserId: userId,
          });
        }
        void actorId;
      } catch (error) {
        await tellUser(
          context,
          channelId,
          userId,
          error instanceof Error
            ? error.message
            : "That didn't work. Please try again.",
        );
      }
    });
  }

  return new NextResponse(null, { status: 200 });
}

// ---------------------------------------------------------------------------
// Modal submissions
// ---------------------------------------------------------------------------

/**
 * What the create modal is allowed to contain.
 *
 * Slack validates almost nothing for us — `email_text_input` checks shape in
 * the client and that is it — so everything is re-checked here, server-side,
 * before a row is written.
 */
const createSchema = z.object({
  clientName: z.string().trim().min(1).max(120),
  clientEmail: z.string().trim().email().max(254),
  contactName: z.string().trim().max(80).optional().nullable(),
  creativeName: z.string().trim().min(1).max(200),
  creativeUrl: z.string().trim().max(2048).optional().nullable(),
  notes: z.string().trim().max(1000).optional().nullable(),
  deadlineEpoch: z.number().int().positive(),
  schedulePreset: z.string().trim().min(1).max(40),
});

async function handleViewSubmission(
  payload: SlackInteraction,
  context: SlackContext,
): Promise<NextResponse> {
  const values = payload.view?.state?.values ?? {};
  const userId = payload.user?.id ?? "";

  const field = (block: string): string | undefined =>
    values[block]?.value?.value ?? undefined;
  const epoch = (block: string): number | undefined =>
    values[block]?.value?.selected_date_time ?? undefined;
  const selected = (block: string): string | undefined =>
    values[block]?.value?.selected_option?.value ?? undefined;

  if (payload.view?.callback_id === CALLBACKS.reschedule) {
    const approvalId = payload.view.private_metadata ?? "";
    const deadlineEpoch = epoch(FIELDS.deadline);
    if (!deadlineEpoch || deadlineEpoch * 1000 <= Date.now()) {
      return NextResponse.json({
        response_action: "errors",
        errors: { [FIELDS.deadline]: "Pick a deadline in the future." },
      });
    }
    const offsets = presetOffsets(selected(FIELDS.schedule) ?? "");

    after(async () => {
      try {
        await rescheduleApproval({
          organizationId: context.organizationId,
          approvalId,
          deadline: new Date(deadlineEpoch * 1000),
          reminderOffsets: offsets,
          actorSlackUserId: userId,
        });
      } catch (error) {
        console.error("[slack] reschedule failed:", error);
      }
    });

    return NextResponse.json({ response_action: "clear" });
  }

  if (payload.view?.callback_id !== CALLBACKS.create) {
    return new NextResponse(null, { status: 200 });
  }

  const parsed = createSchema.safeParse({
    clientName: field(FIELDS.clientName) ?? "",
    clientEmail: field(FIELDS.clientEmail) ?? "",
    contactName: field(FIELDS.contactName) ?? null,
    creativeName: field(FIELDS.creativeName) ?? "",
    creativeUrl: field(FIELDS.creativeUrl) ?? null,
    notes: field(FIELDS.notes) ?? null,
    deadlineEpoch: epoch(FIELDS.deadline) ?? 0,
    schedulePreset: selected(FIELDS.schedule) ?? "12h_4h_2h",
  });

  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0]);
      const block =
        {
          clientName: FIELDS.clientName,
          clientEmail: FIELDS.clientEmail,
          contactName: FIELDS.contactName,
          creativeName: FIELDS.creativeName,
          creativeUrl: FIELDS.creativeUrl,
          notes: FIELDS.notes,
          deadlineEpoch: FIELDS.deadline,
          schedulePreset: FIELDS.schedule,
        }[key] ?? FIELDS.clientName;
      errors[block] = issue.message;
    }
    return NextResponse.json({ response_action: "errors", errors });
  }

  const deadline = new Date(parsed.data.deadlineEpoch * 1000);
  if (deadline.getTime() <= Date.now()) {
    return NextResponse.json({
      response_action: "errors",
      errors: { [FIELDS.deadline]: "Pick a deadline in the future." },
    });
  }

  // A creative URL that is not http(s) is rejected here rather than silently
  // dropped, so nobody discovers at send time that their link vanished.
  const creativeUrl = parsed.data.creativeUrl
    ? safeExternalUrl(parsed.data.creativeUrl)
    : null;
  if (parsed.data.creativeUrl && !creativeUrl) {
    return NextResponse.json({
      response_action: "errors",
      errors: { [FIELDS.creativeUrl]: "Use a full http:// or https:// link." },
    });
  }

  const channelId = payload.view?.private_metadata || "";

  after(async () => {
    try {
      const createdBy = await actingUser(context, userId, payload.user?.name);
      await createApproval({
        organizationId: context.organizationId,
        createdBy,
        actorSlackUserId: userId,
        clientName: parsed.data.clientName,
        clientEmail: parsed.data.clientEmail,
        contactName: parsed.data.contactName ?? null,
        creativeName: parsed.data.creativeName,
        creativeUrl,
        notes: parsed.data.notes ?? null,
        deadline,
        reminderOffsets: presetOffsets(parsed.data.schedulePreset),
        slackChannelId: channelId || null,
      });
    } catch (error) {
      console.error("[slack] approval creation failed:", error);
      await tellUser(
        context,
        channelId,
        userId,
        error instanceof ApprovalError
          ? `That approval wasn't created: ${error.message}`
          : "That approval wasn't created. The client has not been emailed.",
      );
    }
  });

  return NextResponse.json({ response_action: "clear" });
}

/** Tell one person something went wrong, without filling the channel. */
async function tellUser(
  context: SlackContext,
  channelId: string,
  userId: string,
  text: string,
): Promise<void> {
  if (!channelId || !userId) return;
  try {
    await context.gateway.postEphemeral({ channel: channelId, user: userId, text });
  } catch (error) {
    console.error("[slack] could not deliver the error message:", error);
  }
}

// ---------------------------------------------------------------------------

interface SlackInteraction {
  type: string;
  trigger_id?: string;
  team?: { id: string };
  user?: { id: string; name?: string };
  channel?: { id: string };
  actions?: {
    action_id: string;
    value?: string;
    selected_option?: { value: string };
  }[];
  view?: {
    callback_id?: string;
    private_metadata?: string;
    state?: {
      values: Record<
        string,
        Record<
          string,
          {
            value?: string;
            selected_date_time?: number;
            selected_option?: { value: string };
          }
        >
      >;
    };
  };
}
