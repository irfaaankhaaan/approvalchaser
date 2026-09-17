import { WebClient } from "@slack/web-api";
import { decryptSecret } from "@/lib/crypto/secretbox";
import type { SlackInstallation } from "@/lib/db/types";

/**
 * The Slack port.
 *
 * Only the four calls this product actually makes. Keeping it this small is
 * what lets the test suite substitute a recording gateway and assert on the
 * exact messages an approval produces, without a network or a workspace.
 */

export interface SlackBlock {
  type: string;
  [key: string]: unknown;
}

export interface PostMessageInput {
  channel: string;
  text: string;
  blocks?: SlackBlock[];
  threadTs?: string;
}

export interface UpdateMessageInput {
  channel: string;
  ts: string;
  text: string;
  blocks?: SlackBlock[];
}

export interface SlackGateway {
  postMessage(input: PostMessageInput): Promise<{ channel: string; ts: string }>;
  updateMessage(input: UpdateMessageInput): Promise<void>;
  postEphemeral(input: {
    channel: string;
    user: string;
    text: string;
    blocks?: SlackBlock[];
  }): Promise<void>;
  openView(triggerId: string, view: Record<string, unknown>): Promise<void>;
  pushView?(triggerId: string, view: Record<string, unknown>): Promise<void>;
}

/** The production adapter. */
export class WebApiSlackGateway implements SlackGateway {
  private client: WebClient;

  constructor(botToken: string) {
    this.client = new WebClient(botToken, { retryConfig: { retries: 2 } });
  }

  async postMessage(input: PostMessageInput) {
    const result = await this.client.chat.postMessage({
      channel: input.channel,
      text: input.text,
      blocks: input.blocks as never,
      ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
    });
    return { channel: String(result.channel), ts: String(result.ts) };
  }

  async updateMessage(input: UpdateMessageInput) {
    await this.client.chat.update({
      channel: input.channel,
      ts: input.ts,
      text: input.text,
      blocks: input.blocks as never,
    });
  }

  async postEphemeral(input: {
    channel: string;
    user: string;
    text: string;
    blocks?: SlackBlock[];
  }) {
    await this.client.chat.postEphemeral({
      channel: input.channel,
      user: input.user,
      text: input.text,
      blocks: input.blocks as never,
    });
  }

  async openView(triggerId: string, view: Record<string, unknown>) {
    await this.client.views.open({ trigger_id: triggerId, view: view as never });
  }

  async pushView(triggerId: string, view: Record<string, unknown>) {
    await this.client.views.push({ trigger_id: triggerId, view: view as never });
  }
}

/**
 * The development and test adapter.
 *
 * It records rather than sends. Unlike the email mock it is not used as a
 * fallback in normal local running — a missing Slack installation is an error
 * you should see, not paper over.
 */
export class RecordingSlackGateway implements SlackGateway {
  readonly posted: (PostMessageInput & { ts: string })[] = [];
  readonly updated: UpdateMessageInput[] = [];
  readonly ephemeral: { channel: string; user: string; text: string }[] = [];
  readonly views: Record<string, unknown>[] = [];
  private counter = 0;

  async postMessage(input: PostMessageInput) {
    this.counter += 1;
    const ts = `${1700000000 + this.counter}.000${this.counter}`;
    this.posted.push({ ...input, ts });
    return { channel: input.channel, ts };
  }

  async updateMessage(input: UpdateMessageInput) {
    this.updated.push(input);
  }

  async postEphemeral(input: { channel: string; user: string; text: string }) {
    this.ephemeral.push(input);
  }

  async openView(_triggerId: string, view: Record<string, unknown>) {
    this.views.push(view);
  }

  async pushView(_triggerId: string, view: Record<string, unknown>) {
    this.views.push(view);
  }

  clear(): void {
    this.posted.length = 0;
    this.updated.length = 0;
    this.ephemeral.length = 0;
    this.views.length = 0;
  }
}

let override: ((installation: SlackInstallation) => SlackGateway) | undefined;

/** Used by tests to intercept gateway construction. */
export function setSlackGatewayFactory(
  factory: ((installation: SlackInstallation) => SlackGateway) | undefined,
): void {
  override = factory;
}

export function gatewayFor(installation: SlackInstallation): SlackGateway {
  if (override) return override(installation);
  return new WebApiSlackGateway(decryptSecret(installation.encrypted_bot_token));
}
