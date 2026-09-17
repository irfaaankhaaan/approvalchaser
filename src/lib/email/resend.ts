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

  constructor(apiKey: string = env.resendApiKey ?? "") {
    if (!apiKey) throw new Error("RESEND_API_KEY is required for ResendEmailProvider");
    this.client = new Resend(apiKey);
  }

  async send(message: EmailMessage): Promise<SendResult> {
    const { data, error } = await this.client.emails.send({
      from: env.emailFrom,
      to: [message.to],
      subject: message.subject,
      html: message.html,
      text: message.text,
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      ...(message.idempotencyKey
        ? { headers: { "X-Entity-Ref-ID": message.idempotencyKey } }
        : {}),
    });

    if (error) {
      throw new EmailDeliveryError(
        `Resend rejected the message: ${error.message}`,
        error,
      );
    }
    return { id: data?.id ?? "unknown", provider: this.name };
  }
}
