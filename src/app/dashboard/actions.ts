"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import {
  ApprovalError,
  cancelApproval,
  createApproval,
} from "@/lib/approvals/service";
import { sendManualReminder } from "@/lib/reminders/service";
import { presetOffsets } from "@/lib/reminders/schedule";
import { safeExternalUrl } from "@/lib/format";
import {
  getOrCreateDefaultOrganization,
  renameOrganization,
} from "@/lib/db/repositories";

/**
 * The dashboard's server actions.
 *
 * Every one of these resolves the organization itself via
 * getOrCreateDefaultOrganization() — never from anything the form or a
 * hidden field carries. That mirrors how the Slack side always derives the
 * organization from the verified team_id rather than trusting client input:
 * there is no login here to derive it from instead, so "whichever
 * organization already exists" has to come from the server, the same way,
 * every time.
 */

export interface FormState {
  ok: boolean;
  error?: string;
}

function explain(error: unknown): string {
  if (error instanceof ApprovalError) return error.message;
  console.error("[dashboard] unexpected failure:", error);
  return "Something went wrong. Please try again.";
}

const createSchema = z.object({
  clientName: z.string().trim().min(1, "Enter a client name.").max(120),
  clientEmail: z.string().trim().email("Enter a valid email address.").max(254),
  contactName: z.string().trim().max(80).optional(),
  creativeName: z.string().trim().min(1, "Enter what you're getting approved.").max(200),
  creativeUrl: z.string().trim().max(2048).optional(),
  notes: z.string().trim().max(1000).optional(),
  deadline: z.string().trim().min(1, "Pick a deadline."),
  schedulePreset: z.string().trim().min(1).max(40),
});

export async function createApprovalAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const raw = {
    clientName: String(formData.get("clientName") ?? ""),
    clientEmail: String(formData.get("clientEmail") ?? ""),
    contactName: String(formData.get("contactName") ?? "") || undefined,
    creativeName: String(formData.get("creativeName") ?? ""),
    creativeUrl: String(formData.get("creativeUrl") ?? "") || undefined,
    notes: String(formData.get("notes") ?? "") || undefined,
    deadline: String(formData.get("deadline") ?? ""),
    schedulePreset: String(formData.get("schedulePreset") ?? "12h_4h_2h"),
  };

  const parsed = createSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the form and try again." };
  }

  // The browser sends its own local wall-clock time with no timezone
  // (`datetime-local`'s format), so it is read as local time on this server
  // — correct as long as the dashboard and the browser are the same
  // machine, which is the setting this page is built for.
  const deadline = new Date(parsed.data.deadline);
  if (Number.isNaN(deadline.getTime()) || deadline.getTime() <= Date.now()) {
    return { ok: false, error: "Pick a deadline in the future." };
  }

  const creativeUrl = parsed.data.creativeUrl
    ? safeExternalUrl(parsed.data.creativeUrl)
    : null;
  if (parsed.data.creativeUrl && !creativeUrl) {
    return { ok: false, error: "Use a full http:// or https:// link for the creative." };
  }

  try {
    const organization = await getOrCreateDefaultOrganization();
    await createApproval({
      organizationId: organization.id,
      clientName: parsed.data.clientName,
      clientEmail: parsed.data.clientEmail,
      contactName: parsed.data.contactName ?? null,
      creativeName: parsed.data.creativeName,
      creativeUrl,
      notes: parsed.data.notes ?? null,
      deadline,
      reminderOffsets: presetOffsets(parsed.data.schedulePreset),
      // No Slack channel: this approval was created from the dashboard, so
      // there is nothing to post to. The client still gets emailed exactly
      // as normal.
    });
    revalidatePath("/dashboard");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: explain(error) };
  }
}

// remindApprovalAction and cancelApprovalAction are bound with the approval
// id via .bind(null, approval.id) at the call site, which is how a plain
// <form action={...}> row button passes an argument alongside the FormData
// the browser always appends — the second parameter here is that FormData,
// present only to match the calling convention; there is nothing on it to
// read.

export async function remindApprovalAction(
  approvalId: string,
  _formData: FormData,
): Promise<void> {
  const organization = await getOrCreateDefaultOrganization();
  try {
    await sendManualReminder({ organizationId: organization.id, approvalId });
  } catch (error) {
    // A plain <form action={fn}> row action has nowhere to show an inline
    // error; logging keeps the failure visible without breaking the page.
    console.error("[dashboard] reminder failed:", error);
  }
  revalidatePath("/dashboard");
}

export async function cancelApprovalAction(
  approvalId: string,
  _formData: FormData,
): Promise<void> {
  const organization = await getOrCreateDefaultOrganization();
  try {
    await cancelApproval({ organizationId: organization.id, approvalId });
  } catch (error) {
    console.error("[dashboard] cancel failed:", error);
  }
  revalidatePath("/dashboard");
}

export async function renameOrganizationAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const name = String(formData.get("name") ?? "").trim();
  if (!name || name.length > 120) {
    return { ok: false, error: "Enter a name up to 120 characters." };
  }

  const organization = await getOrCreateDefaultOrganization();
  await renameOrganization(organization.id, name);
  revalidatePath("/dashboard");
  return { ok: true };
}
