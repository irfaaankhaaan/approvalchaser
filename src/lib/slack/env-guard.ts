import { optional } from "@/lib/env";

/**
 * Whether this deployment has the minimum Slack configuration to handle a
 * Slack request at all.
 *
 * `env.slackSigningSecret` and friends throw at the point of use by design
 * (see env.ts) — a clear message naming the missing variable, in server
 * logs, for whoever is standing the app up. That is the right behavior for
 * a developer. It is the wrong behavior for the three Slack-facing routes:
 * without this check, a request that arrives before Slack is configured (a
 * deploy that forgot a secret, a health checker, a curious visitor) turns
 * into an unhandled exception and a bare 500 instead of a clean "not
 * configured" response.
 */
export function slackIsConfigured(): boolean {
  return Boolean(
    optional("SLACK_SIGNING_SECRET") &&
      optional("SLACK_CLIENT_ID") &&
      optional("SLACK_CLIENT_SECRET") &&
      optional("SLACK_STATE_SECRET"),
  );
}

export const SLACK_NOT_CONFIGURED_MESSAGE =
  "Slack is not configured on this deployment yet.";
