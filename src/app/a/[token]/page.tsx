import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { readAgencyLink } from "@/lib/crypto/signed-link";
import { approvalDetail } from "@/lib/approvals/service";
import { statusLabel } from "@/lib/approvals/state";
import { formatDeadlineLong, safeExternalUrl } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Approval history",
  robots: { index: false, follow: false },
};

/**
 * The agency's read-only view.
 *
 * Slack is the interface; this page exists for the one thing a modal is bad
 * at, which is a long audit trail. It is reached only through a link minted
 * inside Slack, where the request was signature-verified and the workspace
 * known, and that link carries the organization id — so the page authorizes
 * against the signed payload rather than anything in the URL path.
 *
 * It is deliberately read-only. An unauthenticated page that could change
 * state would be a much bigger promise than a one-hour link can keep.
 */
export default async function AgencyApprovalPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const link = readAgencyLink(token);
  if (!link) notFound();

  let detail;
  try {
    detail = await approvalDetail(link.organizationId, link.approvalId);
  } catch {
    notFound();
  }

  const { approval, events, reminders } = detail;
  const creativeUrl = safeExternalUrl(approval.creative_url);
  const timezone = approval.organization_timezone;

  return (
    <main className="page">
      <div className="card">
        <p className="eyebrow">{approval.client_name}</p>
        <h1>{approval.creative_name}</h1>
        <span className={`badge badge-${approval.status}`}>
          {statusLabel(approval.status)}
        </span>

        <dl className="meta">
          <div className="meta-row">
            <dt>Deadline</dt>
            <dd>{formatDeadlineLong(new Date(approval.deadline), timezone)}</dd>
          </div>
          <div className="meta-row">
            <dt>Client contact</dt>
            <dd>{approval.client_email}</dd>
          </div>
          {approval.first_viewed_at ? (
            <div className="meta-row">
              <dt>First opened</dt>
              <dd>
                {formatDeadlineLong(new Date(approval.first_viewed_at), timezone)}
              </dd>
            </div>
          ) : null}
          {approval.decided_at ? (
            <div className="meta-row">
              <dt>Decided</dt>
              <dd>{formatDeadlineLong(new Date(approval.decided_at), timezone)}</dd>
            </div>
          ) : null}
        </dl>

        {creativeUrl ? (
          <p>
            <a
              className="button"
              href={creativeUrl}
              target="_blank"
              rel="noopener noreferrer nofollow"
            >
              Open the creative ↗
            </a>
          </p>
        ) : null}

        {approval.decision_comment ? (
          <>
            <h2>Client comment</h2>
            <div className="notes">{approval.decision_comment}</div>
          </>
        ) : null}

        <h2>Reminders</h2>
        {reminders.length === 0 ? (
          <p className="muted small">None scheduled.</p>
        ) : (
          <table className="events">
            <thead>
              <tr>
                <th>#</th>
                <th>Kind</th>
                <th>Scheduled</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {reminders.map((reminder) => (
                <tr key={reminder.id}>
                  <td>{reminder.reminder_number === 0 ? "—" : reminder.reminder_number}</td>
                  <td>{reminder.kind.replace(/_/g, " ")}</td>
                  <td>
                    {formatDeadlineLong(new Date(reminder.scheduled_for), timezone)}
                  </td>
                  <td>{reminder.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <h2>History</h2>
        <table className="events">
          <thead>
            <tr>
              <th>When</th>
              <th>Event</th>
              <th>Actor</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <tr key={event.id}>
                <td>
                  {formatDeadlineLong(new Date(event.created_at), timezone)}
                </td>
                <td>{event.event_type.replace(/_/g, " ")}</td>
                <td>
                  {event.actor_type.replace(/_/g, " ")}
                  {event.actor_id ? ` · ${event.actor_id}` : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted" style={{ textAlign: "center", marginTop: 18 }}>
        This link expires an hour after it was opened from Slack.
      </p>
    </main>
  );
}
