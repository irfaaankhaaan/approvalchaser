import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

/**
 * Signed pointers used in reminder emails.
 *
 * The approval token is stored only as a hash, which is the right call for a
 * credential but means a reminder sent three days later cannot rebuild the
 * original link. Rather than weaken that by storing the token in plaintext,
 * reminders carry a signed pointer to the approval row. `/approve/r/<pointer>`
 * verifies the signature, looks the approval up by id and renders the same
 * page.
 *
 * The pointer is unguessable without the signing secret, and it grants exactly
 * what the original link grants: one approval, nothing else.
 */

export function mintReminderLink(approvalId: string): string {
  const mac = createHmac("sha256", env.slackStateSecret)
    .update(`reminder:${approvalId}`)
    .digest("base64url");
  return `${approvalId}.${mac}`;
}

export function readReminderLink(pointer: string): string | null {
  const parts = pointer.split(".");
  if (parts.length !== 2) return null;
  const [approvalId, mac] = parts as [string, string];

  // Keep obvious junk away from a UUID-typed column.
  if (!/^[0-9a-f-]{36}$/i.test(approvalId)) return null;

  const expected = createHmac("sha256", env.slackStateSecret)
    .update(`reminder:${approvalId}`)
    .digest("base64url");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(mac, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return approvalId;
}
