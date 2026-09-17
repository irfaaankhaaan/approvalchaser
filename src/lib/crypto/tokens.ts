import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Approval tokens.
 *
 * The token is the only credential a client ever holds, so it has to be
 * unguessable and it must not be recoverable from the database. We generate
 * 32 random bytes (256 bits), hand the base64url form to the client, and
 * store only its SHA-256.
 *
 * SHA-256 with no salt or stretching is the right choice here, unlike for a
 * password: the input is full-entropy random, so there is nothing to brute
 * force, and an unsalted digest is what lets us look the token up by index.
 */

const TOKEN_BYTES = 32;

export function generateApprovalToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export function hashApprovalToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Shape check before the token ever reaches a query. Rejects anything that is
 * not a plausible token so that garbage never becomes a database round trip.
 */
export function looksLikeApprovalToken(token: unknown): token is string {
  return (
    typeof token === "string" &&
    token.length >= 40 &&
    token.length <= 128 &&
    /^[A-Za-z0-9_-]+$/.test(token)
  );
}

/** Constant-time comparison for any secret compared as a string. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
