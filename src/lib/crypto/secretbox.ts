import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "@/lib/env";

/**
 * Symmetric encryption for Slack bot tokens at rest.
 *
 * AES-256-GCM. The stored string is "v1.<iv>.<authTag>.<ciphertext>", all
 * base64url. GCM is authenticated, so a tampered ciphertext fails to decrypt
 * rather than silently yielding the wrong bytes.
 */

const VERSION = "v1";

function key(): Buffer {
  const raw = Buffer.from(env.tokenEncryptionKey, "base64");
  if (raw.length !== 32) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded. " +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }
  return raw;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptSecret(encoded: string): string {
  const [version, iv, tag, ciphertext] = encoded.split(".");
  if (version !== VERSION || !iv || !tag || !ciphertext) {
    throw new Error("Malformed encrypted secret");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key(),
    Buffer.from(iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
