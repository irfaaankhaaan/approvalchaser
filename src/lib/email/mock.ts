import { randomUUID } from "node:crypto";
import type {
  EmailMessage,
  EmailProvider,
  SendResult,
} from "@/lib/email/provider";

/**
 * The development adapter.
 *
 * It does not pretend to deliver anything. It keeps every message in an
 * outbox the tests assert against, and prints the subject plus any link in
 * the body so that a local run is actually usable: you copy the approval URL
 * out of the terminal and open it.
 */
export class MockEmailProvider implements EmailProvider {
  readonly name = "mock";
  readonly outbox: (EmailMessage & { id: string; sentAt: Date })[] = [];

  constructor(private readonly log = true) {}

  async send(message: EmailMessage): Promise<SendResult> {
    const id = randomUUID();
    this.outbox.push({ ...message, id, sentAt: new Date() });

    if (this.log) {
      const link = message.text.match(/https?:\/\/\S+/)?.[0];
      console.info(
        `[email:mock] to=${message.to} subject=${JSON.stringify(message.subject)}` +
          (link ? `\n[email:mock] link: ${link}` : ""),
      );
    }
    return { id, provider: this.name };
  }

  /** Test helper. */
  messagesTo(address: string): EmailMessage[] {
    return this.outbox.filter(
      (m) => m.to.toLowerCase() === address.toLowerCase(),
    );
  }

  clear(): void {
    this.outbox.length = 0;
  }
}
