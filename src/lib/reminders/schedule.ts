import type { ReminderKind } from "@/lib/db/types";

/**
 * Reminder planning.
 *
 * This file is pure arithmetic on purpose. Given a deadline and a set of
 * offsets it returns exactly which reminders should exist and when they fire,
 * with no database, no clock of its own and no room for an AI to have an
 * opinion. Everything downstream — scheduling, rescheduling, cancelling — is
 * a diff against this function's output.
 */

export const DEFAULT_OFFSETS_MINUTES = [720, 240, 120] as const; // 12h, 4h, 2h

export interface PlannedReminder {
  /** 1-based position in the sequence, stable across reschedules. */
  reminderNumber: number;
  kind: ReminderKind;
  scheduledFor: Date;
  /** Minutes before the deadline this reminder represents. */
  offsetMinutes: number;
  /**
   * True when the moment has already passed at planning time. These are
   * recorded as "skipped" rather than fired, so that creating an approval an
   * hour before its deadline does not dispatch three emails at once.
   */
  alreadyPast: boolean;
}

/** Offsets, cleaned up: positive whole minutes, descending, no duplicates. */
export function normalizeOffsets(offsets: readonly number[]): number[] {
  const seen = new Set<number>();
  const clean: number[] = [];
  for (const raw of offsets) {
    const minutes = Math.floor(Number(raw));
    if (!Number.isFinite(minutes) || minutes <= 0) continue;
    // A year out is not a schedule, it is a typo.
    if (minutes > 60 * 24 * 365) continue;
    if (seen.has(minutes)) continue;
    seen.add(minutes);
    clean.push(minutes);
  }
  return clean.sort((a, b) => b - a);
}

/**
 * The full sequence for one approval cycle.
 *
 * The earliest offsets are ordinary reminders; the final one is the deadline
 * warning, because that is the message that says "this is about to be late"
 * rather than "here is a nudge".
 */
export function planReminders(input: {
  deadline: Date;
  offsetsMinutes?: readonly number[];
  now?: Date;
}): PlannedReminder[] {
  const now = input.now ?? new Date();
  const offsets = normalizeOffsets(
    input.offsetsMinutes ?? DEFAULT_OFFSETS_MINUTES,
  );
  const deadlineMs = input.deadline.getTime();

  return offsets.map((offsetMinutes, index) => {
    const scheduledFor = new Date(deadlineMs - offsetMinutes * 60_000);
    return {
      reminderNumber: index + 1,
      kind: index === offsets.length - 1 ? "deadline_warning" : "reminder",
      offsetMinutes,
      scheduledFor,
      alreadyPast: scheduledFor.getTime() <= now.getTime(),
    };
  });
}

/**
 * Parse a human schedule such as "12h, 4h, 2h" or "1d, 12 hours, 90m" into
 * minutes. A bare number is read as minutes. Used by the HTTP API and the
 * admin page; the Slack modal uses a fixed set of presets instead, so there
 * is nothing to mistype there.
 */
export function parseOffsets(input: string): number[] {
  const units: Record<string, number> = {
    m: 1, min: 1, mins: 1, minute: 1, minutes: 1,
    h: 60, hr: 60, hrs: 60, hour: 60, hours: 60,
    d: 1440, day: 1440, days: 1440,
  };

  const parsed: number[] = [];
  for (const piece of input.split(/[,;\n]+/)) {
    const match = piece.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([a-z]*)$/);
    if (!match) continue;
    const [, amount, unit] = match;
    const multiplier = unit ? units[unit] : 1;
    if (multiplier === undefined) continue;
    parsed.push(Math.round(Number(amount) * multiplier));
  }
  return normalizeOffsets(parsed);
}

/** The presets offered in the Slack modal. */
export const REMINDER_PRESETS = [
  { id: "12h_4h_2h", label: "12h, 4h and 2h before deadline", offsets: [720, 240, 120] },
  { id: "24h_4h", label: "24h and 4h before deadline", offsets: [1440, 240] },
  { id: "48h_24h_4h", label: "48h, 24h and 4h before deadline", offsets: [2880, 1440, 240] },
  { id: "2h", label: "2h before deadline only", offsets: [120] },
  { id: "none", label: "No reminders", offsets: [] },
] as const;

export function presetOffsets(id: string): number[] {
  const preset = REMINDER_PRESETS.find((p) => p.id === id);
  return preset ? [...preset.offsets] : [...DEFAULT_OFFSETS_MINUTES];
}
