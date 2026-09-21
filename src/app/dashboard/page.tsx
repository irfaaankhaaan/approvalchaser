import type { Metadata } from "next";
import { getOrCreateDefaultOrganization } from "@/lib/db/repositories";
import { listApprovals, countApprovals } from "@/lib/db/repositories";
import { OPEN_LIST_STATUSES, RECENT_LIST_STATUSES } from "@/lib/slack/list-statuses";
import { statusLabel } from "@/lib/approvals/state";
import { formatDeadlineRelative } from "@/lib/format";
import { mintAgencyLink } from "@/lib/crypto/signed-link";
import { CreateApprovalForm } from "@/app/dashboard/CreateApprovalForm";
import { OrgName } from "@/app/dashboard/OrgName";
import { RowActions } from "@/app/dashboard/RowActions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Dashboard",
  robots: { index: false, follow: false },
};

/**
 * The web dashboard.
 *
 * Everything Slack's `/approval create`, `/approval list`,
 * `/approval remind` and `/approval cancel` do, reachable without a Slack
 * workspace: this page and the Slack commands both call the exact same
 * functions in src/lib/approvals and src/lib/reminders, so there is one
 * set of rules, not two. Slack stays fully optional — an approval created
 * here still gets reminded, escalated and audited the same way, and if a
 * Slack workspace is connected later it starts posting for approvals
 * created from either side.
 */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ all?: string }>;
}) {
  const { all } = await searchParams;
  const showAll = all === "1";

  const organization = await getOrCreateDefaultOrganization();
  const statuses = showAll ? RECENT_LIST_STATUSES : OPEN_LIST_STATUSES;

  const [approvals, openCount, totalCount] = await Promise.all([
    listApprovals({ organizationId: organization.id, statuses, limit: 100 }),
    countApprovals({ organizationId: organization.id, statuses: OPEN_LIST_STATUSES }),
    countApprovals({ organizationId: organization.id }),
  ]);

  return (
    <main className="dashboard">
      <div className="dashboard-header">
        <div>
          <OrgName name={organization.name} />
          <h1 style={{ margin: "2px 0 0" }}>Approvals</h1>
        </div>
        <CreateApprovalForm />
      </div>

      <div className="stat-row">
        <div className="stat">
          <div className="stat-value">{openCount}</div>
          <div className="stat-label">waiting on someone</div>
        </div>
        <div className="stat">
          <div className="stat-value">{totalCount}</div>
          <div className="stat-label">total</div>
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <div className="tabs" style={{ padding: "14px 16px", borderBottom: "1px solid var(--border)" }}>
          <a href="/dashboard" className={`tab${showAll ? "" : " tab-active"}`}>
            Active
          </a>
          <a href="/dashboard?all=1" className={`tab${showAll ? " tab-active" : ""}`}>
            All, including approved
          </a>
        </div>

        {approvals.length === 0 ? (
          <div className="empty-state">
            <p>Nothing here yet.</p>
            <p className="small">Click <strong>New approval</strong> to send your first one.</p>
          </div>
        ) : (
          <table className="approvals">
            <thead>
              <tr>
                <th>Client</th>
                <th>Creative</th>
                <th>Status</th>
                <th>Deadline</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {approvals.map((approval) => (
                <tr key={approval.id}>
                  <td data-label="Client">{approval.client_name}</td>
                  <td data-label="Creative">
                    {approval.creative_name}
                    {approval.creative_version ? ` (${approval.creative_version})` : ""}
                  </td>
                  <td data-label="Status">
                    <span className={`badge badge-${approval.status}`}>
                      {statusLabel(approval.status)}
                    </span>
                  </td>
                  <td data-label="Deadline">
                    {formatDeadlineRelative(
                      new Date(approval.deadline),
                      approval.organization_timezone,
                    )}
                  </td>
                  <td>
                    <RowActions
                      approval={approval}
                      detailUrl={`/a/${mintAgencyLink(approval.organization_id, approval.id)}`}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="local-only-note">
        This dashboard has no login — anyone who can reach this URL can see
        and manage every approval here. Fine for your own machine or a
        private network; don&apos;t put it on the public internet without
        adding your own authentication in front of it.
      </p>
    </main>
  );
}
