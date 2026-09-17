import { Resend } from "resend";
import { env } from "@/lib/env";
import {
  EmailDeliveryError,
  type EmailMessage,
  type EmailProvider,
  type SendResult,
} from "@/lib/email/provider";

/** The production adapter. */
export class ResendEmailProvider implements EmailProvider {
  readonly name = "resend";
  private client: Resend;

  /**
   * `client` is a testing seam: pass a fake with the same shape as
   * `Resend.emails.send` to assert on exactly what this class sends, without
   * a live API key or a network call. Production code never passes it.
   */
  constructor(apiKey: string = env.resendApiKey ?? "", client?: Resend) {
    if (client) {
      this.client = client;
      return;
    }
    if (!apiKey) throw new Error("RESEND_API_KEY is required for ResendEmailProvider");
    this.client = new Resend(apiKey);
  }

  async send(message: EmailMessage): Promise<SendResult> {
    // idempotencyKey is Resend's real deduplication mechanism — it becomes
    // the `Idempotency-Key` header the API actually enforces. It goes in the
    // second (request options) argument, not a custom header on the payload,
    // which Resend would accept but never act on.
    const { data, error } = await this.client.emails.send(
      {
        from: env.emailFrom,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      },
      message.idempotencyKey ? { idempotencyKey: message.idempotencyKey } : undefined,
    );

    if (error) {
      throw new EmailDeliveryError(
        `Resend rejected the message: ${error.message}`,
        error,
      );
    }
    return { id: data?.id ?? "unknown", provider: this.name };
  }
}
