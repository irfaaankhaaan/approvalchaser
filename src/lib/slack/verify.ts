import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Slack request verification.
 *
 * Slack signs every request to our endpoints. Without this check, anyone who
 * learns the URL can post a payload claiming to be any workspace and any user
 * — which in this app means cancelling other agencies' approvals. It runs
 * before the body is parsed, on the raw bytes, because re-serialising JSON
 * changes them and breaks the signature.
 */

/** Slack's own recommendation, and the replay window this app enforces. */
export const MAX_TIMESTAMP_SKEW_SECONDS = 300;

export type VerificationFailure =
  | "missing_headers"
  | "bad_timestamp"
  | "stale_timestamp"
  | "bad_signature";

export type VerificationResult =
  | { ok: true }
  | { ok: false; reason: VerificationFailure };

export function verifySlackSignature(input: {
  signingSecret: string;
  /** The exact bytes of the request body, before any parsing. */
  rawBody: string;
  timestamp: string | null;
  signature: string | null;
  now?: Date;
}): VerificationResult {
  const { signingSecret, rawBody, timestamp, signature } = input;

  if (!timestamp || !signature) return { ok: false, reason: "missing_headers" };

  const sent = Number(timestamp);
  if (!Number.isFinite(sent)) return { ok: false, reason: "bad_timestamp" };

  // The replay guard. An intercepted, perfectly valid request stops being
  // usable five minutes later.
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - sent) > MAX_TIMESTAMP_SKEW_SECONDS) {
    return { ok: false, reason: "stale_timestamp" };
  }

  const expected =
    "v0=" +
    createHmac("sha256", signingSecret)
      .update(`v0:${timestamp}:${rawBody}`, "utf8")
      .digest("hex");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad_signature" };
  }

  return { ok: true };
}

/** Header-reading wrapper for a Next.js Request. */
export function verifySlackRequest(
  request: Request,
  rawBody: string,
  signingSecret: string,
  now?: Date,
): VerificationResult {
  return verifySlackSignature({
    signingSecret,
    rawBody,
    timestamp: request.headers.get("x-slack-request-timestamp"),
    signature: request.headers.get("x-slack-signature"),
    now,
  });
}

/**
 * The OAuth `state` parameter, signed so that the callback can tell its own
 * redirect from a forged one. This is the CSRF guard on installation.
 */
export function signOAuthState(secret: string, nonce: string, issuedAt: number): string {
  const payload = `${nonce}.${issuedAt}`;
  const mac = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

export function verifyOAuthState(
  secret: string,
  state: string | null,
  now = Date.now(),
  maxAgeMs = 10 * 60 * 1000,
): boolean {
  if (!state) return false;
  const parts = state.split(".");
  if (parts.length !== 3) return false;
  const [nonce, issuedAt, mac] = parts as [string, string, string];

  const expected = createHmac("sha256", secret)
    .update(`${nonce}.${issuedAt}`)
    .digest("base64url");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(mac, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;

  const age = now - Number(issuedAt);
  return Number.isFinite(age) && age >= 0 && age <= maxAgeMs;
}
