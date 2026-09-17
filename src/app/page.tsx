export const dynamic = "force-static";

export default function Home() {
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
        <h2>Getting started</h2>
        <p className="small muted">
          Install the Slack app into your workspace, then run{" "}
          <code>/approval create</code> in any channel. Setup instructions are
          in the project README.
        </p>
        <div className="actions">
          <a className="button button-primary" href="/api/slack/install">
            Add to Slack
          </a>
        </div>
      </div>
    </main>
  );
}
