import { afterEach, describe, expect, it } from "vitest";
import { slackIsConfigured } from "@/lib/slack/env-guard";

/**
 * Found by actually running the app: with SLACK_SIGNING_SECRET unset (the
 * state a fresh deployment starts in, and the state tests/setup.ts never
 * exercises since it sets every Slack variable), every Slack route threw an
 * unhandled exception instead of answering cleanly — a human clicking
 * "Add to Slack" on the landing page saw a blank 500.
 */
describe("slackIsConfigured", () => {
  const keys = [
    "SLACK_SIGNING_SECRET",
    "SLACK_CLIENT_ID",
    "SLACK_CLIENT_SECRET",
    "SLACK_STATE_SECRET",
  ] as const;
  const saved: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  function set(overrides: Partial<Record<(typeof keys)[number], string>>) {
    for (const key of keys) {
      saved[key] = process.env[key];
      process.env[key] = overrides[key] ?? "";
    }
  }

  it("is false with nothing configured", () => {
    set({});
    expect(slackIsConfigured()).toBe(false);
  });

  it("is false with only some of the four set", () => {
    set({ SLACK_SIGNING_SECRET: "a", SLACK_CLIENT_ID: "b" });
    expect(slackIsConfigured()).toBe(false);
  });

  it("is true once all four are set", () => {
    set({
      SLACK_SIGNING_SECRET: "a",
      SLACK_CLIENT_ID: "b",
      SLACK_CLIENT_SECRET: "c",
      SLACK_STATE_SECRET: "d",
    });
    expect(slackIsConfigured()).toBe(true);
  });

  it("treats a blank string the same as unset", () => {
    set({
      SLACK_SIGNING_SECRET: "   ",
      SLACK_CLIENT_ID: "b",
      SLACK_CLIENT_SECRET: "c",
      SLACK_STATE_SECRET: "d",
    });
    expect(slackIsConfigured()).toBe(false);
  });
});
