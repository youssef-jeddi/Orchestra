'use client';

// ── Simple UI (/simple) ──
// A stripped-down, single-surface chat — the minimal counterpart to the full
// presentation app at "/". Reuses the same context, bridge client, and policy
// response shape; adds no new plumbing.

import { useState, useRef, useEffect, useCallback } from 'react';
import { OrchestraProvider, useOrchestra } from '@/context/OrchestraContext';
import {
  sendIntent, getPrices, getPasskeyStatus, getApproval,
  getTelegramStatus, telegramLinkRequest, telegramLink, requestPhoneSetup,
} from '@/lib/bridge';
import { executeSwap, executeSend } from '@/lib/signing';
import { registerPasskey, approveWithPasskey } from '@/lib/passkey';
import { PRIVY_APP_ID } from '@/lib/privy';

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
  'What can you do?',
  'What is my balance?',
  "What's the price of ETH?",
  'Swap 2 USDC for ETH',
  'Send 5 USDC to vitalik.eth',
  'Fund my Safe with 0.01 ETH',
  'Show my liquidity positions',
];

// Statuses answered with plain text instead of a plan card.
const TEXT_STATUSES = new Set(['reply', 'needs_clarification', 'unsupported']);
const HISTORY_TURNS = 8;

function agentText(data) {
  if (!data) return '';
  return data.reply || data.question || data.reason || data.plan?.summary || '';
}

/** Recent turns in the shape the planner expects, so answers to its questions carry context. */
function toHistory(messages) {
  return messages
    .filter((m) => m.role === 'user' || (m.role === 'agent' && m.data))
    .map((m) => (m.role === 'user'
      ? { role: 'user', content: m.text }
      : { role: 'assistant', content: agentText(m.data) }))
    .filter((t) => t.content)
    .slice(-HISTORY_TURNS);
}

export default function SimplePage() {
  return (
    <OrchestraProvider>
      <SimpleChat />
    </OrchestraProvider>
  );
}

function SimpleChat() {
  const { ledger, safe, session } = useOrchestra();
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

  // Check passkey registration when a wallet connects, and again once signed in:
  // a Privy sign-in passkey becomes the approval passkey during sign-in.
  useEffect(() => {
    if (!ledger.walletAddress) { setPasskeyReg(false); return; }
    getPasskeyStatus(ledger.walletAddress).then((d) => setPasskeyReg(!!d.registered)).catch(() => {});
  }, [ledger.walletAddress, session.ready]);

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
    // A connected wallet must be signed in: the server only acts for a wallet that proved ownership.
    if (ledger.walletAddress && !session.ready) {
      setMessages((m) => [...m, { role: 'user', text }, {
        role: 'agent',
        error: session.status === 'signing' ? 'Finish signing in with your wallet first.' : 'Sign in with your wallet first (button at the top).',
      }]);
      setInput('');
      return;
    }
    setInput('');
    const history = toHistory(messages);
    setMessages((m) => [...m, { role: 'user', text }]);
    setBusy(true);
    try {
      const data = await sendIntent(text, ledger.walletAddress, { history });
      setMessages((m) => [...m, { role: 'agent', data }]);
    } catch (err) {
      setMessages((m) => [...m, { role: 'agent', error: err.message }]);
    } finally {
      setBusy(false);
    }
  }, [input, busy, messages, ledger.walletAddress, session.ready, session.status]);

  // Approve/execute a swap, send or Safe deposit from an agent card.
  const execute = useCallback(async (data, idx) => {
    if (!ledger.walletAddress) {
      setMessages((m) => [...m, { role: 'agent', error: 'Connect a wallet first.' }]);
      return;
    }
    setSigningIdx(idx);
    try {
      const result = data.depositData
        ? await safe.deposit(data.depositData.symbol.toLowerCase(), data.depositData.amount)
        : data.quoteData
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
  }, [ledger, safe]);

  // Approve + execute with a passkey (biometric) instead of signing directly.
  const approvePasskey = useCallback(async (data, idx) => {
    if (!ledger.walletAddress) {
      setMessages((m) => [...m, { role: 'agent', error: 'Connect a wallet first.' }]);
      return;
    }
    if (!data.approval?.id) {
      setMessages((m) => [...m, { role: 'agent', error: 'This action has no server-held approval. Ask again.' }]);
      return;
    }
    setSigningIdx(idx);
    try {
      const result = await approveWithPasskey(ledger.walletAddress, data.approval.id);
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
            {!session.ready && (
              <button onClick={session.signIn} disabled={session.status === 'signing'} style={pill(true)}
                title={session.error || 'Prove you own this wallet (free, no transaction)'}>
                {session.status === 'signing' ? 'Check your wallet…' : '✍️ Sign in'}
              </button>
            )}
            <TelegramLink ledger={ledger} session={session} onError={(msg) => setMessages((m) => [...m, { role: 'agent', error: msg }])} />
            {session.ready && (passkeyReg
              ? <span style={{ fontSize: 11, color: '#30D158' }} title="Passkey registered">🔑 passkey</span>
              : <button onClick={registerPk} style={pill(false)} title="Register a device passkey">🔑 Add passkey</button>)}
            <button onClick={ledger.disconnect} style={pill(false)} title="Disconnect">
              <span style={{ width: 6, height: 6, borderRadius: 3, background: '#30D158', display: 'inline-block' }} />
              {ledger.connectionType === 'metamask' ? '🦊 ' : ledger.connectionType === 'privy' ? '🔑 ' : ''}
              {ledger.walletAddress.slice(0, 6)}…{ledger.walletAddress.slice(-4)}
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={ledger.connect} style={pill(false)}>Ledger</button>
            {PRIVY_APP_ID
              ? <button onClick={ledger.privyLogin} style={pill(true)} title="Passkey, email, or the wallet you already have">Sign in</button>
              : <button onClick={ledger.connectMetaMask} style={pill(true)}>🦊 MetaMask</button>}
          </div>
        )}
      </header>

      {connected && session.ready && <SafeSetup safe={safe} ledger={ledger} onError={(msg) => setMessages((m) => [...m, { role: 'agent', error: msg }])} />}

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
  if (TEXT_STATUSES.has(m.data?.status)) {
    return <AgentText data={m.data} />;
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

function AgentText({ data }) {
  const unsupported = data.status === 'unsupported';
  return (
    <div style={{ alignSelf: 'flex-start', maxWidth: '85%', display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{
        background: '#141418', border: `1px solid ${unsupported ? '#3a2a2a' : '#222228'}`,
        color: unsupported ? '#C9A9A9' : '#E8E4DE', padding: '10px 14px',
        borderRadius: '14px 14px 14px 4px', fontSize: 15, lineHeight: 1.5, whiteSpace: 'pre-line',
      }}>
        {agentText(data)}
      </div>
      <Timing timing={data.timing} />
    </div>
  );
}

function Timing({ timing }) {
  if (!timing?.totalMs) return null;
  return (
    <span style={{ fontSize: 10, color: '#555', paddingLeft: 4 }}>
      {(timing.totalMs / 1000).toFixed(1)}s{timing.model ? ` · ${timing.model}` : ''}
    </span>
  );
}

function AgentCard({ data, onExecute, onPasskey, passkeyReg, signing }) {
  const verdict = data.assessment?.verdict || 'UNKNOWN';
  const color = VERDICT_COLOR[verdict] || '#666';
  const triggered = data.assessment?.triggered || [];
  const needsSign = !data.autoExecuted && (data.quoteData || data.sendData || data.depositData || data.lpData || data.lpRemoveData);
  const isSwap = !!data.quoteData;
  const isDeposit = !!data.depositData;
  // Liquidity is added from the Safe, so it can only be approved through a server-held
  // approval (passkey / Telegram) — there is no "sign it in your wallet" path.
  const isLp = !!(data.lpData || data.lpRemoveData);
  const method = data.assessment?.approvalMethod; // 'passkey' | 'ledger' | 'none'
  const usePasskey = needsSign && (method === 'passkey' || method === 'ledger') && passkeyReg && !!data.approval?.id;

  return (
    <div style={{ alignSelf: 'flex-start', maxWidth: '92%', display: 'flex', flexDirection: 'column', gap: 10,
      background: '#141418', border: '1px solid #222228', borderRadius: 14, padding: 16 }}>

      {/* Plan summary */}
      {data.plan?.summary && (
        <p style={{ margin: 0, fontSize: 15, color: '#E8E4DE', whiteSpace: 'pre-line', overflowWrap: 'anywhere' }}>
          {data.plan.summary}
          {data.plan.totalEstimatedValueUsd > 0 && (
            <span style={{ color: '#777' }}> — ${Number(data.plan.totalEstimatedValueUsd).toFixed(2)}</span>
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
      {needsSign && data.approval?.channel === 'telegram' && <TelegramWait approval={data.approval} />}
      {needsSign && data.approval?.channel !== 'telegram' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 2 }}>
          {usePasskey ? (
            <button onClick={onPasskey} disabled={signing} style={approveBtn(signing)}>
              {signing ? 'Confirm on your device…' : '🔑 Approve with passkey'}
            </button>
          ) : isLp ? (
            <span style={{ fontSize: 13, color: '#999', lineHeight: 1.5 }}>
              Liquidity runs from your Safe: approve it with a passkey (add one top-right) or link Telegram, then ask again.
            </span>
          ) : (
            <button onClick={onExecute} disabled={signing} style={approveBtn(signing)}>
              {signing ? 'Check your wallet…' : (isDeposit ? 'Sign deposit' : isSwap ? 'Approve & Swap' : 'Approve & Send')}
            </button>
          )}
          {method === 'passkey' && !passkeyReg && !isLp && (
            <span style={{ fontSize: 11, color: '#777' }}>
              Tip: add a passkey (top-right) to approve with your fingerprint instead.
            </span>
          )}
          {method === 'ledger' && (
            <span style={{ fontSize: 11, color: '#777' }}>
              Ledger is paused — approve with a passkey or your wallet instead.
            </span>
          )}
        </div>
      )}
      <Timing timing={data.timing} />
    </div>
  );
}

// An approval sent to the user's phone: poll the server until it's settled there.
function TelegramWait({ approval }) {
  const [state, setState] = useState(approval);

  useEffect(() => {
    if (!['pending', 'executing'].includes(state.status)) return;
    const id = setTimeout(() => {
      getApproval(approval.id).then(setState).catch(() => setState((s) => ({ ...s })));
    }, 2000);
    return () => clearTimeout(id);
  }, [state, approval.id]);

  const text = {
    pending: approval.factor === 'phone-passkey'
      ? '📱 Sent to your Telegram. Tap “Review & approve” on your phone and confirm with its passkey.'
      : '📱 Sent to your Telegram. Check the details there and approve or reject.',
    executing: '⏳ Approved on your phone. Executing…',
    rejected: '🚫 Rejected on your phone. Nothing was executed.',
    expired: '⌛ Expired. Nothing was executed.',
    failed: `❌ Execution failed: ${state.error || 'unknown error'}`,
  }[state.status];

  if (state.status === 'executed') {
    return (
      <a href={state.explorerUrl} target="_blank" rel="noreferrer"
        style={{ fontSize: 13, color: '#30D158', textDecoration: 'none' }}>
        ✓ Approved on your phone and executed. View on Etherscan ↗
      </a>
    );
  }
  return <span style={{ fontSize: 13, color: state.status === 'failed' ? '#FF453A' : '#999' }}>{text}</span>;
}

// Link a Telegram chat: the wallet signs a one-time code, then the user presses Start in Telegram.
function TelegramLink({ ledger, session, onError }) {
  const [status, setStatus] = useState(null); // { enabled, linked, username }
  const [url, setUrl] = useState(null);
  const [busy, setBusy] = useState(false);
  const wallet = ledger.walletAddress;

  const refresh = useCallback(() => {
    if (!wallet) return;
    getTelegramStatus(wallet).then(setStatus).catch(() => {});
  }, [wallet]);

  useEffect(() => { refresh(); }, [refresh]);

  // While the t.me link is out, poll until the chat has pressed Start.
  useEffect(() => {
    if (!url || status?.linked) return;
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, [url, status?.linked, refresh]);

  if (!status?.enabled) return null;
  if (status.linked) {
    const who = status.username ? `@${status.username}` : 'Telegram';
    if (status.phonePasskey) {
      return <span style={{ fontSize: 11, color: '#30D158' }} title="Risky transactions are confirmed on your phone with its passkey">📱 {who} · 🔐 phone passkey</span>;
    }
    return (
      <>
        <span style={{ fontSize: 11, color: '#30D158' }} title="Risky transactions are approved in Telegram">📱 {who}</span>
        {status.phoneAvailable && <PhoneSetupButton session={session} onDone={refresh} onError={onError} />}
      </>
    );
  }
  if (url) {
    return (
      <a href={url} target="_blank" rel="noreferrer" style={{ ...pill(true), textDecoration: 'none' }}>
        📱 Open Telegram and press Start
      </a>
    );
  }

  const link = async () => {
    setBusy(true);
    try {
      const { code, typedData } = await telegramLinkRequest(wallet);
      const sig = await ledger.signTyped(typedData);
      const { ethers } = await import('ethers');
      // Ledger returns {v,r,s}; MetaMask returns a serialized hex string.
      const signature = typeof sig === 'string' ? sig : ethers.Signature.from({ v: sig.v, r: sig.r, s: sig.s }).serialized;
      const res = await telegramLink(wallet, code, signature);
      setUrl(res.url);
    } catch (err) {
      onError(`Telegram link failed: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button onClick={link} disabled={busy} style={pill(false)} title="Approve risky transactions from your phone">
      {busy ? 'Check your wallet…' : '📱 Link Telegram'}
    </button>
  );
}

// Ask the server to send a one-time phone passkey setup link to Telegram, then
// poll until the phone has registered it.
function PhoneSetupButton({ session, onDone, onError }) {
  const [state, setState] = useState('idle'); // idle | sending | sent

  useEffect(() => {
    if (state !== 'sent') return;
    const id = setInterval(onDone, 3000);
    const stop = setTimeout(() => setState('idle'), 10 * 60_000); // the link expires
    return () => { clearInterval(id); clearTimeout(stop); };
  }, [state, onDone]);

  const send = async () => {
    setState('sending');
    try {
      // Setting up a phone passkey needs a wallet session: sign in first if there
      // isn't one, and once more if the server says it has expired meanwhile.
      if (!(await session.ensure())) throw new Error('Sign in with your wallet to set up the phone passkey.');
      try {
        await requestPhoneSetup();
      } catch (err) {
        if (err.code !== 'session_required' || !(await session.signIn())) throw err;
        await requestPhoneSetup();
      }
      setState('sent');
    } catch (err) {
      onError(`Phone setup failed: ${err.message}`);
      setState('idle');
    }
  };

  if (state === 'sent') return <span style={{ fontSize: 11, color: '#999' }}>📲 Open the link in Telegram on your phone…</span>;
  return (
    <button onClick={send} disabled={state === 'sending'} style={pill(false)}
      title="Confirm risky transactions on your phone with a passkey, after seeing exactly what executes">
      {state === 'sending' ? 'Sending…' : '🔐 Set up phone passkey'}
    </button>
  );
}

function SafeSetup({ safe, ledger, onError }) {
  const [busy, setBusy] = useState(null); // 'deploy' | 'eth' | 'usdc' | null

  const deploy = async () => {
    setBusy('deploy');
    try { await safe.deploy(100); }
    catch (err) { onError(err.message); }
    finally { setBusy(null); }
  };

  const fund = async (token, amount) => {
    setBusy(token);
    try {
      await safe.deposit(token, amount);
      setTimeout(() => safe.refreshBalances(), 4000);
    } catch (err) { onError(err.message); }
    finally { setBusy(null); }
  };

  if (safe.safeStatus === 'checking' || safe.safeStatus === 'unknown') {
    return <p style={{ fontSize: 12, color: '#555', margin: '10px 0 0' }}>Looking for a Safe…</p>;
  }

  if (safe.safeStatus !== 'deployed') {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        marginTop: 12, padding: '10px 12px', border: '1px solid #2a2a30', borderRadius: 12, background: '#141418',
      }}>
        <p style={{ margin: 0, fontSize: 13, color: '#999', lineHeight: 1.4 }}>
          Auto-execute needs a Safe. Create one (agent wallet pays gas), then fund it from MetaMask.
        </p>
        <button onClick={deploy} disabled={!!busy} style={pill(true)}>
          {busy === 'deploy' ? 'Creating…' : 'Create Safe'}
        </button>
      </div>
    );
  }

  const b = safe.balances || {};
  return (
    <div style={{
      display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10,
      marginTop: 12, padding: '10px 12px', border: '1px solid #1c1c22', borderRadius: 12,
    }}>
      <a href={`https://sepolia.etherscan.io/address/${safe.safeAddress}`} target="_blank" rel="noreferrer"
        style={{ fontSize: 12, color: '#999', textDecoration: 'none' }}>
        Safe {safe.safeAddress.slice(0, 6)}…{safe.safeAddress.slice(-4)} ↗
      </a>
      <span style={{ fontSize: 12, color: '#777' }}>
        {(b.eth || 0).toFixed(4)} ETH · {(b.usdc || 0).toFixed(2)} USDC
      </span>
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
        <button onClick={() => fund('eth', '0.01')} disabled={!!busy} style={pill(false)}>
          {busy === 'eth' ? '…' : '+ 0.01 ETH'}
        </button>
        <button onClick={() => fund('usdc', '10')} disabled={!!busy} style={pill(false)}>
          {busy === 'usdc' ? '…' : '+ 10 USDC'}
        </button>
      </div>
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
