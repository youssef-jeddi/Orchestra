'use client';

import { useCallback, useRef, useState } from 'react';

/**
 * Vidéo de fond du hero.
 *
 * `hero-intro.mov` est du HEVC dans un conteneur QuickTime : Safari le lit,
 * Chrome seulement selon la machine, Firefox pas du tout. On liste donc un
 * `.mp4` H.264 en première source (il suffira de le déposer à côté pour que
 * tous les navigateurs l'utilisent), et on garde l'image `maestro-hero` en
 * couche de repli — visible tant que la vidéo n'a pas démarré, et
 * définitivement si le décodage échoue.
 */
export default function HeroVideo({ opacity = 0.4 }) {
  const [playing, setPlaying] = useState(false);
  const videoRef = useRef(null);

  const onPlaying = useCallback(() => setPlaying(true), []);
  const onFail    = useCallback(() => setPlaying(false), []);

  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      {/* Repli : still cinématique, toujours en dessous de la vidéo */}
      <div
        className="absolute inset-0 bg-cover bg-center"
        style={{
          backgroundImage: 'url(/images/maestro-hero.png)',
          opacity: playing ? 0 : opacity * 0.9,
          filter: 'saturate(0.7)',
          transition: 'opacity 1.2s cubic-bezier(0.16,1,0.3,1)',
        }}
      />

      <video
        ref={videoRef}
        autoPlay
        muted
        loop
        playsInline
        preload="auto"
        onPlaying={onPlaying}
        onError={onFail}
        onStalled={onFail}
        className="absolute inset-0 h-full w-full object-cover"
        style={{
          opacity: playing ? opacity : 0,
          transition: 'opacity 1.2s cubic-bezier(0.16,1,0.3,1)',
        }}
      >
        <source src="/videos/hero-intro.mp4" type="video/mp4" />
        <source src="/videos/hero-intro.mov" type="video/quicktime" />
      </video>

      {/* Overlay sombre : lisibilité du texte + fondu vers la section suivante */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse at 50% 40%, rgba(10,10,15,0.35) 0%, rgba(10,10,15,0.8) 60%, rgba(10,10,15,0.96) 100%)',
        }}
      />
      <div
        className="absolute inset-x-0 bottom-0 h-40"
        style={{ background: 'linear-gradient(to bottom, transparent, #0A0A0F)' }}
      />
    </div>
  );
}
