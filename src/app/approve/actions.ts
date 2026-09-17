"use server";

import {
  ApprovalError,
  approveByToken,
  requestChangesByToken,
  type ClientCredential,
} from "@/lib/approvals/service";
import { limitApprovalAction, RateLimitError } from "@/lib/rate-limit";
import { revalidatePath } from "next/cache";

/**
 * The two things a client can do.
 *
 * Note what is not here: there is no action that takes a target status. The
 * client says "approve" or "request changes" and the server decides what that
 * means for the row it finds, then the state machine decides whether the move
 * is legal. A crafted form post cannot name a state.
 *
 * Next validates the Origin against the Host on every Server Action, which is
 * the CSRF guard; the credential in the URL is the authorization.
 */

export interface DecisionState {
  ok: boolean;
  error?: string;
}

function credentialFrom(formData: FormData): ClientCredential | null {
  const kind = formData.get("credentialKind");
  const value = formData.get("credential");
  if (typeof value !== "string" || value.length === 0) return null;
  if (kind === "token") return { kind: "token", value };
  if (kind === "pointer") return { kind: "pointer", value };
  return null;
}

function explain(error: unknown): string {
  if (error instanceof RateLimitError) return error.message;
  if (error instanceof ApprovalError) return error.message;
  console.error("[approve] unexpected failure:", error);
  return "Something went wrong. Please try again, or reply to the email that sent you here.";
}

export async function approveAction(
  _previous: DecisionState,
  formData: FormData,
): Promise<DecisionState> {
  const credential = credentialFrom(formData);
  if (!credential) return { ok: false, error: "This approval link is not valid." };

  try {
    await limitApprovalAction(credential.value);
    await approveByToken(credential);
    revalidatePath(`/approve/${credential.value}`);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: explain(error) };
  }
}

export async function requestChangesAction(
  _previous: DecisionState,
  formData: FormData,
): Promise<DecisionState> {
  const credential = credentialFrom(formData);
  if (!credential) return { ok: false, error: "This approval link is not valid." };

  const comment = formData.get("comment");
  if (typeof comment !== "string" || comment.trim().length < 3) {
    return { ok: false, error: "Please say what you'd like changed." };
  }

  try {
    await limitApprovalAction(credential.value);
    await requestChangesByToken(credential, comment);
    revalidatePath(`/approve/${credential.value}`);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: explain(error) };
  }
}
