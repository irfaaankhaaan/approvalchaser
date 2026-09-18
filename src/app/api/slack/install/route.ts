import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { signOAuthState } from "@/lib/slack/verify";
import { slackIsConfigured } from "@/lib/slack/env-guard";
import { htmlPage } from "@/lib/slack/error-page";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Start the install.
 *
 * The `state` parameter is an HMAC of a nonce and a timestamp, which is what
 * lets the callback tell a redirect it started from one an attacker did. It
 * expires after ten minutes.
 */
const SCOPES = ["commands", "chat:write", "chat:write.public", "users:read"];

export function GET() {
  // A human clicked "Add to Slack" to get here. Without this check, a
  // deployment missing its Slack credentials sends them a blank 500 instead
  // of a page that says what's actually wrong.
  if (!slackIsConfigured()) {
    return htmlPage(
      503,
      "Slack isn't set up yet",
      "This deployment hasn't been configured with Slack credentials. " +
        "If you run this project, add SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, " +
        "SLACK_SIGNING_SECRET and SLACK_STATE_SECRET — see the README.",
    );
  }

  const state = signOAuthState(env.slackStateSecret, randomUUID(), Date.now());

  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", env.slackClientId);
  url.searchParams.set("scope", SCOPES.join(","));
  url.searchParams.set("state", state);
  url.searchParams.set("redirect_uri", `${env.appUrl}/api/slack/oauth`);

  return NextResponse.redirect(url.toString());
}
