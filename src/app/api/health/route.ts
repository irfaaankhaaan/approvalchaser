import { NextResponse } from "next/server";
import { sqlOne } from "@/lib/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Liveness plus a real database round trip. */
export async function GET() {
  try {
    await sqlOne("SELECT 1 AS ok");
    return NextResponse.json({ ok: true, database: "up" });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        database: "down",
        error: error instanceof Error ? error.message : "unknown",
      },
      { status: 503 },
    );
  }
}
