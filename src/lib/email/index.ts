import { env } from "@/lib/env";
import { MockEmailProvider } from "@/lib/email/mock";
import type { EmailProvider } from "@/lib/email/provider";
import { ResendEmailProvider } from "@/lib/email/resend";

let override: EmailProvider | undefined;
let cached: EmailProvider | undefined;

/** Used by tests and scripts to inject a provider. */
export function setEmailProvider(provider: EmailProvider | undefined): void {
  override = provider;
  cached = undefined;
}

/**
 * Pick the adapter.
 *
 * Production with no API key is a hard failure rather than a silent downgrade
 * to the mock: an agency whose reminders quietly stopped reaching clients is
 * the exact problem this product exists to solve.
 */
export function getEmailProvider(): EmailProvider {
  if (override) return override;
  if (cached) return cached;

  if (env.resendApiKey) {
    cached = new ResendEmailProvider(env.resendApiKey);
  } else if (env.isProduction) {
    throw new Error(
      "RESEND_API_KEY is not set. Refusing to start in production with the " +
        "mock email provider — client emails would never be delivered.",
    );
  } else {
    console.warn(
      "[email] RESEND_API_KEY is not set. Using MockEmailProvider: messages " +
        "are printed to this terminal, not delivered.",
    );
    cached = new MockEmailProvider();
  }
  return cached;
}

export * from "@/lib/email/provider";
export { MockEmailProvider } from "@/lib/email/mock";
export { ResendEmailProvider } from "@/lib/email/resend";
