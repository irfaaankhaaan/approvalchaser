import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { safeEqual } from "@/lib/crypto/tokens";
import { runOverdueSweep, runReminderSweep } from "@/lib/reminders/service";
import { pruneRateLimits } from "@/lib/db/repositories";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The scheduler.
 *
 * Nothing is held in memory between invocations: every pending reminder is a
 * row with a time on it, so the sequence survives a restart, a redeploy, and a
 * cold start with no state of its own. A `setTimeout` would not.
 *
 * Both sweeps are idempotent, so running this more often than necessary is
 * harmless and running it twice at once is safe. Schedule it every five
 * minutes; the granularity of a reminder is then five minutes, which is far
 * finer than any deadline an agency actually cares about.
 */
export async function GET(request: Request) {
  if (!authorized(request)) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const startedAt = Date.now();
  const now = new Date();

  try {
    // Reminders first: an approval that is about to go overdue should get its
    // last nudge before it is marked late.
    const reminders = await runReminderSweep(now);
    const overdue = await runOverdueSweep(now);

    // Housekeeping. Rate-limit windows older than a day are dead weight.
    await pruneRateLimits(new Date(now.getTime() - 86_400_000));

    return NextResponse.json({
      ok: true,
      ranAt: now.toISOString(),
      durationMs: Date.now() - startedAt,
      reminders,
      overdue,
    });
  } catch (error) {
    console.error("[cron] sweep failed:", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "sweep failed" },
      { status: 500 },
    );
  }
}

/**
 * Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. Without this check
 * the endpoint is a public button that emails every agency's clients.
 */
function authorized(request: Request): boolean {
  const header = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${env.cronSecret}`;
  return safeEqual(header, expected);
}
