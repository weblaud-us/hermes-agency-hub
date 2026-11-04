import { BentoFeatures } from "@/components/landing/BentoFeatures";
import { HeroScheduler } from "@/components/landing/HeroScheduler";
import { Navbar } from "@/components/landing/Navbar";
import { PricingTiers } from "@/components/landing/PricingTiers";
import { SiteFooter } from "@/components/landing/SiteFooter";
import { VerticalSkills } from "@/components/landing/VerticalSkills";
import { Backdrop } from "@/components/ui/Backdrop";

export default function HomePage() {
  return (
    <>
      <Backdrop />
      <Navbar />
      <main>
        <HeroScheduler />
        <BentoFeatures />
        <VerticalSkills />
        <PricingTiers />
      </main>
      <SiteFooter />
    </>
  );
}
