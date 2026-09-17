import type { Metadata } from "next";
import { ApprovalScreen } from "@/app/approve/ApprovalScreen";
import { NotAvailable } from "@/app/approve/NotAvailable";
import { resolveApproval } from "@/app/approve/resolve";

/**
 * The link reminders carry.
 *
 * Identical page, different credential: a signed pointer instead of the
 * original token, because the token is stored only as a hash and cannot be
 * rebuilt for a reminder sent days later.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Approval",
  robots: { index: false, follow: false },
};

export default async function ApproveByPointerPage({
  params,
}: {
  params: Promise<{ pointer: string }>;
}) {
  const { pointer } = await params;
  const resolved = await resolveApproval({ kind: "pointer", value: pointer });

  if (!resolved.ok) return <NotAvailable reason={resolved.reason} />;

  return (
    <ApprovalScreen
      approval={resolved.approval}
      credentialKind="pointer"
      credential={pointer}
    />
  );
}
