'use client';

// TODO — remplacer par le profil X réel d'Orchestra (ex. https://x.com/<handle>).
// Laissé sur la racine x.com : aucun handle n'est référencé dans le repo.
const X_URL = 'https://x.com/';

export default function WaitlistFooter() {
  return (
    <footer className="px-6 py-10 sm:px-8" style={{ borderTop: '1px solid var(--border)' }}>
      <div className="mx-auto flex max-w-5xl flex-col items-center gap-5 sm:flex-row sm:justify-between">
        <span className="wordmark" style={{ color: 'var(--text-1)' }}>
          Orchestra
        </span>

        <div className="flex items-center gap-6">
          <a
            href={X_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="eyebrow"
            style={{ color: 'var(--text-2)', transition: 'color 0.4s var(--ease)' }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = 'var(--text-1)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = 'var(--text-2)';
            }}
          >
            X / Twitter
          </a>

          <span className="eyebrow" style={{ color: 'var(--text-3)' }}>
            © 2025 Orchestra
          </span>
        </div>
      </div>
    </footer>
  );
}
