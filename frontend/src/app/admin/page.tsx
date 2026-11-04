import type { Metadata } from "next";
import { Suspense } from "react";
import { AdminConsole } from "@/components/admin/AdminConsole";
import { Backdrop } from "@/components/ui/Backdrop";

export const metadata: Metadata = {
  title: "Agency Console",
  description: "Multi-tenant control plane and provisioning console.",
  robots: { index: false, follow: false },
};

export default function AdminPage() {
  return (
    <>
      <Backdrop />
      <Suspense fallback={<div className="min-h-dvh" />}>
        <AdminConsole />
      </Suspense>
    </>
  );
}
