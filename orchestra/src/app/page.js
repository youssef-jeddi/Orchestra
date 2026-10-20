'use client';

import WaitlistNav     from '@/components/WaitlistNav';
import WaitlistHero    from '@/components/WaitlistHero';
import FeatureCards    from '@/components/FeatureCards';
import TractionBadges  from '@/components/TractionBadges';
import WaitlistFooter  from '@/components/WaitlistFooter';

export default function Home() {
  return (
    <div className="grainient-bg">
      {/* Video background fixe — visible sur tout le site, au scroll compris.
          Le mp4 (H.264) passe partout ; le .mov HEVC reste en repli Safari. */}
      <div className="video-bg pointer-events-none fixed inset-0 z-0" aria-hidden="true">
        <video
          autoPlay
          muted
          loop
          playsInline
          className="h-full w-full object-cover"
          style={{ opacity: 0.3 }}
        >
          <source src="/videos/hero-intro.mp4" type="video/mp4" />
          <source src="/videos/hero-intro.mov" type="video/quicktime" />
        </video>
        {/* Overlay sombre pour lisibilité du texte */}
        <div
          className="absolute inset-0"
          style={{
            background:
              'linear-gradient(to bottom, rgba(10,10,15,0.5) 0%, rgba(10,10,15,0.8) 100%)',
          }}
        />
      </div>

      <WaitlistNav />

      <main className="relative z-10">
        <WaitlistHero />
        <FeatureCards />
        <TractionBadges />
      </main>

      {/* Le footer est hors de <main> : sans contexte positionné il passerait
          SOUS le calque vidéo (un fixed z-0 peint au-dessus du flux statique). */}
      <div className="relative z-10">
        <WaitlistFooter />
      </div>
    </div>
  );
}
