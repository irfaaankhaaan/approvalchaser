import { describe, expect, it } from "vitest";
import {
  MAX_REMINDER_LENGTH,
  TemplateReminderMessageGenerator,
  sanitizeReminderMessage,
  templateReminder,
  type ReminderContext,
} from "@/lib/ai/generator";
import { getReminderMessageGenerator } from "@/lib/ai";

const context: ReminderContext = {
  agencyName: "Northlight Studio",
  clientName: "ABC Clothing",
  contactName: "Sarah",
  creativeName: "Instagram Reel #14",
  reminderNumber: 1,
  timeRemaining: "12 hours",
  deadline: "September 18, 4:00 PM",
  tone: "friendly",
  isDeadlineWarning: false,
};

describe("the wording layer", () => {
  it("defaults to the deterministic generator when no key is configured", () => {
    expect(getReminderMessageGenerator().name).toBe("template");
  });

  it("produces a message that names the creative and the deadline", async () => {
    const message = await new TemplateReminderMessageGenerator().generate(context);
    expect(message).toContain("Instagram Reel #14");
    expect(message).toContain("September 18, 4:00 PM");
  });

  it("is deterministic", () => {
    expect(templateReminder(context)).toBe(templateReminder(context));
  });

  it("escalates its wording for the deadline warning", () => {
    const warning = templateReminder({ ...context, isDeadlineWarning: true });
    expect(warning).not.toBe(templateReminder(context));
    expect(warning.toLowerCase()).toContain("deadline");
  });

  it("varies between a first nudge and a later one", () => {
    expect(templateReminder({ ...context, reminderNumber: 3 })).not.toBe(
      templateReminder(context),
    );
  });
});

describe("sanitizing generated wording", () => {
  const fallback = "Fallback reminder text that is definitely long enough.";

  it("keeps ordinary prose untouched apart from whitespace", () => {
    expect(sanitizeReminderMessage("  Just a nudge on   the reel.  ", fallback)).toBe(
      "Just a nudge on the reel.",
    );
  });

  it("strips markup, so generated text cannot inject HTML downstream", () => {
    const dirty = '<img src=x onerror="alert(1)">Please approve the reel today.';
    const clean = sanitizeReminderMessage(dirty, fallback);
    expect(clean).not.toContain("<");
    expect(clean).not.toContain("onerror");
    expect(clean).toContain("Please approve the reel today.");
  });

  it("strips links, so the only URL in an email is the real approval link", () => {
    const clean = sanitizeReminderMessage(
      "Please approve at https://evil.example.com/phish right away.",
      fallback,
    );
    expect(clean).not.toContain("http");
    expect(clean).not.toContain("evil.example.com");
  });

  it("falls back when the model returns nothing usable", () => {
    expect(sanitizeReminderMessage("", fallback)).toBe(fallback);
    expect(sanitizeReminderMessage("   ", fallback)).toBe(fallback);
    expect(sanitizeReminderMessage("ok", fallback)).toBe(fallback);
    expect(sanitizeReminderMessage("<p></p>", fallback)).toBe(fallback);
  });

  it("truncates an over-long reply", () => {
    const long = "This is a sentence about the approval. ".repeat(40);
    const clean = sanitizeReminderMessage(long, fallback);
    expect(clean.length).toBeLessThanOrEqual(MAX_REMINDER_LENGTH + 1);
  });

  it("keeps a message that is exactly at the limit", () => {
    const exact = "a".repeat(MAX_REMINDER_LENGTH);
    expect(sanitizeReminderMessage(exact, fallback)).toBe(exact);
  });
});
