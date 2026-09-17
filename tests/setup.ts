/**
 * Test environment.
 *
 * Real values for anything cryptographic — the suite exercises the actual
 * HMAC and AES paths rather than stubbing them out. No Resend or Anthropic
 * key, so the mock email provider and the deterministic wording generator are
 * what run, which is also what a developer gets locally.
 */
// NODE_ENV is declared readonly by @types/node; the cast is the assignment.
(process.env as Record<string, string>).NODE_ENV = "test";
process.env.APP_URL = "https://chaser.test";
process.env.SLACK_SIGNING_SECRET = "test-signing-secret";
process.env.SLACK_CLIENT_ID = "1234.5678";
process.env.SLACK_CLIENT_SECRET = "test-client-secret";
process.env.SLACK_STATE_SECRET = "test-state-secret-0123456789";
process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.CRON_SECRET = "test-cron-secret";
delete process.env.DATABASE_URL;
delete process.env.RESEND_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
