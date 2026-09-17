/**
 * The reminder wording port.
 *
 * Read the shape of `ReminderContext` carefully: it is a value object of
 * already-decided facts. The generator is handed what to say something about
 * and returns one sentence. It is never given the approval row, a database
 * handle, or any way to act.
 *
 * The scheduler decides *whether* a reminder goes out and *when*. This decides
 * only *how it reads*. That separation is the whole reason the interface is
 * this narrow.
 */

export type ReminderTone = "friendly" | "neutral" | "urgent";

export interface ReminderContext {
  agencyName: string;
  clientName: string;
  contactName?: string | null;
  creativeName: string;
  /** 1-based position in the sequence. */
  reminderNumber: number;
  /** Human text, e.g. "2 hours". */
  timeRemaining: string;
  /** Formatted for the agency's timezone. */
  deadline: string;
  tone: ReminderTone;
  isDeadlineWarning: boolean;
}

export interface ReminderMessageGenerator {
  readonly name: string;
  generate(context: ReminderContext): Promise<string>;
}

/** Hard ceiling on anything a generator returns. */
export const MAX_REMINDER_LENGTH = 320;

/**
 * Clean up whatever came back.
 *
 * A generated string goes into an email body and a Slack message, so it is
 * treated as untrusted text: collapse whitespace, drop anything that looks
 * like markup or a link, and cut it to length. Escaping still happens at the
 * render site; this is the belt to that pair of braces.
 */
export function sanitizeReminderMessage(raw: string, fallback: string): string {
  const cleaned = raw
    .replace(/<[^>]*>/g, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length < 10) return fallback;
  if (cleaned.length <= MAX_REMINDER_LENGTH) return cleaned;

  const cut = cleaned.slice(0, MAX_REMINDER_LENGTH);
  const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "));
  return lastStop > 80 ? cut.slice(0, lastStop + 1) : `${cut.trimEnd()}…`;
}

/**
 * The deterministic wording every deployment gets by default.
 *
 * This is not a stub standing in for the real thing — it is the default
 * implementation, and it is what runs unless an Anthropic key is configured.
 * The AI adapter is the optional upgrade, not the other way round.
 */
export class TemplateReminderMessageGenerator
  implements ReminderMessageGenerator
{
  readonly name = "template";

  async generate(context: ReminderContext): Promise<string> {
    return templateReminder(context);
  }
}

export function templateReminder(context: ReminderContext): string {
  const { agencyName, creativeName, timeRemaining, deadline } = context;

  if (context.isDeadlineWarning) {
    return (
      `Quick heads-up: ${creativeName} is still waiting on your approval and ` +
      `the deadline is ${deadline} — about ${timeRemaining} away. ` +
      `${agencyName} needs your go-ahead to keep it on schedule.`
    );
  }

  if (context.reminderNumber <= 1) {
    return (
      `Just a nudge on ${creativeName} — it's waiting for your review, ` +
      `with a deadline of ${deadline} (${timeRemaining} left).`
    );
  }

  return (
    `Following up on ${creativeName}. There's ${timeRemaining} left before ` +
    `the ${deadline} deadline, and ${agencyName} is ready to go as soon as ` +
    `you approve.`
  );
}
