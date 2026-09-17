import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { signOAuthState } from "@/lib/slack/verify";

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
  const state = signOAuthState(env.slackStateSecret, randomUUID(), Date.now());

  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", env.slackClientId);
  url.searchParams.set("scope", SCOPES.join(","));
  url.searchParams.set("state", state);
  url.searchParams.set("redirect_uri", `${env.appUrl}/api/slack/oauth`);

  return NextResponse.redirect(url.toString());
}
