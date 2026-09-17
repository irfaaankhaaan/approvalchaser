import { env } from "@/lib/env";
import { AnthropicReminderMessageGenerator } from "@/lib/ai/anthropic";
import {
  TemplateReminderMessageGenerator,
  type ReminderMessageGenerator,
} from "@/lib/ai/generator";

let override: ReminderMessageGenerator | undefined;
let cached: ReminderMessageGenerator | undefined;

export function setReminderMessageGenerator(
  generator: ReminderMessageGenerator | undefined,
): void {
  override = generator;
  cached = undefined;
}

/**
 * No key configured means the deterministic template, which is a complete
 * implementation rather than a degraded one. Nothing about the product stops
 * working without an Anthropic key.
 */
export function getReminderMessageGenerator(): ReminderMessageGenerator {
  if (override) return override;
  if (cached) return cached;

  cached = env.anthropicApiKey
    ? new AnthropicReminderMessageGenerator(env.anthropicApiKey)
    : new TemplateReminderMessageGenerator();
  return cached;
}

export * from "@/lib/ai/generator";
export { AnthropicReminderMessageGenerator } from "@/lib/ai/anthropic";
