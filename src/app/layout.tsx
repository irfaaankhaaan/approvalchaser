import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Approval Chaser",
  description: "Creative approvals, chased automatically.",
  // Approval links are private. Keep every page of this app out of indexes.
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
