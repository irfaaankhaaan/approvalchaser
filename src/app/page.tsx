import { slackIsConfigured } from "@/lib/slack/env-guard";

/**
 * The landing page.
 *
 * This checks slackIsConfigured() itself rather than leaving that to
 * whatever the "Add to Slack" link happens to lead to. A deployment that
 * hasn't connected Slack yet — every fresh local checkout, until someone
 * fills in the four Slack variables — showed one button and it went nowhere
 * useful: "Slack isn't set up yet." The fix is to not offer that button
 * until it would actually work, and point at the thing that does work
 * instead.
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
          Your team works in Slack. Your client gets an email with one link —
          no account, no login. The bot reminds them on schedule and tells you
          in Slack the moment something is approved, changed, or at risk.
        </p>

        {configured ? (
          <>
            <h2>Getting started</h2>
            <p className="small muted">
              Install the Slack app into your workspace, then run{" "}
              <code>/approval create</code> in any channel.
            </p>
            <div className="actions">
              <a className="button button-primary" href="/api/slack/install">
                Add to Slack
              </a>
            </div>
          </>
        ) : (
          <>
            <h2>Try it locally, no Slack required</h2>
            <p className="small muted">
              Run <code>npm run db:seed</code> in a terminal in this project —
              it prints three working approval links you can open right now.
              No account, nothing to configure.
            </p>
            <p className="small muted" style={{ marginTop: 16 }}>
              Slack isn&apos;t connected on this deployment yet. That needs
              four values in <code>.env.local</code> — see the{" "}
              <strong>Setting up the Slack app</strong> section of the
              README.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
