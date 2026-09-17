import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MAX_TIMESTAMP_SKEW_SECONDS,
  signOAuthState,
  verifyOAuthState,
  verifySlackRequest,
  verifySlackSignature,
} from "@/lib/slack/verify";

const SECRET = "test-signing-secret";

function sign(body: string, timestamp: number, secret = SECRET): string {
  return (
    "v0=" +
    createHmac("sha256", secret)
      .update(`v0:${timestamp}:${body}`, "utf8")
      .digest("hex")
  );
}

describe("Slack request signatures", () => {
  const now = new Date("2026-09-17T12:00:00Z");
  const timestamp = Math.floor(now.getTime() / 1000);
  const body = "token=x&team_id=T123&command=%2Fapproval&text=create";

  it("accepts a correctly signed request", () => {
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        rawBody: body,
        timestamp: String(timestamp),
        signature: sign(body, timestamp),
        now,
      }),
    ).toEqual({ ok: true });
  });

  it("rejects a signature made with a different secret", () => {
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        rawBody: body,
        timestamp: String(timestamp),
        signature: sign(body, timestamp, "attacker-secret"),
        now,
      }),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a body that was modified after signing", () => {
    const signature = sign(body, timestamp);
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        rawBody: body.replace("T123", "T999"),
        timestamp: String(timestamp),
        signature,
        now,
      }),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a replayed request once the window has passed", () => {
    const old = timestamp - MAX_TIMESTAMP_SKEW_SECONDS - 1;
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        rawBody: body,
        timestamp: String(old),
        signature: sign(body, old),
        now,
      }),
    ).toEqual({ ok: false, reason: "stale_timestamp" });
  });

  it("accepts a request at the edge of the window", () => {
    const edge = timestamp - MAX_TIMESTAMP_SKEW_SECONDS;
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        rawBody: body,
        timestamp: String(edge),
        signature: sign(body, edge),
        now,
      }).ok,
    ).toBe(true);
  });

  it("rejects a timestamp from the future beyond the skew", () => {
    const ahead = timestamp + MAX_TIMESTAMP_SKEW_SECONDS + 60;
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        rawBody: body,
        timestamp: String(ahead),
        signature: sign(body, ahead),
        now,
      }),
    ).toEqual({ ok: false, reason: "stale_timestamp" });
  });

  it("rejects missing headers rather than throwing", () => {
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        rawBody: body,
        timestamp: null,
        signature: null,
        now,
      }),
    ).toEqual({ ok: false, reason: "missing_headers" });
  });

  it("rejects a non-numeric timestamp", () => {
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        rawBody: body,
        timestamp: "not-a-number",
        signature: sign(body, timestamp),
        now,
      }),
    ).toEqual({ ok: false, reason: "bad_timestamp" });
  });

  it("rejects a truncated signature without throwing on length mismatch", () => {
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        rawBody: body,
        timestamp: String(timestamp),
        signature: "v0=abc",
        now,
      }),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("reads the headers off a Request", () => {
    const request = new Request("https://chaser.test/api/slack/commands", {
      method: "POST",
      headers: {
        "x-slack-request-timestamp": String(timestamp),
        "x-slack-signature": sign(body, timestamp),
      },
    });
    expect(verifySlackRequest(request, body, SECRET, now).ok).toBe(true);
  });
});

describe("OAuth state", () => {
  it("round-trips a freshly minted state", () => {
    const state = signOAuthState(SECRET, "nonce-1", Date.now());
    expect(verifyOAuthState(SECRET, state)).toBe(true);
  });

  it("rejects a state signed with another secret", () => {
    const state = signOAuthState("other-secret", "nonce-1", Date.now());
    expect(verifyOAuthState(SECRET, state)).toBe(false);
  });

  it("rejects a state whose nonce was swapped", () => {
    const state = signOAuthState(SECRET, "nonce-1", Date.now());
    const mac = state.split(".")[2]!;
    expect(verifyOAuthState(SECRET, `nonce-2.${Date.now()}.${mac}`)).toBe(false);
  });

  it("expires after ten minutes", () => {
    const issued = Date.now() - 11 * 60 * 1000;
    expect(verifyOAuthState(SECRET, signOAuthState(SECRET, "n", issued))).toBe(false);
  });

  it("rejects missing or malformed state", () => {
    expect(verifyOAuthState(SECRET, null)).toBe(false);
    expect(verifyOAuthState(SECRET, "")).toBe(false);
    expect(verifyOAuthState(SECRET, "a.b")).toBe(false);
  });
});
