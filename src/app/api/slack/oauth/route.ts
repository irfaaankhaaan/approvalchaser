import { NextResponse, after } from "next/server";
import { env } from "@/lib/env";
import { verifyOAuthState } from "@/lib/slack/verify";
import { encryptSecret } from "@/lib/crypto/secretbox";
import {
  createOrganization,
  getInstallationByTeamId,
  upsertSlackInstallation,
} from "@/lib/db/repositories";
import { sendInstallWelcome } from "@/lib/notifications/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The install callback.
 *
 * One Slack workspace maps to one organization. A re-install updates the
 * existing row — including the bot token, which Slack rotates — rather than
 * creating a second tenant that would not see the first one's approvals.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code) {
    return html(400, "Install failed", "Slack did not send an authorization code.");
  }
  if (!verifyOAuthState(env.slackStateSecret, state)) {
    // Either a forged callback or a stale browser tab. Both get sent back to
    // the start rather than exchanging the code.
    return html(
      400,
      "Install failed",
      "That install link has expired. Please start again from the top.",
    );
  }

  const response = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.slackClientId,
      client_secret: env.slackClientSecret,
      code,
      redirect_uri: `${env.appUrl}/api/slack/oauth`,
    }),
  });

  const payload = (await response.json()) as {
    ok: boolean;
    error?: string;
    access_token?: string;
    bot_user_id?: string;
    app_id?: string;
    team?: { id: string; name?: string };
    enterprise?: { id: string } | null;
    authed_user?: { id?: string };
  };

  if (!payload.ok || !payload.access_token || !payload.team?.id) {
    console.error("[slack] oauth exchange failed:", payload.error);
    return html(400, "Install failed", "Slack rejected the installation.");
  }

  const existing = await getInstallationByTeamId(payload.team.id);
  const organizationId =
    existing?.organization_id ??
    (await createOrganization(payload.team.name ?? "Agency")).id;

  const { installation, wasInserted } = await upsertSlackInstallation({
    organizationId,
    teamId: payload.team.id,
    teamName: payload.team.name ?? null,
    enterpriseId: payload.enterprise?.id ?? null,
    appId: payload.app_id ?? null,
    botUserId: payload.bot_user_id ?? "",
    // The bot token never touches the database in the clear.
    encryptedBotToken: encryptSecret(payload.access_token),
    installedBy: payload.authed_user?.id ?? null,
  });

  // Only a genuine first install gets the "you're connected, here's how to
  // start" DM. A re-install — Slack rotating the bot token, a teammate
  // re-authorizing after a new scope is added — updates the same row, and a
  // workspace that has been live for months does not need to be told to send
  // its first approval. `wasInserted` comes from the upsert's own row, not a
  // separate read taken beforehand, so a double-clicked install button or a
  // retried redirect racing two callbacks for the same team cannot both see
  // "no existing row" and both send the DM — only whichever request's INSERT
  // actually won does.
  if (wasInserted) {
    // Deferred so the install page returns immediately rather than waiting
    // on a Slack API round trip; `after()` still guarantees it runs to
    // completion once the response is sent, unlike a bare un-awaited call,
    // which a serverless runtime can tear down mid-flight.
    after(() => sendInstallWelcome(installation, payload.authed_user?.id));
  }

  return html(
    200,
    "Approval Chaser is installed",
    wasInserted
      ? "Check Slack — I've sent you a DM with the next step. Or head back " +
        "and run <code>/approval create</code> in any channel."
      : "Head back to Slack — everything you had before is still there.",
  );
}

function html(status: number, title: string, body: string) {
  return new NextResponse(
    `<!doctype html><html><head><meta charset="utf-8">
     <meta name="viewport" content="width=device-width,initial-scale=1">
     <title>${title}</title>
     <style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
     background:#f6f7f9;color:#111827;display:grid;place-items:center;height:100vh;margin:0}
     div{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:32px;max-width:420px;text-align:center}
     </style></head><body><div><h1>${title}</h1><p>${body}</p></div></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}
