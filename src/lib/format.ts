/** Shared formatting. Dates are stored in UTC and displayed in the agency's timezone. */

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape before interpolating anything user-supplied into an email body. */
export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!);
}

function formatter(timezone: string, options: Intl.DateTimeFormatOptions) {
  try {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: timezone });
  } catch {
    // An unknown timezone string should not take a reminder down with it.
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" });
  }
}

/** "September 18, 4:00 PM" */
export function formatDeadline(date: Date, timezone = "UTC"): string {
  return formatter(timezone, {
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

/** "September 18, 2026 at 4:00 PM GMT+1" — for the client page, which has no other context. */
export function formatDeadlineLong(date: Date, timezone = "UTC"): string {
  return formatter(timezone, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

/** "Today 4:00 PM", "Tomorrow 11:00 AM", otherwise the full date. */
export function formatDeadlineRelative(
  date: Date,
  timezone = "UTC",
  now = new Date(),
): string {
  const day = (d: Date) =>
    formatter(timezone, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);

  const time = formatter(timezone, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);

  const tomorrow = new Date(now.getTime() + 86_400_000);
  if (day(date) === day(now)) return `Today ${time}`;
  if (day(date) === day(tomorrow)) return `Tomorrow ${time}`;
  return formatDeadline(date, timezone);
}

/** "2 hours", "45 minutes", "3 days". Rounded down, never negative. */
export function humanDuration(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 60_000));
  if (total < 60) return `${total} minute${total === 1 ? "" : "s"}`;

  const hours = Math.floor(total / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;

  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

/** "in 2 hours" / "2 hours ago". */
export function timeUntil(target: Date, now = new Date()): string {
  const delta = target.getTime() - now.getTime();
  return delta >= 0
    ? `in ${humanDuration(delta)}`
    : `${humanDuration(-delta)} ago`;
}

/**
 * Only http(s) links are ever rendered or emailed.
 *
 * Creative URLs come from a Slack modal, which means they come from a human
 * who could paste "javascript:..." — which would become a live XSS the moment
 * it is placed in an href. Anything that is not a plain web URL is dropped.
 */
export function safeExternalUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}
