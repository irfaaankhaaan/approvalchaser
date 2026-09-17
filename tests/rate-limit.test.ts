import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freshDatabase, teardown } from "./helpers/db";
import { hitRateLimit, pruneRateLimits } from "@/lib/db/repositories";

/**
 * The counter lives in Postgres rather than in memory, because serverless
 * instances share no memory — an in-process counter would let an attacker
 * spread guesses across instances and hit no limit at all.
 */
describe("rate limiting", () => {
  beforeEach(async () => {
    await freshDatabase();
  });
  afterEach(teardown);

  const now = new Date("2026-09-17T12:00:00Z");

  it("allows requests up to the limit and refuses the next", async () => {
    for (let i = 1; i <= 3; i += 1) {
      const result = await hitRateLimit({
        bucket: "test",
        windowSeconds: 60,
        max: 3,
        now,
      });
      expect(result).toEqual({ allowed: true, hits: i });
    }

    expect(
      await hitRateLimit({ bucket: "test", windowSeconds: 60, max: 3, now }),
    ).toEqual({ allowed: false, hits: 4 });
  });

  it("counts each bucket separately", async () => {
    await hitRateLimit({ bucket: "a", windowSeconds: 60, max: 1, now });
    expect(
      await hitRateLimit({ bucket: "b", windowSeconds: 60, max: 1, now }),
    ).toMatchObject({ allowed: true });
  });

  it("starts over in the next window", async () => {
    await hitRateLimit({ bucket: "test", windowSeconds: 60, max: 1, now });
    expect(
      await hitRateLimit({ bucket: "test", windowSeconds: 60, max: 1, now }),
    ).toMatchObject({ allowed: false });

    const nextWindow = new Date(now.getTime() + 61_000);
    expect(
      await hitRateLimit({
        bucket: "test",
        windowSeconds: 60,
        max: 1,
        now: nextWindow,
      }),
    ).toEqual({ allowed: true, hits: 1 });
  });

  it("counts concurrent hits without losing any to a race", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        hitRateLimit({ bucket: "race", windowSeconds: 60, max: 5, now }),
      ),
    );

    expect(results.filter((r) => r.allowed)).toHaveLength(5);
    expect(new Set(results.map((r) => r.hits)).size).toBe(10);
  });

  it("prunes old windows", async () => {
    await hitRateLimit({ bucket: "old", windowSeconds: 60, max: 5, now });
    await pruneRateLimits(new Date(now.getTime() + 86_400_000));

    // The counter starts from scratch because the row is gone.
    expect(
      await hitRateLimit({ bucket: "old", windowSeconds: 60, max: 5, now }),
    ).toEqual({ allowed: true, hits: 1 });
  });
});
