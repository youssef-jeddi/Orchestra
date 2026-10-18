'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { BRIDGE_WS, getSessionToken } from '@/lib/bridge';

// The live channel for approvals sent to this wallet. Nothing is opened or sent before sign-in:
// once signed in, the first message is { type: 'AUTH', token } (the session token, never in the
// URL), and `connected` turns true when the server accepts it. A new wallet or session reconnects.
const RECONNECT_MS = 3000;
const SESSION_CLOSE_CODE = 4401; // the server refused our session: don't retry until the next sign-in

export function useBridge(walletAddress, signedIn) {
  const [connected, setConnected] = useState(false);
  const [approvals, setApprovals] = useState([]);
  const wsRef = useRef(null);

  useEffect(() => {
    if (!signedIn || !walletAddress) return undefined;
    let stopped = false;
    let retry;

    const connect = () => {
      const token = getSessionToken();
      if (stopped || !token) return;
      const ws = new WebSocket(BRIDGE_WS);
      wsRef.current = ws;

      ws.onopen = () => ws.send(JSON.stringify({ type: 'AUTH', token }));

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'AUTH_OK') setConnected(true);
          if (msg.type === 'APPROVAL_REQUIRED') setApprovals((prev) => [msg.payload, ...prev]);
        } catch { /* ignore bad messages */ }
      };

      ws.onclose = (event) => {
        setConnected(false);
        if (!stopped && event.code !== SESSION_CLOSE_CODE) retry = setTimeout(connect, RECONNECT_MS);
      };

      ws.onerror = () => { /* will trigger onclose */ };
    };
    connect();

    return () => {
      stopped = true;
      clearTimeout(retry);
      if (wsRef.current) wsRef.current.close();
      wsRef.current = null;
      setConnected(false);
      setApprovals([]); // another wallet's approvals must not linger
    };
  }, [walletAddress, signedIn]);

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
