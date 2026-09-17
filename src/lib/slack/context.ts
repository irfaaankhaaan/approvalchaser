import {
  getInstallationByTeamId,
  upsertUserBySlackId,
} from "@/lib/db/repositories";
import { gatewayFor, type SlackGateway } from "@/lib/slack/client";
import type { SlackInstallation } from "@/lib/db/types";

/**
 * Turning a verified Slack request into an authorization context.
 *
 * This is the only place an organization id is derived on the Slack side, and
 * it derives it from `team_id` in the signed payload — never from anything a
 * button value or modal field could carry. That is what makes cross-tenant
 * access impossible rather than merely unlikely: a forged approval id in a
 * button reaches `getApproval(organizationId, id)` with the *sender's* own
 * organization, and simply finds nothing.
 */
export interface SlackContext {
  installation: SlackInstallation;
  organizationId: string;
  gateway: SlackGateway;
}

export async function resolveSlackContext(
  teamId: string | undefined | null,
): Promise<SlackContext | null> {
  if (!teamId) return null;
  const installation = await getInstallationByTeamId(teamId);
  if (!installation) return null;
  return {
    installation,
    organizationId: installation.organization_id,
    gateway: gatewayFor(installation),
  };
}

/** Record the agency-side user so audit entries name a person. */
export async function actingUser(
  context: SlackContext,
  slackUserId: string,
  displayName?: string,
): Promise<string | null> {
  try {
    const user = await upsertUserBySlackId({
      organizationId: context.organizationId,
      slackUserId,
      name: displayName || slackUserId,
    });
    return user.id;
  } catch (error) {
    console.error("[slack] could not record the acting user:", error);
    return null;
  }
}
