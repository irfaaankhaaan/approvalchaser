import { describe, expect, it } from "vitest";
import {
  DEFAULT_OFFSETS_MINUTES,
  REMINDER_PRESETS,
  normalizeOffsets,
  parseOffsets,
  planReminders,
  presetOffsets,
} from "@/lib/reminders/schedule";

const HOUR = 3_600_000;

describe("offset normalisation", () => {
  it("sorts descending, so reminder 1 is always the earliest", () => {
    expect(normalizeOffsets([120, 720, 240])).toEqual([720, 240, 120]);
  });

  it("drops duplicates, zero, negatives and nonsense", () => {
    expect(normalizeOffsets([720, 720, 0, -5, NaN, 240])).toEqual([720, 240]);
  });

  it("drops absurdly distant offsets", () => {
    expect(normalizeOffsets([60 * 24 * 400])).toEqual([]);
  });

  it("floors fractional minutes", () => {
    expect(normalizeOffsets([90.7])).toEqual([90]);
  });
});

describe("planReminders", () => {
  const now = new Date("2026-09-17T00:00:00Z");

  it("puts one reminder at each offset before the deadline", () => {
    const deadline = new Date("2026-09-18T16:00:00Z");
    const plan = planReminders({
      deadline,
      offsetsMinutes: [720, 240, 120],
      now,
    });

    expect(plan).toHaveLength(3);
    expect(plan[0]!.scheduledFor.toISOString()).toBe("2026-09-18T04:00:00.000Z");
    expect(plan[1]!.scheduledFor.toISOString()).toBe("2026-09-18T12:00:00.000Z");
    expect(plan[2]!.scheduledFor.toISOString()).toBe("2026-09-18T14:00:00.000Z");
  });

  it("numbers the sequence from 1, earliest first", () => {
    const plan = planReminders({
      deadline: new Date(now.getTime() + 48 * HOUR),
      now,
    });
    expect(plan.map((r) => r.reminderNumber)).toEqual([1, 2, 3]);
    expect(plan.map((r) => r.offsetMinutes)).toEqual([...DEFAULT_OFFSETS_MINUTES]);
  });

  it("marks only the last one as the deadline warning", () => {
    const plan = planReminders({
      deadline: new Date(now.getTime() + 48 * HOUR),
      now,
    });
    expect(plan.map((r) => r.kind)).toEqual([
      "reminder",
      "reminder",
      "deadline_warning",
    ]);
  });

  it("marks offsets that are already in the past rather than firing them", () => {
    // Deadline in three hours: the 12h and 4h nudges are behind us.
    const plan = planReminders({
      deadline: new Date(now.getTime() + 3 * HOUR),
      offsetsMinutes: [720, 240, 120],
      now,
    });
    expect(plan.map((r) => r.alreadyPast)).toEqual([true, true, false]);
  });

  it("returns nothing when reminders are switched off", () => {
    expect(
      planReminders({ deadline: new Date(now.getTime() + 48 * HOUR), offsetsMinutes: [], now }),
    ).toEqual([]);
  });

  it("is deterministic — the same inputs give the same plan", () => {
    const input = {
      deadline: new Date(now.getTime() + 30 * HOUR),
      offsetsMinutes: [720, 240, 120],
      now,
    };
    expect(planReminders(input)).toEqual(planReminders(input));
  });

  it("gives a single-offset schedule one deadline warning and nothing else", () => {
    const plan = planReminders({
      deadline: new Date(now.getTime() + 48 * HOUR),
      offsetsMinutes: [120],
      now,
    });
    expect(plan).toHaveLength(1);
    expect(plan[0]!.kind).toBe("deadline_warning");
  });
});

describe("parseOffsets", () => {
  it("reads the shapes a human types", () => {
    expect(parseOffsets("12h, 4h, 2h")).toEqual([720, 240, 120]);
    expect(parseOffsets("1 day, 12 hours, 90m")).toEqual([1440, 720, 90]);
    expect(parseOffsets("720,240")).toEqual([720, 240]);
  });

  it("ignores pieces it cannot read instead of failing the whole line", () => {
    expect(parseOffsets("12h, soon, 2h")).toEqual([720, 120]);
    expect(parseOffsets("")).toEqual([]);
    expect(parseOffsets("12 fortnights")).toEqual([]);
  });
});

describe("presets", () => {
  it("resolves every preset id", () => {
    for (const preset of REMINDER_PRESETS) {
      expect(presetOffsets(preset.id)).toEqual([...preset.offsets]);
    }
  });

  it("falls back to the default for an unknown id", () => {
    expect(presetOffsets("nope")).toEqual([...DEFAULT_OFFSETS_MINUTES]);
  });
});
