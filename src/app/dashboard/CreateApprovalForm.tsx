"use client";

import { useActionState, useState } from "react";
import { createApprovalAction, type FormState } from "@/app/dashboard/actions";
import { REMINDER_PRESETS } from "@/lib/reminders/schedule";

const IDLE: FormState = { ok: false };

/**
 * "New approval", as a modal over the dashboard.
 *
 * The web equivalent of the Slack create modal — same fields, same
 * defaults, same createApproval() underneath.
 *
 * The form itself lives in a separate component keyed by `formKey`, which
 * increments every time the modal opens. That forces a fresh mount — a
 * fresh useActionState, a freshly-computed minimum deadline — rather than
 * reaching for an effect to reset state left over from the last time it was
 * open. On success it shows a result view in place of the form (the same
 * pattern the client approval page uses) instead of an effect trying to
 * force the modal closed from outside.
 */
export function CreateApprovalForm() {
  const [open, setOpen] = useState(false);
  const [formKey, setFormKey] = useState(0);

  if (!open) {
    return (
      <button
        type="button"
        className="button-primary"
        onClick={() => {
          setFormKey((key) => key + 1);
          setOpen(true);
        }}
      >
        New approval
      </button>
    );
  }

  return (
    <div className="modal-backdrop" onClick={() => setOpen(false)}>
      <div className="modal-card" onClick={(event) => event.stopPropagation()}>
        <NewApprovalForm key={formKey} onDone={() => setOpen(false)} />
      </div>
    </div>
  );
}

function NewApprovalForm({ onDone }: { onDone: () => void }) {
  const [state, formAction, pending] = useActionState(createApprovalAction, IDLE);

  // Computed once, on this fresh mount — a datetime-local input has no
  // timezone, so its value is the browser's own local wall-clock time, and
  // the minimum offered has to be read off that same clock to agree with it.
  const [minDeadline] = useState(() => {
    const now = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000);
    return now.toISOString().slice(0, 16);
  });

  if (state.ok) {
    return (
      <div className="result">
        <div className="result-mark" aria-hidden="true">
          ✅
        </div>
        <h2 style={{ margin: 0 }}>Sent</h2>
        <p className="muted">The client has been emailed. It now shows up in the list.</p>
        <div className="actions">
          <button type="button" className="primary" onClick={onDone}>
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <h2 style={{ marginTop: 0 }}>New approval</h2>
      <form action={formAction}>
        <div className="form-grid">
          <div>
            <label htmlFor="clientName">Client</label>
            <input
              type="text"
              id="clientName"
              name="clientName"
              required
              maxLength={120}
              placeholder="ABC Clothing"
            />
          </div>
          <div>
            <label htmlFor="clientEmail">Client email</label>
            <input
              type="email"
              id="clientEmail"
              name="clientEmail"
              required
              placeholder="sarah@example.com"
            />
          </div>
        </div>

        <label htmlFor="contactName">Contact name (optional)</label>
        <input type="text" id="contactName" name="contactName" maxLength={80} placeholder="Sarah" />

        <label htmlFor="creativeName">Creative</label>
        <input
          type="text"
          id="creativeName"
          name="creativeName"
          required
          maxLength={200}
          placeholder="Instagram Reel #14"
        />

        <label htmlFor="creativeUrl">Creative URL (optional)</label>
        <input
          type="url"
          id="creativeUrl"
          name="creativeUrl"
          placeholder="https://example.com/reel14"
        />

        <div className="form-grid">
          <div>
            <label htmlFor="deadline">Deadline</label>
            <input type="datetime-local" id="deadline" name="deadline" required min={minDeadline} />
          </div>
          <div>
            <label htmlFor="schedulePreset">Reminders</label>
            <select id="schedulePreset" name="schedulePreset" defaultValue={REMINDER_PRESETS[0].id}>
              {REMINDER_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <label htmlFor="notes">Notes for the client (optional)</label>
        <textarea
          id="notes"
          name="notes"
          maxLength={1000}
          style={{ minHeight: 80 }}
          placeholder="Focus on the first three seconds…"
        />

        {state.error ? <p className="error">{state.error}</p> : null}

        <div className="actions">
          <button type="submit" className="primary" disabled={pending}>
            {pending ? "Sending…" : "Send to client"}
          </button>
          <button type="button" onClick={onDone} disabled={pending}>
            Cancel
          </button>
        </div>
      </form>
    </>
  );
}
