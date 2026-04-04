'use client';

import { useState, useCallback, useRef } from 'react';

export function useLedger() {
  const [deviceStatus, setDeviceStatus] = useState('disconnected'); // disconnected|scanning|connected|ready|signing
  const [walletAddress, setWalletAddress] = useState(null);
  const signerRef = useRef(null);
  const sessionRef = useRef(null);
  const logsRef = useRef([]);
  const [logs, setLogs] = useState([]);

  const log = useCallback((msg) => {
    const entry = { time: new Date().toLocaleTimeString('en-GB', { hour12: false }), msg };
    logsRef.current = [...logsRef.current, entry];
    setLogs([...logsRef.current]);
    console.log(`[ledger] ${msg}`);
  }, []);

  const connect = useCallback(async () => {
    try {
      setDeviceStatus('scanning');
      log('Starting device discovery...');

      const ledger = await import('@/lib/ledger');
      ledger.initDMK();
      log('DMK initialized');

      ledger.discoverDevices(
        async (device) => {
          if (sessionRef.current) return; // already connected

          const modelName = device?.deviceModel?.productName || device?.deviceModel?.model || 'Ledger';
          log(`Found: ${modelName}`);
          setDeviceStatus('connected');
          ledger.stopDiscovering();

          try {
            const sessionId = await ledger.connectDevice(device.id);
            sessionRef.current = sessionId;
            log(`Session: ${sessionId}`);

            const signer = await ledger.createSigner(sessionId);
            signerRef.current = signer;
            const address = await ledger.getAddress(signer);
            setWalletAddress(address);
            log(`Address: ${address}`);

            // Try to open Uniswap app for clear signing
            try {
              await ledger.openApp('Uniswap', sessionId, (s) => log(`App: ${s}`));
              log('Uniswap app opened (clear signing)');
            } catch {
              log('Uniswap app unavailable, using Ethereum app');
            }

            setDeviceStatus('ready');
            log('Device READY');
          } catch (err) {
            log(`Connection error: ${err.message}`);
            setDeviceStatus('disconnected');
            sessionRef.current = null;
          }
        },
        (err) => {
          log(`Discovery error: ${err.message}`);
          setDeviceStatus('disconnected');
        }
      );
    } catch (err) {
      log(`Init error: ${err.message}`);
      setDeviceStatus('disconnected');
    }
  }, [log]);

  const disconnect = useCallback(async () => {
    try {
      const ledger = await import('@/lib/ledger');
      await ledger.disconnectDevice();
    } catch { /* ignore */ }
    sessionRef.current = null;
    signerRef.current = null;
    setWalletAddress(null);
    setDeviceStatus('disconnected');
    log('Disconnected');
  }, [log]);

  const sign = useCallback(async (txBytes, onStatus) => {
    if (!signerRef.current) throw new Error('No signer — connect Ledger first');
    setDeviceStatus('signing');
    try {
      const ledger = await import('@/lib/ledger');
      const sig = await ledger.requestSignature(signerRef.current, txBytes, (s) => {
        onStatus?.(s);
        log(`Sign: ${s}`);
      });
      setDeviceStatus('ready');
      return sig;
    } catch (err) {
      setDeviceStatus('ready');
      throw err;
    }
  }, [log]);

  const signTyped = useCallback(async (typedData, onStatus) => {
    if (!signerRef.current) throw new Error('No signer — connect Ledger first');
    setDeviceStatus('signing');
    try {
      const ledger = await import('@/lib/ledger');
      const sig = await ledger.signTypedData(signerRef.current, typedData, (s) => {
        onStatus?.(s);
        log(`SignTyped: ${s}`);
      });
      setDeviceStatus('ready');
      return sig;
    } catch (err) {
      setDeviceStatus('ready');
      throw err;
    }
  }, [log]);

  return {
    deviceStatus,
    walletAddress,
    logs,
    log,
    connect,
    disconnect,
    sign,
    signTyped,
    setDeviceStatus,
  };
}
