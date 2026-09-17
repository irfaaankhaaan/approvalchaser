/**
 * Environment configuration.
 *
 * Values are read lazily rather than at import time: a unit test that only
 * exercises the state machine should not have to set a Slack signing secret,
 * and a missing variable should fail at the point of use with a message that
 * names it.
 */

function read(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : undefined;
}

export function required(name: string): string {
  const value = read(name);
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. See .env.example.`,
    );
  }
  return value;
}

export function optional(name: string): string | undefined {
  return read(name);
}

export const env = {
  get databaseUrl() {
    return read("DATABASE_URL");
  },
  /** Public origin, used to build approval links. No trailing slash. */
  get appUrl() {
    return (read("APP_URL") ?? "http://localhost:3000").replace(/\/+$/, "");
  },
  get slackSigningSecret() {
    return required("SLACK_SIGNING_SECRET");
  },
  get slackClientId() {
    return required("SLACK_CLIENT_ID");
  },
  get slackClientSecret() {
    return required("SLACK_CLIENT_SECRET");
  },
  get slackStateSecret() {
    return required("SLACK_STATE_SECRET");
  },
  /** Base64 of 32 random bytes. Encrypts Slack bot tokens at rest. */
  get tokenEncryptionKey() {
    return required("TOKEN_ENCRYPTION_KEY");
  },
  get resendApiKey() {
    return read("RESEND_API_KEY");
  },
  get emailFrom() {
    return read("EMAIL_FROM") ?? "Approval Chaser <onboarding@resend.dev>";
  },
  get anthropicApiKey() {
    return read("ANTHROPIC_API_KEY");
  },
  get cronSecret() {
    return required("CRON_SECRET");
  },
  /** How long a client approval link stays usable. */
  get approvalTokenTtlDays() {
    const raw = Number(read("APPROVAL_TOKEN_TTL_DAYS") ?? "30");
    return Number.isFinite(raw) && raw > 0 ? raw : 30;
  },
  get nodeEnv() {
    return process.env.NODE_ENV ?? "development";
  },
  get isProduction() {
    return process.env.NODE_ENV === "production";
  },
};
