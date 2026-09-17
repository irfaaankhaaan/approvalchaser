import { describe, expect, it } from "vitest";
import {
  generateApprovalToken,
  hashApprovalToken,
  looksLikeApprovalToken,
  safeEqual,
} from "@/lib/crypto/tokens";
import { decryptSecret, encryptSecret } from "@/lib/crypto/secretbox";
import { mintAgencyLink, readAgencyLink } from "@/lib/crypto/signed-link";
import { mintReminderLink, readReminderLink } from "@/lib/crypto/reminder-link";

describe("approval tokens", () => {
  it("generates URL-safe tokens with at least 256 bits of entropy", () => {
    const token = generateApprovalToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 random bytes in base64url.
    expect(token.length).toBeGreaterThanOrEqual(43);
  });

  it("never repeats", () => {
    const seen = new Set(
      Array.from({ length: 500 }, () => generateApprovalToken()),
    );
    expect(seen.size).toBe(500);
  });

  it("hashes deterministically, and differently per token", () => {
    const token = generateApprovalToken();
    expect(hashApprovalToken(token)).toBe(hashApprovalToken(token));
    expect(hashApprovalToken(token)).not.toBe(
      hashApprovalToken(generateApprovalToken()),
    );
    expect(hashApprovalToken(token)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("cannot be reversed from the stored hash", () => {
    const token = generateApprovalToken();
    expect(hashApprovalToken(token)).not.toContain(token);
  });

  it("rejects anything that is not a plausible token before it reaches a query", () => {
    expect(looksLikeApprovalToken(generateApprovalToken())).toBe(true);
    expect(looksLikeApprovalToken("")).toBe(false);
    expect(looksLikeApprovalToken("short")).toBe(false);
    expect(looksLikeApprovalToken("../../etc/passwd")).toBe(false);
    expect(looksLikeApprovalToken("' OR 1=1 --")).toBe(false);
    expect(looksLikeApprovalToken("a".repeat(500))).toBe(false);
    expect(looksLikeApprovalToken(null)).toBe(false);
    expect(looksLikeApprovalToken(42)).toBe(false);
  });

  it("compares secrets without leaking length mismatches as exceptions", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });
});

describe("bot token encryption", () => {
  // The fixtures below stand in for a Slack bot token without being shaped
  // like one. A realistic-looking `xoxb-...` literal trips secret scanners,
  // and a test fixture is not worth teaching people to click through that
  // warning.
  it("round-trips", () => {
    const secret = "slack-bot-credential-1234567890-abcdefghijklmnop";
    expect(decryptSecret(encryptSecret(secret))).toBe(secret);
  });

  it("produces different ciphertext each time, so equal tokens are not obvious", () => {
    const secret = "slack-bot-credential-same";
    expect(encryptSecret(secret)).not.toBe(encryptSecret(secret));
  });

  it("does not contain the plaintext", () => {
    expect(encryptSecret("slack-bot-credential-hunter2")).not.toContain("hunter2");
  });

  it("refuses a tampered ciphertext instead of returning wrong bytes", () => {
    const encoded = encryptSecret("slack-bot-credential-token");
    const parts = encoded.split(".");
    const flipped = Buffer.from(parts[3]!, "base64url");
    flipped[0] = (flipped[0]! ^ 0xff) & 0xff;
    parts[3] = flipped.toString("base64url");
    expect(() => decryptSecret(parts.join("."))).toThrow();
  });

  it("refuses a malformed value", () => {
    expect(() => decryptSecret("nonsense")).toThrow(/Malformed/);
  });
});

describe("signed agency links", () => {
  it("round-trips the organization and approval it was minted for", () => {
    const link = mintAgencyLink("org-1", "approval-1");
    expect(readAgencyLink(link)).toMatchObject({
      organizationId: "org-1",
      approvalId: "approval-1",
    });
  });

  it("rejects a link whose payload was edited to point at another tenant", () => {
    const link = mintAgencyLink("org-1", "approval-1");
    const [body, mac] = link.split(".") as [string, string];
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    payload.organizationId = "org-2";
    const forged =
      Buffer.from(JSON.stringify(payload), "utf8").toString("base64url") +
      "." +
      mac;
    expect(readAgencyLink(forged)).toBeNull();
  });

  it("expires", () => {
    const link = mintAgencyLink("org-1", "approval-1", Date.now());
    expect(readAgencyLink(link, Date.now() + 2 * 60 * 60 * 1000)).toBeNull();
  });

  it("rejects junk", () => {
    expect(readAgencyLink("")).toBeNull();
    expect(readAgencyLink("a.b.c")).toBeNull();
    expect(readAgencyLink("not-a-link")).toBeNull();
  });
});

describe("signed reminder pointers", () => {
  const id = "11111111-2222-3333-4444-555555555555";

  it("round-trips", () => {
    expect(readReminderLink(mintReminderLink(id))).toBe(id);
  });

  it("cannot be forged for another approval without the signing secret", () => {
    const other = "99999999-8888-7777-6666-555555555555";
    const mac = mintReminderLink(id).split(".")[1]!;
    expect(readReminderLink(`${other}.${mac}`)).toBeNull();
  });

  it("refuses an id that is not a UUID, so junk never reaches the query", () => {
    expect(readReminderLink("'; DROP TABLE approvals; --.sig")).toBeNull();
    expect(readReminderLink("../../etc.sig")).toBeNull();
  });
});
