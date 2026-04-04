'use client';

export default function ConnectWallet() {
  return (
    <>
      <style>{`
        .cw-btn {
          position: fixed; top: 24px; right: 24px; z-index: 50;
          background: transparent; border: 1px solid rgba(255,255,255,0.15);
          border-radius: 100px; padding: 10px 24px; cursor: none;
          font-family: var(--font-inter); font-size: 13px; font-weight: 500;
          color: #E8E4DE; letter-spacing: 0.02em;
          transition: background 0.25s, border-color 0.25s;
        }
        .cw-btn:hover {
          background: rgba(255,255,255,0.06);
          border-color: rgba(255,255,255,0.3);
        }
      `}</style>
      <button
        className="cw-btn"
        onClick={() => console.log('Connect wallet clicked')}
      >
        Connect Wallet
      </button>
    </>
  );
}
