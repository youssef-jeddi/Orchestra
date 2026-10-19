'use client';

export default function WaitlistFooter() {
  return (
    <footer
      className="px-6 py-10 sm:px-8"
      style={{ borderTop: '1px solid var(--border)' }}
    >
      <div className="mx-auto flex max-w-5xl flex-col items-center gap-4 sm:flex-row sm:justify-between">
        <span
          className="text-[11px] uppercase"
          style={{
            fontFamily: 'var(--font-playfair, serif)',
            color: 'var(--text-2)',
            letterSpacing: '0.24em',
            lineHeight: 1.6,
          }}
        >
          Orchestra
        </span>

        <span
          className="text-center text-[11px]"
          style={{ color: 'var(--text-3)', lineHeight: 1.7 }}
        >
          Built by Sylane, Youssef Jeddi & Hassene Ezzedine — BSA EPFL
        </span>
      </div>
    </footer>
  );
}
