'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ShieldAlert, Check, X } from 'lucide-react';
import { useOrchestra } from '@/context/OrchestraContext';

function ApprovalCard({ request, onSign, onDismiss }) {
  const [status, setStatus] = useState('pending'); // pending|signing|approved|rejected

  const handleSign = async () => {
    setStatus('signing');
    try {
      const result = await onSign(request);
      setStatus('approved');
      setTimeout(() => onDismiss(request.tradeId), 3000);
    } catch (err) {
      setStatus('rejected');
    }
  };

  const borderColor = status === 'approved' ? 'rgba(48,209,88,0.4)'
    : status === 'rejected' ? 'rgba(255,69,58,0.4)'
    : 'rgba(255,180,0,0.3)';

  return (
    <motion.div
      initial={{ opacity: 0, x: 60 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 60 }}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      style={{
        background: '#141418', border: `1px solid ${borderColor}`,
        borderRadius: 14, padding: 16, width: 320,
        fontFamily: 'var(--font-inter)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{
          fontSize: 11, padding: '2px 8px', borderRadius: 100, fontWeight: 500,
          background: 'rgba(255,180,0,0.15)', color: '#FFB400', border: '1px solid rgba(255,180,0,0.3)',
        }}>
          {request.riskLevel?.replace('_', ' ') || 'approval required'}
        </span>
        <span style={{ fontSize: 10, color: '#666' }}>
          {new Date(request.timestamp).toLocaleTimeString('en-GB', { hour12: false })}
        </span>
      </div>

      <p style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 300, color: '#E8E4DE', lineHeight: 1.5 }}>
        {request.summary}
      </p>

      <p style={{ margin: '0 0 12px', fontSize: 10, color: '#555', fontFamily: 'monospace', wordBreak: 'break-all' }}>
        {request.unsignedTxHex?.slice(0, 24)}...{request.unsignedTxHex?.slice(-16)}
      </p>

      {status === 'pending' && (
        <button
          onClick={handleSign}
          style={{
            width: '100%', padding: '8px 0', borderRadius: 8,
            background: 'rgba(192,132,252,0.12)', border: '1px solid rgba(192,132,252,0.3)',
            color: '#C084FC', fontSize: 12, fontWeight: 500, cursor: 'none',
            fontFamily: 'var(--font-inter)',
          }}
        >
          Sign on Ledger
        </button>
      )}
      {status === 'signing' && (
        <p style={{ margin: 0, fontSize: 12, color: '#C084FC', textAlign: 'center' }}>Check your Ledger device...</p>
      )}
      {status === 'approved' && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, color: '#30D158', fontSize: 12 }}>
          <Check size={14} /> Approved
        </div>
      )}
      {status === 'rejected' && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, color: '#FF453A', fontSize: 12 }}>
          <X size={14} /> Rejected
        </div>
      )}
    </motion.div>
  );
}

export default function ApprovalOverlay() {
  const { bridge, ledger } = useOrchestra();

  const handleSign = async (request) => {
    const sig = await ledger.sign(request.unsignedTxHex);
    bridge.sendResult({ tradeId: request.tradeId, approved: true, signature: sig });
    return sig;
  };

  if (bridge.approvals.length === 0) return null;

  return (
    <div style={{
      position: 'fixed', bottom: 80, right: 24, zIndex: 9998,
      display: 'flex', flexDirection: 'column', gap: 12,
    }}>
      <AnimatePresence>
        {bridge.approvals.map((req) => (
          <ApprovalCard
            key={req.tradeId}
            request={req}
            onSign={handleSign}
            onDismiss={bridge.dismissApproval}
          />
        ))}
      </AnimatePresence>
    </div>
  );
}
