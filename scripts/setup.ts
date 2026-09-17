/**
 * One command to get a working `.env.local`.
 *
 * Two of the required variables are random secrets with no meaningful
 * default — generating them by hand means finding the right one-liner,
 * running it, and pasting the result into the right line. This does that
 * automatically and leaves everything else for the person to fill in.
 *
 * Idempotent: a variable that is already set, here or in `.env.local`, is
 * left untouched. Safe to run again after a partial setup.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const ENV_LOCAL = path.join(ROOT, ".env.local");
const ENV_EXAMPLE = path.join(ROOT, ".env.example");

function parseEnv(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match) values.set(match[1]!, match[2]!);
  }
  return values;
}

function main() {
  if (!existsSync(ENV_LOCAL)) {
    if (!existsSync(ENV_EXAMPLE)) {
      throw new Error(".env.example is missing — run this from the project root.");
    }
    copyFileSync(ENV_EXAMPLE, ENV_LOCAL);
    console.info("Created .env.local from .env.example.");
  }

  let text = readFileSync(ENV_LOCAL, "utf8");
  const values = parseEnv(text);
  const generated: string[] = [];

  const fill = (name: string, value: () => string) => {
    if (values.get(name)?.trim()) return; // already set — leave it alone
    const line = `${name}=${value()}`;
    text = new RegExp(`^${name}=.*$`, "m").test(text)
      ? text.replace(new RegExp(`^${name}=.*$`, "m"), line)
      : `${text.trimEnd()}\n${line}\n`;
    generated.push(name);
  };

  fill("SLACK_STATE_SECRET", () => randomBytes(32).toString("base64"));
  fill("TOKEN_ENCRYPTION_KEY", () => randomBytes(32).toString("base64"));
  fill("CRON_SECRET", () => randomBytes(32).toString("hex"));

  if (generated.length > 0) {
    writeFileSync(ENV_LOCAL, text);
    console.info(`Generated: ${generated.join(", ")}.`);
  } else {
    console.info("Secrets already set — nothing to generate.");
  }

  const remaining = ["SLACK_SIGNING_SECRET", "SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET"]
    .filter((name) => !parseEnv(text).get(name)?.trim());

  console.info("\nNext:");
  console.info("  npm run db:seed   # three demo approvals, no database needed");
  console.info("  npm run dev");
  if (remaining.length > 0) {
    console.info(
      `\nFor Slack itself, add these to .env.local from your Slack app's Basic ` +
        `Information page (see README): ${remaining.join(", ")}.`,
    );
  }
}

main();
