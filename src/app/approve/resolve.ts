import {
  ApprovalError,
  recordClientView,
  type ClientCredential,
} from "@/lib/approvals/service";
import { limitApprovalView, RateLimitError } from "@/lib/rate-limit";
import type { ApprovalWithClient } from "@/lib/db/types";

/**
 * Turn a client credential into either an approval or a reason to show the
 * unavailable page.
 *
 * Shared by the two approve routes, which differ only in the kind of
 * credential their URL carries. Keeping the resolution here also keeps the
 * pages free of try/catch around their JSX, which React cannot recover from
 * anyway — a render-time throw needs an error boundary, not a catch block.
 */
export type ApprovalResolution =
  | { ok: true; approval: ApprovalWithClient }
  | { ok: false; reason: "expired" | "invalid" };

export async function resolveApproval(
  credential: ClientCredential,
): Promise<ApprovalResolution> {
  try {
    await limitApprovalView();
    return { ok: true, approval: await recordClientView(credential) };
  } catch (error) {
    // A throttled visitor is told the same thing as a bad link: saying
    // "slow down, you're close" to someone guessing tokens is a hint.
    if (error instanceof RateLimitError) return { ok: false, reason: "invalid" };
    if (error instanceof ApprovalError) {
      return {
        ok: false,
        reason: error.code === "expired" ? "expired" : "invalid",
      };
    }
    throw error;
  }
}
