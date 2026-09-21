import { slackIsConfigured } from "@/lib/slack/env-guard";

/**
 * The landing page.
 *
 * This checks slackIsConfigured() itself rather than leaving that to
 * whatever the "Add to Slack" link happens to lead to. A deployment that
 * hasn't connected Slack yet — every fresh local checkout, until someone
 * fills in the four Slack variables — showed one button and it went nowhere
 * useful: "Slack isn't set up yet." The fix is to not offer that button
 * until it would actually work.
 *
 * The dashboard link is the real fix for what used to sit behind that dead
 * button: creating and managing an approval without Slack no longer means
 * opening a terminal and typing a command either — it's a page.
 *
 * Forced dynamic rather than left to Next's default static analysis:
 * reading process.env isn't a signal Next treats as a reason to render per
 * request, so a plain server component here would get prerendered once at
 * build time and could serve a stale answer — "not connected" baked in from
 * before Slack was configured, even after the real env caught up — on an
 * ordinary `next build && next start` deploy. Evaluating this once per
 * request costs nothing; it's a handful of process.env reads.
 */
export const dynamic = "force-dynamic";

export default function Home() {
  const configured = slackIsConfigured();

  return (
    <main className="page">
      <div className="card">
        <p className="eyebrow">Approval Chaser</p>
        <h1>Stop chasing clients for creative approvals.</h1>
        <p className="muted">
          Send a creative for sign-off. Your client gets an email with one
          link — no account, no login. It reminds them on schedule and tells
          you the moment something is approved, changed, or at risk.
        </p>

        <div className="actions">
          <a className="button button-primary" href="/dashboard">
            Open dashboard
          </a>
          {configured ? (
            <a className="button" href="/api/slack/install">
              Add to Slack
            </a>
          ) : null}
        </div>

        {configured ? (
          <p className="small muted" style={{ marginTop: 16 }}>
            Slack is connected — approvals created in the dashboard or with{" "}
            <code>/approval create</code> both show up in either place.
          </p>
        ) : (
          <p className="small muted" style={{ marginTop: 16 }}>
            Slack isn&apos;t connected on this deployment yet — the dashboard
            works fully without it. Connecting Slack needs four values in{" "}
            <code>.env.local</code>; see the <strong>Setting up the Slack
            app</strong> section of the README.
          </p>
        )}
      </div>
    </main>
  );
}
