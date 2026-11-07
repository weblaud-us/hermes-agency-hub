import type { Metadata } from "next";
import { Suspense } from "react";
import { LoginExperience } from "@/components/auth/LoginExperience";
import { Backdrop } from "@/components/ui/Backdrop";

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to the Weblaud agency console or your business portal.",
  robots: { index: false, follow: false },
};

export default function LoginPage() {
  return (
    <>
      <Backdrop />
      <Suspense fallback={<div className="min-h-dvh" />}>
        <LoginExperience />
      </Suspense>
    </>
  );
}
