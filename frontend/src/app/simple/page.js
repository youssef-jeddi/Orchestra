'use client';

// ── Simple UI (/simple) ──
// A stripped-down, single-surface chat — the minimal counterpart to the full
// presentation app at "/". Reuses the same context, bridge client, and policy
// response shape; adds no new plumbing.

import { useState, useRef, useEffect, useCallback } from 'react';
import { OrchestraProvider, useOrchestra } from '@/context/OrchestraContext';
import { sendIntent, getPrices, getPasskeyStatus } from '@/lib/bridge';
import { executeSwap, executeSend } from '@/lib/signing';
import { registerPasskey, approveWithPasskey } from '@/lib/passkey';

const ACCENT = '#C084FC';

const VERDICT_COLOR = {
  AUTO_EXECUTE: '#30D158',
  NEEDS_APPROVAL: '#FFB400',
  INFO: '#007AFF',
  BLOCKED: '#FF453A',
};

const RULE_LABELS = {
  'daily-limit': 'Daily limit',
  'daily-count-velocity': 'Daily tx count',
  'unverified-token': 'Unverified token',
  'unknown-recipient': 'Unknown recipient',
  'habit-anomaly': 'Unusual size',
  'unknown-intent': 'Unrecognized action',
  malformed: 'Malformed plan',
  denylist: 'Denylisted token',
};

const EXAMPLES = [
  'What is my balance?',
  'Swap 2 USDC for ETH',
  'Send 5 USDC to 0xd8dA…6045',
];

export default function SimplePage() {
  return (
    <OrchestraProvider>
      <SimpleChat />
    </OrchestraProvider>
  );
}

function SimpleChat() {
  const { ledger } = useOrchestra();
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, busy]);

  const [signingIdx, setSigningIdx] = useState(null);
  const [prices, setPrices] = useState(null);
  const [passkeyReg, setPasskeyReg] = useState(false);

  // Check passkey registration when a wallet connects.
  useEffect(() => {
    if (!ledger.walletAddress) { setPasskeyReg(false); return; }
    getPasskeyStatus(ledger.walletAddress).then((d) => setPasskeyReg(!!d.registered)).catch(() => {});
  }, [ledger.walletAddress]);

  // Live price ticker — refresh every 60s.
  useEffect(() => {
    let alive = true;
    const load = () => getPrices().then((d) => { if (alive) setPrices(d.prices); }).catch(() => {});
    load();
    const id = setInterval(load, 60000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const send = useCallback(async (raw) => {
    const text = (raw ?? input).trim();
    if (!text || busy) return;
    setInput('');
    setMessages((m) => [...m, { role: 'user', text }]);
    setBusy(true);
    try {
      const data = await sendIntent(text, ledger.walletAddress);
      setMessages((m) => [...m, { role: 'agent', data }]);
    } catch (err) {
      setMessages((m) => [...m, { role: 'agent', error: err.message }]);
    } finally {
      setBusy(false);
    }
  }, [input, busy, ledger.walletAddress]);

  // Approve/execute a swap or send from an agent card.
  const execute = useCallback(async (data, idx) => {
    if (!ledger.walletAddress) {
      setMessages((m) => [...m, { role: 'agent', error: 'Connect a wallet first.' }]);
      return;
    }
    setSigningIdx(idx);
    try {
      const result = data.quoteData
        ? await executeSwap(ledger, data)
        : await executeSend(ledger, data);
      if (result.orderId) {
        setMessages((m) => [...m, { role: 'system', text: `UniswapX order submitted: ${result.orderId.slice(0, 16)}…` }]);
      } else {
        setMessages((m) => [...m, { role: 'system', txHash: result.txHash, explorerUrl: result.explorerUrl }]);
      }
    } catch (err) {
      setMessages((m) => [...m, { role: 'agent', error: err.message }]);
    } finally {
      setSigningIdx(null);
    }
  }, [ledger]);

  // Approve + execute with a passkey (biometric) instead of signing directly.
  const approvePasskey = useCallback(async (data, idx) => {
    if (!ledger.walletAddress) {
      setMessages((m) => [...m, { role: 'agent', error: 'Connect a wallet first.' }]);
      return;
    }
    setSigningIdx(idx);
    try {
      const payload = data.quoteData ? { quoteData: data.quoteData } : { sendData: data.sendData };
      const result = await approveWithPasskey(ledger.walletAddress, payload);
      setMessages((m) => [...m, { role: 'system', txHash: result.txHash, explorerUrl: result.explorerUrl }]);
    } catch (err) {
      setMessages((m) => [...m, { role: 'agent', error: err.message }]);
    } finally {
      setSigningIdx(null);
    }
  }, [ledger.walletAddress]);

  const registerPk = useCallback(async () => {
    if (!ledger.walletAddress) return;
    try {
      await registerPasskey(ledger.walletAddress);
      setPasskeyReg(true);
    } catch (err) {
      setMessages((m) => [...m, { role: 'agent', error: `Passkey registration failed: ${err.message}` }]);
    }
  }, [ledger.walletAddress]);

  const connected = !!ledger.walletAddress;

  return (
    <div style={{
      cursor: 'auto', minHeight: '100dvh', display: 'flex', flexDirection: 'column',
      maxWidth: 720, margin: '0 auto', padding: '0 16px', fontFamily: 'var(--font-inter)',
    }}>
      {/* Header */}
      <header style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '18px 0', position: 'sticky', top: 0, background: '#0F0F12', zIndex: 10,
        borderBottom: '1px solid #1c1c22',
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontFamily: 'var(--font-playfair)', fontSize: 20, color: '#E8E4DE' }}>Orchestra</span>
          <span style={{ fontSize: 11, color: '#555' }}>lite</span>
          {prices?.ETH && (
            <span style={{ fontSize: 11, color: '#777', marginLeft: 4 }} title="Live price">
              · ETH ${Number(prices.ETH).toLocaleString(undefined, { maximumFractionDigits: 2 })}
            </span>
          )}
        </div>
        {connected ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {passkeyReg
              ? <span style={{ fontSize: 11, color: '#30D158' }} title="Passkey registered">🔑 passkey</span>
              : <button onClick={registerPk} style={pill(false)} title="Register a device passkey">🔑 Add passkey</button>}
            <button onClick={ledger.disconnect} style={pill(false)} title="Disconnect">
              <span style={{ width: 6, height: 6, borderRadius: 3, background: '#30D158', display: 'inline-block' }} />
              {ledger.connectionType === 'metamask' ? '🦊 ' : ''}
              {ledger.walletAddress.slice(0, 6)}…{ledger.walletAddress.slice(-4)}
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={ledger.connect} style={pill(false)}>Ledger</button>
            <button onClick={ledger.connectMetaMask} style={pill(true)}>🦊 MetaMask</button>
          </div>
        )}
      </header>

      {/* Messages */}
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 16, padding: '24px 0' }}>
        {messages.length === 0 && (
          <div style={{ margin: 'auto', textAlign: 'center', color: '#666' }}>
            <p style={{ fontSize: 22, color: '#E8E4DE', fontWeight: 300, marginBottom: 20 }}>
              What do you want to do?
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center' }}>
              {EXAMPLES.map((ex) => (
                <button key={ex} onClick={() => send(ex)} style={{
                  ...pill(false), fontSize: 13, color: '#999',
                }}>
                  {ex}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <MessageRow key={i} m={m} idx={i} onExecute={execute} onPasskey={approvePasskey}
            passkeyReg={passkeyReg} signing={signingIdx === i} />
        ))}
        {busy && <div style={{ color: '#666', fontSize: 13, paddingLeft: 4 }}>Thinking…</div>}
        <div ref={endRef} />
      </main>

      {/* Input */}
      <div style={{ position: 'sticky', bottom: 0, background: '#0F0F12', paddingBottom: 20 }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '6px 6px 6px 16px',
          border: '1px solid #2a2a30', borderRadius: 14, background: '#141418',
        }}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
            placeholder="Message Orchestra…"
            style={{
              flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none',
              color: '#E8E4DE', fontSize: 15, fontFamily: 'var(--font-inter)', cursor: 'text',
            }}
          />
          <button
            onClick={() => send()}
            disabled={busy || !input.trim()}
            style={{
              border: 'none', borderRadius: 10, padding: '9px 16px', cursor: 'pointer',
              background: input.trim() ? ACCENT : '#2a2a30', color: input.trim() ? '#0F0F12' : '#666',
              fontFamily: 'var(--font-inter)', fontSize: 14, fontWeight: 500,
            }}
          >
            Send
          </button>
        </div>
        {!connected && (
          <p style={{ fontSize: 11, color: '#555', textAlign: 'center', margin: '8px 0 0' }}>
            Connect a wallet for balance queries and to enforce your guardrails.
          </p>
        )}
      </div>
    </div>
  );
}

function MessageRow({ m, idx, onExecute, onPasskey, passkeyReg, signing }) {
  if (m.role === 'user') {
    return (
      <div style={{ alignSelf: 'flex-end', maxWidth: '80%', background: '#242430', color: '#E8E4DE',
        padding: '10px 14px', borderRadius: '14px 14px 4px 14px', fontSize: 15 }}>
        {m.text}
      </div>
    );
  }
  if (m.error) {
    return (
      <div style={{ alignSelf: 'flex-start', maxWidth: '90%', color: '#FF453A', fontSize: 14,
        border: '1px solid #FF453A44', borderRadius: 12, padding: '10px 14px', background: '#FF453A11' }}>
        {m.error}
      </div>
    );
  }
  if (m.role === 'system') {
    return (
      <div style={{ alignSelf: 'flex-start', maxWidth: '90%', color: '#30D158', fontSize: 14,
        border: '1px solid #30D15844', borderRadius: 12, padding: '10px 14px', background: '#30D15811' }}>
        {m.txHash
          ? <a href={m.explorerUrl} target="_blank" rel="noreferrer" style={{ color: '#30D158', textDecoration: 'none' }}>
              ✓ Executed — {m.txHash.slice(0, 18)}… ↗
            </a>
          : m.text}
      </div>
    );
  }
  return (
    <AgentCard
      data={m.data}
      onExecute={() => onExecute(m.data, idx)}
      onPasskey={() => onPasskey(m.data, idx)}
      passkeyReg={passkeyReg}
      signing={signing}
    />
  );
}

function AgentCard({ data, onExecute, onPasskey, passkeyReg, signing }) {
  const verdict = data.assessment?.verdict || 'UNKNOWN';
  const color = VERDICT_COLOR[verdict] || '#666';
  const triggered = data.assessment?.triggered || [];
  const needsSign = !data.autoExecuted && (data.quoteData || data.sendData);
  const isSwap = !!data.quoteData;
  const method = data.assessment?.approvalMethod; // 'passkey' | 'ledger' | 'none'
  const usePasskey = needsSign && method === 'passkey' && passkeyReg;

  return (
    <div style={{ alignSelf: 'flex-start', maxWidth: '92%', display: 'flex', flexDirection: 'column', gap: 10,
      background: '#141418', border: '1px solid #222228', borderRadius: 14, padding: 16 }}>

      {/* Plan summary */}
      {data.plan?.summary && (
        <p style={{ margin: 0, fontSize: 15, color: '#E8E4DE' }}>
          {data.plan.summary}
          {data.plan.totalEstimatedValueUsd > 0 && (
            <span style={{ color: '#777' }}> — ${data.plan.totalEstimatedValueUsd}</span>
          )}
        </p>
      )}

      {/* Balance card */}
      {data.intentType === 'balance' && data.balances && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {[
            { label: 'ETH', value: data.balances.eth?.toFixed(4) },
            { label: 'WETH', value: data.balances.weth?.toFixed(4) },
            { label: 'USDC', value: data.balances.usdc?.toFixed(2) },
          ].map((t) => (
            <div key={t.label} style={{ flex: '1 1 80px', padding: '10px 12px', background: 'rgba(255,255,255,0.03)',
              borderRadius: 10, border: '1px solid rgba(255,255,255,0.06)' }}>
              <span style={{ fontSize: 11, color: '#666' }}>{t.label}</span>
              <p style={{ margin: '2px 0 0', fontSize: 16, color: '#E8E4DE' }}>{t.value ?? '—'}</p>
            </div>
          ))}
        </div>
      )}

      {/* Reasoning (compact) */}
      {data.agentReasoning?.gatekeeper && (
        <p style={{ margin: 0, fontSize: 13, color: '#999', lineHeight: 1.5 }}>
          {data.agentReasoning.gatekeeper}
        </p>
      )}

      {/* Verdict + rule chips */}
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <span style={{ padding: '3px 10px', borderRadius: 100, fontSize: 11, fontWeight: 500,
          background: `${color}22`, color, border: `1px solid ${color}44` }}>
          {verdict.replace('_', ' ')}
        </span>
        {triggered.map((slug) => (
          <span key={slug} style={{ fontSize: 10, padding: '2px 8px', borderRadius: 100,
            background: `${color}18`, color, border: `1px solid ${color}33` }}>
            {RULE_LABELS[slug] || slug}
          </span>
        ))}
      </div>

      {/* Outcome */}
      {data.autoExecuted && data.txHash && (
        <a href={data.explorerUrl} target="_blank" rel="noreferrer"
          style={{ fontSize: 13, color: '#30D158', textDecoration: 'none' }}>
          ✓ Executed — view on Etherscan ↗
        </a>
      )}
      {needsSign && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 2 }}>
          {usePasskey ? (
            <button onClick={onPasskey} disabled={signing} style={approveBtn(signing)}>
              {signing ? 'Confirm on your device…' : '🔑 Approve with passkey'}
            </button>
          ) : (
            <button onClick={onExecute} disabled={signing} style={approveBtn(signing)}>
              {signing ? 'Check your wallet…' : (isSwap ? 'Approve & Swap' : 'Approve & Send')}
            </button>
          )}
          {method === 'passkey' && !passkeyReg && (
            <span style={{ fontSize: 11, color: '#777' }}>
              Tip: add a passkey (top-right) to approve with your fingerprint instead.
            </span>
          )}
          {method === 'ledger' && (
            <span style={{ fontSize: 11, color: '#FFB400' }}>
              High-value — requires a Ledger hardware signature.
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function approveBtn(signing) {
  return {
    padding: '10px 16px', borderRadius: 10, cursor: signing ? 'default' : 'pointer',
    background: signing ? 'rgba(192,132,252,0.1)' : 'rgba(192,132,252,0.15)',
    border: '1px solid rgba(192,132,252,0.35)', color: ACCENT,
    fontFamily: 'var(--font-inter)', fontSize: 13, fontWeight: 500, opacity: signing ? 0.7 : 1,
  };
}

function pill(accent) {
  return {
    display: 'flex', alignItems: 'center', gap: 6,
    background: 'transparent', cursor: 'pointer',
    border: `1px solid ${accent ? 'rgba(246,133,27,0.4)' : 'rgba(255,255,255,0.15)'}`,
    borderRadius: 100, padding: '7px 14px',
    fontFamily: 'var(--font-inter)', fontSize: 13, color: '#E8E4DE',
  };
}
