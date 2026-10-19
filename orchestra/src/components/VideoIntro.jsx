'use client';

import { useCallback, useEffect, useRef } from 'react';

const SKIP_LABEL = 'Skip';

/**
 * Intro plein écran : la vidéo joue une fois, puis `onDone` déclenche le fade.
 *
 * `hero-intro.mov` est du HEVC en conteneur QuickTime : Safari le lit, Chrome
 * selon la machine, Firefox jamais. Comme l'intro couvre toute la page, un
 * décodage impossible bloquerait le visiteur sur un écran noir — d'où trois
 * garde-fous : `onError`, un watchdog si la lecture n'a pas démarré en 3s, et
 * un plafond calé sur la durée réelle une fois les métadonnées connues. On
 * saute aussi l'intro d'emblée en `prefers-reduced-motion`.
 *
 * Déposer un `/videos/hero-intro.mp4` (H.264) suffit à couvrir tous les
 * navigateurs : il est déjà listé en première source.
 */
export default function VideoIntro({ onDone }) {
  const startedRef = useRef(false);
  const capRef     = useRef(null);

  const finish = useCallback(() => {
    if (capRef.current) clearTimeout(capRef.current);
    onDone();
  }, [onDone]);

  // Échec de décodage / de chargement : on passe directement au contenu.
  const onFail = useCallback(() => {
    if (!startedRef.current) finish();
  }, [finish]);

  const onPlaying = useCallback(() => {
    startedRef.current = true;
  }, []);

  // Plafond de sûreté : durée réelle + 2s, au cas où `ended` ne se déclenche pas.
  const onLoadedMetadata = useCallback(
    (e) => {
      const { duration } = e.currentTarget;
      if (!Number.isFinite(duration) || duration <= 0) return;
      if (capRef.current) clearTimeout(capRef.current);
      capRef.current = setTimeout(finish, (duration + 2) * 1000);
    },
    [finish]
  );

  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Watchdog : si rien ne joue au bout de 3s, on n'attend pas plus.
    const t = setTimeout(
      () => {
        if (reduce || !startedRef.current) finish();
      },
      reduce ? 0 : 3000
    );

    return () => {
      clearTimeout(t);
      if (capRef.current) clearTimeout(capRef.current);
    };
  }, [finish]);

  // Pas de scroll derrière l'overlay.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  return (
    <>
      <video
        autoPlay
        muted
        playsInline
        preload="auto"
        onEnded={finish}
        onPlaying={onPlaying}
        onError={onFail}
        onStalled={onFail}
        onLoadedMetadata={onLoadedMetadata}
        className="h-full w-full object-cover"
      >
        <source src="/videos/hero-intro.mp4" type="video/mp4" />
        <source src="/videos/hero-intro.mov" type="video/quicktime" />
      </video>

      <button
        type="button"
        onClick={finish}
        className="absolute bottom-8 right-8 text-xs uppercase"
        style={{
          color: 'var(--text-3)',
          fontWeight: 500,
          letterSpacing: '0.15em',
          transition: 'color 0.3s var(--ease)',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = 'var(--text-2)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = 'var(--text-3)';
        }}
      >
        {SKIP_LABEL}
      </button>
    </>
  );
}
