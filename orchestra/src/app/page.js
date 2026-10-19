'use client';

import CustomCursor    from '@/components/CustomCursor';
import WaitlistNav     from '@/components/WaitlistNav';
import WaitlistHero    from '@/components/WaitlistHero';
import CountdownTimer  from '@/components/CountdownTimer';
import FeatureCards    from '@/components/FeatureCards';
import TractionBadges  from '@/components/TractionBadges';
import WaitlistFooter  from '@/components/WaitlistFooter';

export default function Home() {
  return (
    <div className="grainient-bg">
      <CustomCursor />
      <WaitlistNav />

      <main>
        <WaitlistHero />
        <CountdownTimer />
        <FeatureCards />
        <TractionBadges />
      </main>

      <WaitlistFooter />
    </div>
  );
}
