import { statusLabel } from "@/lib/approvals/state";
import { formatDeadlineLong, safeExternalUrl } from "@/lib/format";
import type { ApprovalWithClient } from "@/lib/db/types";
import { ClientDecision } from "@/app/approve/ClientDecision";

/**
 * The client approval page.
 *
 * The client has no account and, most likely, no interest in this tool. So:
 * what they are approving, when it is due, two buttons. Everything the agency
 * might find useful and the client would not is left out.
 */
export function ApprovalScreen({
  approval,
  credentialKind,
  credential,
}: {
  approval: ApprovalWithClient;
  credentialKind: "token" | "pointer";
  credential: string;
}) {
  const creativeUrl = safeExternalUrl(approval.creative_url);
  const deadline = formatDeadlineLong(
    new Date(approval.deadline),
    approval.organization_timezone,
  );
  const decided =
    approval.status === "approved" ||
    approval.status === "changes_requested" ||
    approval.status === "cancelled";

  return (
    <main className="page">
      <div className="card">
        <p className="eyebrow">{approval.organization_name}</p>
        <h1>{approval.creative_name}</h1>
        <p className="muted" style={{ margin: "0 0 14px" }}>
          For {approval.client_name}
          {approval.creative_version ? ` · ${approval.creative_version}` : ""}
        </p>
        <span className={`badge badge-${approval.status}`}>
          {statusLabel(approval.status)}
        </span>

        <dl className="meta">
          <div className="meta-row">
            <dt>Deadline</dt>
            <dd>{deadline}</dd>
          </div>
          {approval.client_contact_name ? (
            <div className="meta-row">
              <dt>Reviewer</dt>
              <dd>{approval.client_contact_name}</dd>
            </div>
          ) : null}
        </dl>

        {creativeUrl ? <CreativePreview url={creativeUrl} /> : null}

        {approval.notes ? <div className="notes">{approval.notes}</div> : null}

        {approval.status === "cancelled" ? (
          <p className="muted">
            This request was cancelled by {approval.organization_name}. There is
            nothing to approve.
          </p>
        ) : decided ? (
          <DecisionSummary approval={approval} />
        ) : (
          <ClientDecision
            credentialKind={credentialKind}
            credential={credential}
          />
        )}
      </div>
      <p className="small muted" style={{ textAlign: "center", marginTop: 18 }}>
        This link is private to you. Please don&apos;t forward it.
      </p>
    </main>
  );
}

function DecisionSummary({ approval }: { approval: ApprovalWithClient }) {
  if (approval.status === "approved") {
    return (
      <div className="result">
        <div className="result-mark" aria-hidden="true">
          ✅
        </div>
        <h2 style={{ margin: 0 }}>Already approved</h2>
        <p className="muted">
          You approved this
          {approval.decided_at
            ? ` on ${formatDeadlineLong(new Date(approval.decided_at), approval.organization_timezone)}`
            : ""}
          . Nothing else is needed.
        </p>
      </div>
    );
  }

  return (
    <div>
      <h2>Changes requested</h2>
      {approval.decision_comment ? (
        <div className="notes">{approval.decision_comment}</div>
      ) : null}
      <p className="muted small">
        {approval.organization_name} is working on a new version. You&apos;ll
        get a fresh link when it&apos;s ready.
      </p>
    </div>
  );
}

/**
 * Preview, where it can be done safely.
 *
 * Images are rendered inline. Everything else — including video platforms — is
 * a plain link rather than an embed: framing an arbitrary client-supplied URL
 * inside this page is not a preview feature, it is an invitation. The URL has
 * already been checked to be http(s) by `safeExternalUrl`.
 */
function CreativePreview({ url }: { url: string }) {
  const isImage = /\.(png|jpe?g|gif|webp|avif)(\?|$)/i.test(url);

  if (isImage) {
    return (
      <span className="preview">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt="The creative awaiting approval" />
      </span>
    );
  }

  return (
    <p style={{ margin: "18px 0" }}>
      <a
        className="button"
        href={url}
        target="_blank"
        rel="noopener noreferrer nofollow"
      >
        Open the creative ↗
      </a>
    </p>
  );
}
