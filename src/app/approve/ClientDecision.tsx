"use client";

import { useActionState, useState } from "react";
import {
  approveAction,
  requestChangesAction,
  type DecisionState,
} from "@/app/approve/actions";

const IDLE: DecisionState = { ok: false };

/**
 * The client's two buttons.
 *
 * Both are real form submissions to Server Actions, so they work before
 * hydration and the pending state comes from the framework rather than from
 * local bookkeeping that can drift out of step with the request.
 */
export function ClientDecision({
  credentialKind,
  credential,
}: {
  credentialKind: "token" | "pointer";
  credential: string;
}) {
  const [showChanges, setShowChanges] = useState(false);
  const [approveState, approve, approving] = useActionState(approveAction, IDLE);
  const [changesState, requestChanges, requesting] = useActionState(
    requestChangesAction,
    IDLE,
  );

  if (approveState.ok) {
    return (
      <div className="result">
        <div className="result-mark" aria-hidden="true">
          ✅
        </div>
        <h2 style={{ margin: 0 }}>Approved</h2>
        <p className="muted">
          Thanks — the agency has been told. Nothing else is needed from you.
        </p>
      </div>
    );
  }

  if (changesState.ok) {
    return (
      <div className="result">
        <div className="result-mark" aria-hidden="true">
          ✏️
        </div>
        <h2 style={{ margin: 0 }}>Changes requested</h2>
        <p className="muted">
          Your notes are on their way to the agency. They&apos;ll follow up with
          a new version.
        </p>
      </div>
    );
  }

  const busy = approving || requesting;

  return (
    <div>
      {!showChanges ? (
        <div className="actions">
          <form action={approve}>
            <input type="hidden" name="credentialKind" value={credentialKind} />
            <input type="hidden" name="credential" value={credential} />
            <button type="submit" className="primary" disabled={busy}>
              {approving ? "Approving…" : "Approve"}
            </button>
          </form>
          <button
            type="button"
            onClick={() => setShowChanges(true)}
            disabled={busy}
          >
            Request changes
          </button>
        </div>
      ) : (
        <form action={requestChanges}>
          <input type="hidden" name="credentialKind" value={credentialKind} />
          <input type="hidden" name="credential" value={credential} />
          <label htmlFor="comment" style={{ display: "block", marginTop: 20 }}>
            <strong>What would you like changed?</strong>
          </label>
          <p className="small muted" style={{ margin: "4px 0 10px" }}>
            Be as specific as you like — timestamps help, e.g. &ldquo;at 0:04,
            swap the opening shot&rdquo;.
          </p>
          <textarea
            id="comment"
            name="comment"
            required
            minLength={3}
            maxLength={4000}
            placeholder="Please change the opening shot…"
            disabled={busy}
          />
          <div className="actions">
            <button type="submit" className="primary" disabled={busy}>
              {requesting ? "Sending…" : "Submit changes"}
            </button>
            <button
              type="button"
              onClick={() => setShowChanges(false)}
              disabled={busy}
            >
              Back
            </button>
          </div>
        </form>
      )}

      {approveState.error ? <p className="error">{approveState.error}</p> : null}
      {changesState.error ? <p className="error">{changesState.error}</p> : null}
    </div>
  );
}
