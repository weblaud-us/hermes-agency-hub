import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { PortalApp, PortalSkeleton } from "@/components/portal/PortalApp";
import { Backdrop } from "@/components/ui/Backdrop";

const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

interface PortalPageProps {
  params: Promise<{ subdomain: string }>;
}

function companyFromSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export async function generateMetadata({ params }: PortalPageProps): Promise<Metadata> {
  const { subdomain } = await params;
  const company = DNS_LABEL.test(subdomain) ? companyFromSlug(subdomain) : "Client";
  return {
    // Absolute, because the root layout's title template appends the agency's name.
    title: { absolute: `${company} • AI Operations Portal` },
    description: `Private operations portal for ${company}.`,
    robots: { index: false, follow: false },
  };
}

export default async function PortalPage({ params }: PortalPageProps) {
  const { subdomain } = await params;
  if (!DNS_LABEL.test(subdomain)) notFound();

  return (
    <>
      <Backdrop />
      <Suspense fallback={<PortalSkeleton />}>
        <PortalApp subdomain={subdomain} />
      </Suspense>
    </>
  );
}
