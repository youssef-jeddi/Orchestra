'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { BRIDGE_WS } from '@/lib/bridge';

export function useBridge() {
  const [connected, setConnected] = useState(false);
  const [approvals, setApprovals] = useState([]);
  const wsRef = useRef(null);

  const connectWs = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(BRIDGE_WS);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'APPROVAL_REQUIRED') {
          setApprovals((prev) => [msg.payload, ...prev]);
        }
      } catch { /* ignore bad messages */ }
    };

    ws.onclose = () => {
      setConnected(false);
      setTimeout(connectWs, 3000);
    };

    ws.onerror = () => { /* will trigger onclose */ };
  }, []);

  useEffect(() => {
    connectWs();
    return () => {
      if (wsRef.current) {
        wsRef.current.onclose = null; // prevent reconnect on cleanup
        wsRef.current.close();
      }
    };
  }, [connectWs]);

  const sendResult = useCallback((result) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'APPROVAL_RESULT', payload: result }));
    }
  }, []);

  const dismissApproval = useCallback((tradeId) => {
    setApprovals((prev) => prev.filter((a) => a.tradeId !== tradeId));
  }, []);

  return { connected, approvals, sendResult, dismissApproval };
}
