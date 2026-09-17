import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

/**
 * Short-lived agency links.
 *
 * The read-only web view needs to know which organization the visitor may
 * see, and this MVP has no agency login — Slack is the interface. Rather than
 * leave the page unauthenticated, the link is minted inside Slack, where the
 * request is already signature-verified and the user's workspace is known.
 *
 * The payload carries the organization id, so the page authorizes against the
 * organization in the token rather than anything in the URL path or a query
 * parameter. An expired or tampered link is simply not a link.
 */

const TTL_MS = 60 * 60 * 1000; // one hour

interface LinkPayload {
  organizationId: string;
  approvalId: string;
  expiresAt: number;
}

export function mintAgencyLink(
  organizationId: string,
  approvalId: string,
  now = Date.now(),
): string {
  const payload: LinkPayload = {
    organizationId,
    approvalId,
    expiresAt: now + TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const mac = createHmac("sha256", env.slackStateSecret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function readAgencyLink(
  token: string,
  now = Date.now(),
): LinkPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, mac] = parts as [string, string];

  const expected = createHmac("sha256", env.slackStateSecret)
    .update(body)
    .digest("base64url");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(mac, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as LinkPayload;
    if (typeof payload.expiresAt !== "number" || payload.expiresAt < now) return null;
    if (!payload.organizationId || !payload.approvalId) return null;
    return payload;
  } catch {
    return null;
  }
}
