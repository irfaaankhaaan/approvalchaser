import Anthropic from "@anthropic-ai/sdk";
import { env } from "@/lib/env";
import {
  MAX_REMINDER_LENGTH,
  sanitizeReminderMessage,
  templateReminder,
  type ReminderContext,
  type ReminderMessageGenerator,
} from "@/lib/ai/generator";

/**
 * The optional wording upgrade.
 *
 * Note what this class does not do: it has no database access, it returns a
 * string and nothing else, and every failure path — timeout, API error, an
 * empty or nonsense reply — returns the deterministic template. A reminder is
 * never delayed or skipped because a model was slow.
 */
export class AnthropicReminderMessageGenerator
  implements ReminderMessageGenerator
{
  readonly name = "anthropic";
  private client: Anthropic;

  constructor(
    apiKey: string = env.anthropicApiKey ?? "",
    private readonly model = process.env.ANTHROPIC_MODEL?.trim() ||
      "claude-haiku-4-5-20251001",
    private readonly timeoutMs = 8_000,
  ) {
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY is required for the Anthropic generator");
    }
    this.client = new Anthropic({ apiKey, timeout: this.timeoutMs, maxRetries: 1 });
  }

  async generate(context: ReminderContext): Promise<string> {
    const fallback = templateReminder(context);

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 200,
        system:
          "You write one short reminder sentence (two at most) chasing a " +
          "creative approval on behalf of an agency. Plain text only: no " +
          "greeting, no sign-off, no links, no markdown, no subject line. " +
          "Be warm and direct. Never invent facts beyond those given, and " +
          "never state or imply the approval's status has changed.",
        messages: [
          {
            role: "user",
            content: [
              `Agency: ${context.agencyName}`,
              `Client company: ${context.clientName}`,
              `Contact first name: ${context.contactName ?? "unknown"}`,
              `Creative: ${context.creativeName}`,
              `Reminder number: ${context.reminderNumber}`,
              `Time remaining: ${context.timeRemaining}`,
              `Deadline: ${context.deadline}`,
              `Tone: ${context.tone}`,
              `This is the final warning before the deadline: ${context.isDeadlineWarning}`,
              "",
              `Write the reminder in under ${MAX_REMINDER_LENGTH} characters.`,
            ].join("\n"),
          },
        ],
      });

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join(" ");

      return sanitizeReminderMessage(text, fallback);
    } catch (error) {
      console.warn(
        "[ai] reminder wording fell back to the template:",
        error instanceof Error ? error.message : error,
      );
      return fallback;
    }
  }
}
