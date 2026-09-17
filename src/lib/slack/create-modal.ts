import { getMostRecentClientForActor } from "@/lib/db/repositories";
import { createModalView, type ClientPrefill } from "@/lib/slack/blocks";

/**
 * Build the /approval create modal, prefilled with whoever this Slack user
 * most recently sent an approval to.
 *
 * Shared by the slash command and the "Create your first approval" button in
 * the install welcome message, so the two ways into this modal never drift
 * apart.
 */
export async function buildCreateModalView(
  organizationId: string,
  slackUserId: string,
): Promise<Record<string, unknown>> {
  // Two days out, on the hour — a sensible starting point the picker can be
  // dragged from, rather than "now", which is never the answer.
  const suggested = new Date(Date.now() + 2 * 86_400_000);
  suggested.setMinutes(0, 0, 0);

  const recent = slackUserId
    ? await getMostRecentClientForActor(organizationId, slackUserId)
    : undefined;
  const prefill: ClientPrefill | undefined = recent
    ? { name: recent.name, email: recent.email, contactName: recent.contact_name }
    : undefined;

  return createModalView(Math.floor(suggested.getTime() / 1000), prefill);
}
