import type { Metadata } from "next";
import { ApprovalScreen } from "@/app/approve/ApprovalScreen";
import { NotAvailable } from "@/app/approve/NotAvailable";
import { resolveApproval } from "@/app/approve/resolve";

// The page reflects live status and records that the client opened it, so it
// must never be cached or prerendered.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Approval",
  robots: { index: false, follow: false },
};

export default async function ApprovePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const resolved = await resolveApproval({ kind: "token", value: token });

  if (!resolved.ok) return <NotAvailable reason={resolved.reason} />;

  return (
    <ApprovalScreen
      approval={resolved.approval}
      credentialKind="token"
      credential={token}
    />
  );
}
