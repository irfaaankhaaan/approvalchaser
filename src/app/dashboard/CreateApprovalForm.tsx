"use client";

import { useActionState, useState, type KeyboardEvent } from "react";
import { createApprovalAction, type FormState } from "@/app/dashboard/actions";
import { REMINDER_PRESETS } from "@/lib/reminders/schedule";

const IDLE: FormState = { ok: false };

/**
 * "New approval", as a modal over the dashboard.
 *
 * The form itself lives in a separate component keyed by `formKey`, which
 * increments every time the modal opens. That forces a fresh mount — a
 * fresh useActionState, a freshly-computed minimum deadline, a wizard back
 * at its first question — rather than reaching for an effect to reset state
 * left over from the last time it was open.
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
        <ApprovalWizard key={formKey} onDone={() => setOpen(false)} />
      </div>
    </div>
  );
}

interface Answers {
  clientName: string;
  clientEmail: string;
  contactName: string;
  creativeName: string;
  creativeUrl: string;
  deadline: string;
  schedulePreset: string;
  notes: string;
}

const EMPTY_ANSWERS: Answers = {
  clientName: "",
  clientEmail: "",
  contactName: "",
  creativeName: "",
  creativeUrl: "",
  deadline: "",
  schedulePreset: REMINDER_PRESETS[0].id,
  notes: "",
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * One question (or one small, obviously-related group of them) per screen,
 * a review before anything sends — closer to being asked about an approval
 * than to filling out its paperwork. `validate` runs when the person tries
 * to move on, not on every keystroke, the way a conversation doesn't
 * interrupt you mid-sentence.
 */
function ApprovalWizard({ onDone }: { onDone: () => void }) {
  const [state, formAction, pending] = useActionState(createApprovalAction, IDLE);
  const [answers, setAnswers] = useState<Answers>(EMPTY_ANSWERS);
  const [step, setStep] = useState(0);
  const [stepError, setStepError] = useState<string | null>(null);

  // Computed once, on this fresh mount — a datetime-local input has no
  // timezone, so its value is the browser's own local wall-clock time, and
  // the minimum offered has to be read off that same clock to agree with it.
  const [minDeadline] = useState(() => {
    const now = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000);
    return now.toISOString().slice(0, 16);
  });

  // Clears any validation message the moment you start correcting it,
  // rather than leaving a stale "pick a time in the future" sitting there
  // while you're already typing a fixed answer.
  const set = <K extends keyof Answers>(key: K, value: Answers[K]) => {
    setAnswers((prev) => ({ ...prev, [key]: value }));
    setStepError(null);
  };

  const steps: {
    id: string;
    validate?: () => string | null;
    render: () => React.ReactNode;
  }[] = [
    {
      id: "client",
      validate: () => {
        if (!answers.clientName.trim()) return "Who's the client?";
        if (!EMAIL_PATTERN.test(answers.clientEmail.trim())) {
          return "Enter a valid email address.";
        }
        return null;
      },
      render: () => (
        <>
          <Question>Who&rsquo;s this for?</Question>
          <label htmlFor="w-clientName">Client</label>
          <input
            type="text"
            id="w-clientName"
            autoFocus
            maxLength={120}
            placeholder="ABC Clothing"
            value={answers.clientName}
            onChange={(e) => set("clientName", e.target.value)}
            onKeyDown={onEnter(() => document.getElementById("w-clientEmail")?.focus())}
          />
          <label htmlFor="w-clientEmail">Their email</label>
          <input
            type="email"
            id="w-clientEmail"
            placeholder="sarah@example.com"
            value={answers.clientEmail}
            onChange={(e) => set("clientEmail", e.target.value)}
            onKeyDown={onEnter(() => next())}
          />
          <label htmlFor="w-contactName">Contact name (optional)</label>
          <input
            type="text"
            id="w-contactName"
            maxLength={80}
            placeholder="Sarah"
            value={answers.contactName}
            onChange={(e) => set("contactName", e.target.value)}
            onKeyDown={onEnter(() => next())}
          />
        </>
      ),
    },
    {
      id: "creative",
      validate: () => (answers.creativeName.trim() ? null : "What are they approving?"),
      render: () => (
        <>
          <Question>What are you getting approved?</Question>
          <label htmlFor="w-creativeName">Creative</label>
          <input
            type="text"
            id="w-creativeName"
            autoFocus
            maxLength={200}
            placeholder="Instagram Reel #14"
            value={answers.creativeName}
            onChange={(e) => set("creativeName", e.target.value)}
            onKeyDown={onEnter(() => document.getElementById("w-creativeUrl")?.focus())}
          />
          <label htmlFor="w-creativeUrl">Link to it (optional)</label>
          <input
            type="url"
            id="w-creativeUrl"
            placeholder="https://example.com/reel14"
            value={answers.creativeUrl}
            onChange={(e) => set("creativeUrl", e.target.value)}
            onKeyDown={onEnter(() => next())}
          />
        </>
      ),
    },
    {
      id: "deadline",
      validate: () => {
        if (!answers.deadline) return "When do you need an answer by?";
        if (new Date(answers.deadline).getTime() <= Date.now()) {
          return "Pick a time in the future.";
        }
        return null;
      },
      render: () => (
        <>
          <Question>When do you need their answer?</Question>
          <label htmlFor="w-deadline">Deadline</label>
          <input
            type="datetime-local"
            id="w-deadline"
            autoFocus
            min={minDeadline}
            value={answers.deadline}
            onChange={(e) => set("deadline", e.target.value)}
          />
        </>
      ),
    },
    {
      id: "reminders",
      render: () => (
        <>
          <Question>How should I chase it if they go quiet?</Question>
          <label htmlFor="w-schedulePreset">Reminders</label>
          <select
            id="w-schedulePreset"
            autoFocus
            value={answers.schedulePreset}
            onChange={(e) => set("schedulePreset", e.target.value)}
          >
            {REMINDER_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label}
              </option>
            ))}
          </select>
          <p className="field-hint">The default works well for most approvals.</p>
        </>
      ),
    },
    {
      id: "notes",
      render: () => (
        <>
          <Question>Anything you want to tell them?</Question>
          <label htmlFor="w-notes">Notes for the client (optional)</label>
          <textarea
            id="w-notes"
            autoFocus
            maxLength={1000}
            style={{ minHeight: 90 }}
            placeholder="Focus on the first three seconds…"
            value={answers.notes}
            onChange={(e) => set("notes", e.target.value)}
          />
        </>
      ),
    },
  ];

  const atReview = step === steps.length;

  function onEnter(action: () => void) {
    return (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        action();
      }
    };
  }

  function next() {
    const current = steps[step];
    const error = current?.validate?.() ?? null;
    if (error) {
      setStepError(error);
      return;
    }
    setStepError(null);
    setStep((s) => s + 1);
  }

  function back() {
    setStepError(null);
    setStep((s) => Math.max(0, s - 1));
  }

  function skip() {
    setStepError(null);
    setStep((s) => s + 1);
  }

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

  if (atReview) {
    const preset = REMINDER_PRESETS.find((p) => p.id === answers.schedulePreset);
    return (
      <>
        <p className="eyebrow" style={{ margin: "0 0 4px" }}>
          Review
        </p>
        <h2 style={{ marginTop: 0 }}>Ready to send?</h2>

        <dl className="meta">
          <ReviewRow label="Client" value={`${answers.clientName} · ${answers.clientEmail}`} onEdit={() => setStep(0)} />
          <ReviewRow
            label="Creative"
            value={answers.creativeName}
            onEdit={() => setStep(1)}
          />
          <ReviewRow
            label="Deadline"
            value={new Date(answers.deadline).toLocaleString(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            })}
            onEdit={() => setStep(2)}
          />
          <ReviewRow label="Reminders" value={preset?.label ?? ""} onEdit={() => setStep(3)} />
          {answers.notes ? (
            <ReviewRow label="Notes" value={answers.notes} onEdit={() => setStep(4)} />
          ) : null}
        </dl>

        <form action={formAction}>
          <input type="hidden" name="clientName" value={answers.clientName} />
          <input type="hidden" name="clientEmail" value={answers.clientEmail} />
          <input type="hidden" name="contactName" value={answers.contactName} />
          <input type="hidden" name="creativeName" value={answers.creativeName} />
          <input type="hidden" name="creativeUrl" value={answers.creativeUrl} />
          <input type="hidden" name="deadline" value={answers.deadline} />
          <input type="hidden" name="schedulePreset" value={answers.schedulePreset} />
          <input type="hidden" name="notes" value={answers.notes} />

          {state.error ? <p className="error">{state.error}</p> : null}

          <div className="actions">
            <button type="submit" className="primary" disabled={pending}>
              {pending ? "Sending…" : "Send to client"}
            </button>
            <button type="button" onClick={back} disabled={pending}>
              Back
            </button>
            <button type="button" onClick={onDone} disabled={pending}>
              Cancel
            </button>
          </div>
        </form>
      </>
    );
  }

  const current = steps[step]!;
  const isOptional = !current.validate;

  return (
    <>
      <p className="small muted" style={{ margin: "0 0 4px" }}>
        Step {step + 1} of {steps.length + 1}
      </p>
      {current.render()}

      {stepError ? <p className="error">{stepError}</p> : null}

      <div className="actions">
        <button type="button" className="primary" onClick={next}>
          {step === steps.length - 1 ? "Review" : "Next"}
        </button>
        {isOptional && (
          <button type="button" onClick={skip}>
            Skip
          </button>
        )}
        {step > 0 && (
          <button type="button" onClick={back}>
            Back
          </button>
        )}
        <button type="button" onClick={onDone}>
          Cancel
        </button>
      </div>
    </>
  );
}

function Question({ children }: { children: React.ReactNode }) {
  return <h2 style={{ marginTop: 0, marginBottom: 16 }}>{children}</h2>;
}

function ReviewRow({
  label,
  value,
  onEdit,
}: {
  label: string;
  value: string;
  onEdit: () => void;
}) {
  return (
    <div className="meta-row">
      <dt>{label}</dt>
      <dd>
        {value}{" "}
        <button
          type="button"
          onClick={onEdit}
          className="small"
          style={{ padding: "0 0 0 6px", border: "none", background: "none", textDecoration: "underline" }}
        >
          Edit
        </button>
      </dd>
    </div>
  );
}
