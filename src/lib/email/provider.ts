/**
 * The email port.
 *
 * Everything that sends mail depends on this interface and nothing else, so
 * swapping Resend for SES or Postmark is one new file and one line in the
 * factory.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  /**
   * Stable per logical send. Providers that support it use it to collapse
   * retries; the mock uses it to make duplicate sends visible in tests.
   */
  idempotencyKey?: string;
}

export interface SendResult {
  id: string;
  provider: string;
}

export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<SendResult>;
}

export class EmailDeliveryError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "EmailDeliveryError";
  }
}
