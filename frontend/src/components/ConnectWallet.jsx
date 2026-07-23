'use client';

import { useOrchestra } from '@/context/OrchestraContext';

const STATUS_COLORS = {
  disconnected: 'rgba(255,255,255,0.15)',
  scanning: 'rgba(255,180,0,0.5)',
  connected: 'rgba(0,200,100,0.4)',
  ready: 'rgba(0,255,128,0.5)',
  signing: 'rgba(192,132,252,0.5)',
};

export default function ConnectWallet() {
  const { ledger, bridge } = useOrchestra();
  const { deviceStatus, walletAddress, connectionType, connect, connectMetaMask, disconnect } = ledger;

  const isConnected = deviceStatus === 'ready' || deviceStatus === 'connected' || deviceStatus === 'signing';
  const label = deviceStatus === 'scanning'
    ? 'Connecting...'
    : deviceStatus === 'signing'
      ? 'Signing...'
      : isConnected && walletAddress
        ? `${connectionType === 'metamask' ? '🦊 ' : ''}${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`
        : 'Connect Ledger';

  const borderColor = STATUS_COLORS[deviceStatus] || STATUS_COLORS.disconnected;

  return (
    <>
      <style>{`
        .cw-btn {
          position: fixed; top: 24px; right: 24px; z-index: 50;
          background: transparent; border: 1px solid ${borderColor};
          border-radius: 100px; padding: 10px 24px; cursor: none;
          font-family: var(--font-inter); font-size: 13px; font-weight: 500;
          color: #E8E4DE; letter-spacing: 0.02em;
          transition: background 0.25s, border-color 0.25s;
          display: flex; align-items: center; gap: 8px;
        }
        .cw-btn:hover {
          background: rgba(255,255,255,0.06);
          border-color: rgba(255,255,255,0.3);
        }
        .cw-mm {
          position: fixed; top: 66px; right: 24px; z-index: 50;
          background: transparent; border: 1px solid rgba(246,133,27,0.35);
          border-radius: 100px; padding: 10px 24px; cursor: none;
          font-family: var(--font-inter); font-size: 13px; font-weight: 500;
          color: #E8E4DE; letter-spacing: 0.02em;
          transition: background 0.25s, border-color 0.25s;
          display: flex; align-items: center; gap: 8px;
        }
        .cw-mm:hover {
          background: rgba(246,133,27,0.08);
          border-color: rgba(246,133,27,0.6);
        }
        .cw-dot {
          width: 6px; height: 6px; border-radius: 50%;
          background: ${isConnected ? '#0f8' : deviceStatus === 'scanning' ? '#ffb400' : '#666'};
          transition: background 0.3s;
        }
        .cw-bridge {
          position: fixed; top: 24px; right: ${isConnected ? '220px' : '200px'}; z-index: 49;
          font-family: var(--font-inter); font-size: 10px; font-weight: 300;
          color: ${bridge.connected ? 'rgba(0,255,128,0.5)' : 'rgba(255,100,100,0.5)'};
          letter-spacing: 0.05em;
          display: flex; align-items: center; gap: 4px;
        }
        .cw-bridge-dot {
          width: 4px; height: 4px; border-radius: 50%;
          background: ${bridge.connected ? '#0f8' : '#f44'};
        }
      `}</style>
      <div className="cw-bridge">
        <span className="cw-bridge-dot" />
        bridge
      </div>
      <button
        className="cw-btn"
        onClick={isConnected ? disconnect : connect}
        disabled={deviceStatus === 'scanning'}
      >
        <span className="cw-dot" />
        {label}
      </button>
      {!isConnected && (
        <button
          className="cw-mm"
          onClick={connectMetaMask}
          disabled={deviceStatus === 'scanning'}
        >
          🦊 MetaMask
        </button>
      )}
    </>
  );
}
