import { createHash } from "node:crypto";
import { headers } from "next/headers";
import { hitRateLimit } from "@/lib/db/repositories";

/**
 * Rate limiting for the public approval surface.
 *
 * Two things worth noting. The counter lives in Postgres, not in memory,
 * because serverless instances share no memory and a per-process counter
 * would limit nothing. And bucket keys are always hashed: a rate-limit row is
 * not a place to put an approval token in plaintext.
 */

export class RateLimitError extends Error {
  constructor(message = "Too many requests. Please wait a moment and try again.") {
    super(message);
    this.name = "RateLimitError";
  }
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

/** Best-effort client address, from the proxy headers Vercel and friends set. */
export async function clientAddress(): Promise<string> {
  const store = await headers();
  const forwarded = store.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return store.get("x-real-ip") ?? "unknown";
}

export async function limit(input: {
  scope: string;
  key: string;
  max: number;
  windowSeconds: number;
  now?: Date;
}): Promise<void> {
  const { allowed } = await hitRateLimit({
    bucket: `${input.scope}:${fingerprint(input.key)}`,
    windowSeconds: input.windowSeconds,
    max: input.max,
    now: input.now,
  });
  if (!allowed) throw new RateLimitError();
}

/**
 * Guard a page view. Limited per address rather than per link, so that
 * walking a range of guessed tokens is throttled even though each guess
 * targets a different one.
 */
export async function limitApprovalView(): Promise<void> {
  await limit({
    scope: "approve:view",
    key: await clientAddress(),
    max: 60,
    windowSeconds: 60,
  });
}

/** Guard a decision. Limited per link and per address. */
export async function limitApprovalAction(credentialValue: string): Promise<void> {
  await limit({
    scope: "approve:act:link",
    key: credentialValue,
    max: 10,
    windowSeconds: 60,
  });
  await limit({
    scope: "approve:act:ip",
    key: await clientAddress(),
    max: 20,
    windowSeconds: 60,
  });
}
