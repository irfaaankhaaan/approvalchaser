"use client";

import { useTransition } from "react";
import { cancelApprovalAction, remindApprovalAction } from "@/app/dashboard/actions";
import { isTerminal } from "@/lib/approvals/state";
import type { ApprovalWithClient } from "@/lib/db/types";

/**
 * Per-row buttons.
 *
 * Plain forms bound to a server action with the approval's id — the same
 * "no JavaScript required for the action itself" approach as the client
 * approval page. useTransition only drives the disabled state while a row
 * action is in flight; the action would work identically without it.
 *
 * `detailUrl` is minted server-side, in page.tsx, and passed down as a
 * plain string. Minting it here instead would mean importing the signing
 * function — and the secret it reads — into a "use client" file, which
 * bundles for the browser.
 */
export function RowActions({
  approval,
  detailUrl,
}: {
  approval: ApprovalWithClient;
  detailUrl: string;
}) {
  const [pending, startTransition] = useTransition();
  const terminal = isTerminal(approval.status);

  return (
    <div className="row-actions">
      <a className="button" href={detailUrl} target="_blank" rel="noopener noreferrer">
        View
      </a>
      {!terminal && (
        <>
          <form
            action={(formData) =>
              startTransition(() => remindApprovalAction(approval.id, formData))
            }
          >
            <button type="submit" disabled={pending}>
              Remind
            </button>
          </form>
          <form
            action={(formData) =>
              startTransition(() => cancelApprovalAction(approval.id, formData))
            }
          >
            <button type="submit" disabled={pending}>
              Cancel
            </button>
          </form>
        </>
      )}
    </div>
  );
}
