'use client';

import { useState, useCallback, useRef } from 'react';

export function useLedger() {
  const [deviceStatus, setDeviceStatus] = useState('disconnected'); // disconnected|scanning|connected|ready|signing
  const [walletAddress, setWalletAddress] = useState(null);
  // 'ledger' | 'metamask' | 'privy' (passkey/email account) | 'external' (wallet connected through Privy) | null
  const [connectionType, setConnectionType] = useState(null);
  const [walletLabel, setWalletLabel] = useState(null); // e.g. 'MetaMask', 'Phantom', 'Passkey'
  const typeRef = useRef(null);
  const signerRef = useRef(null);
  const providerRef = useRef(null); // EIP-1193 provider for MetaMask and Privy wallets
  const privyRef = useRef(null);    // { ready, login, logout, identityToken } while Privy is mounted
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
            typeRef.current = 'ledger';
            setWalletAddress(address);
            setConnectionType('ledger');
            setWalletLabel('Ledger');
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

  // ── MetaMask (software wallet) — login/identity without hardware ──
  const connectMetaMask = useCallback(async () => {
    try {
      const eth = typeof window !== 'undefined' ? window.ethereum : null;
      if (!eth) {
        log('MetaMask not detected — install the extension or open in its browser');
        setDeviceStatus('disconnected');
        return;
      }
      setDeviceStatus('scanning');
      log('Requesting MetaMask account…');
      const accounts = await eth.request({ method: 'eth_requestAccounts' });
      const address = accounts?.[0];
      if (!address) throw new Error('No account returned');

      providerRef.current = eth;
      typeRef.current = 'metamask';
      setWalletAddress(address);
      setConnectionType('metamask');
      setWalletLabel('MetaMask');
      setDeviceStatus('ready');
      log(`MetaMask connected: ${address}`);

      // React to account switches / disconnects in the extension.
      eth.on?.('accountsChanged', (accs) => {
        if (!accs || accs.length === 0) {
          providerRef.current = null;
          typeRef.current = null;
          setWalletAddress(null);
          setConnectionType(null);
          setWalletLabel(null);
          setDeviceStatus('disconnected');
          log('MetaMask disconnected');
        } else {
          setWalletAddress(accs[0]);
          log(`MetaMask account changed: ${accs[0]}`);
        }
      });
    } catch (err) {
      log(`MetaMask error: ${err.message}`);
      setDeviceStatus('disconnected');
    }
  }, [log]);

  // ── Privy wallets — attached by PrivyWalletSync once the user has signed in ──
  const attachWallet = useCallback(({ address, provider, type, label }) => {
    providerRef.current = provider;
    typeRef.current = type;
    setWalletAddress(address);
    setConnectionType(type);
    setWalletLabel(label);
    setDeviceStatus('ready');
    log(`${label} connected: ${address}`);
  }, [log]);

  // Only drops a Privy wallet: a Ledger or direct MetaMask connection stays.
  const detachWallet = useCallback(() => {
    if (typeRef.current !== 'privy' && typeRef.current !== 'external') return;
    providerRef.current = null;
    typeRef.current = null;
    setWalletAddress(null);
    setConnectionType(null);
    setWalletLabel(null);
    setDeviceStatus('disconnected');
  }, []);

  const setPrivy = useCallback((actions) => { privyRef.current = actions; }, []);
  const privyLogin = useCallback(() => privyRef.current?.login(), []);
  const getIdentityToken = useCallback(() => privyRef.current?.identityToken || null, []);
  const getProvider = useCallback(() => providerRef.current, []);

  const disconnect = useCallback(async () => {
    if (connectionType === 'ledger') {
      try {
        const ledger = await import('@/lib/ledger');
        await ledger.disconnectDevice();
      } catch { /* ignore */ }
    }
    if (connectionType === 'privy' || connectionType === 'external') {
      try { await privyRef.current?.logout(); } catch { /* ignore */ }
    }
    sessionRef.current = null;
    signerRef.current = null;
    providerRef.current = null;
    typeRef.current = null;
    setWalletAddress(null);
    setConnectionType(null);
    setWalletLabel(null);
    setDeviceStatus('disconnected');
    log('Disconnected');
  }, [log, connectionType]);

  const sign = useCallback(async (txBytes, onStatus) => {
    if (connectionType && connectionType !== 'ledger') {
      throw new Error('Raw transaction signing requires a Ledger. Other wallets sign and send transactions themselves.');
    }
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
  }, [log, connectionType]);

  const signTyped = useCallback(async (typedData, onStatus) => {
    if (connectionType && connectionType !== 'ledger') {
      const eth = providerRef.current;
      if (!eth) throw new Error('Wallet not available');
      setDeviceStatus('signing');
      try {
        // Orchestra's typed data (sign-in, Telegram link, Permit2) is bound to Sepolia.
        const { ensureSepolia } = await import('@/lib/signing');
        await ensureSepolia(eth);
        onStatus?.(`Confirm in ${walletLabel || 'your wallet'}`);
        const sig = await eth.request({
          method: 'eth_signTypedData_v4',
          params: [walletAddress, typeof typedData === 'string' ? typedData : JSON.stringify(typedData)],
        });
        setDeviceStatus('ready');
        return sig;
      } catch (err) {
        setDeviceStatus('ready');
        throw err;
      }
    }
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
  }, [log, connectionType, walletAddress, walletLabel]);

  return {
    deviceStatus,
    walletAddress,
    connectionType,
    walletLabel,
    logs,
    log,
    connect,
    connectMetaMask,
    attachWallet,
    detachWallet,
    setPrivy,
    privyLogin,
    getIdentityToken,
    getProvider,
    disconnect,
    sign,
    signTyped,
    setDeviceStatus,
  };
}
