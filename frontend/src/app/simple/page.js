'use client';

// ── Simple UI (/simple) ──
// A stripped-down, single-surface chat — the minimal counterpart to the full
// presentation app at "/". Reuses the same context, bridge client, and policy
// response shape; adds no new plumbing.

import { useState, useRef, useEffect, useCallback } from 'react';
import { OrchestraProvider, useOrchestra } from '@/context/OrchestraContext';
import {
  sendIntent, getPrices, getPasskeyStatus, getApproval,
  getTelegramStatus, telegramLinkRequest, telegramLink, listPasskeys, rejectApproval, getOwnerSign, getActivity,
} from '@/lib/bridge';
import { activityRow, ownerSignIdFromSearch, ACTIVITY_EMPTY, EXPIRED_OWNER_SIGN } from '@/lib/activity';
import { signOwnerRequest } from '@/lib/signing';
import { errorMessage } from '@/lib/ownerSign';
import { registerPasskey, approveWithPasskey, setUpPhonePasskey, removePasskey } from '@/lib/passkey';
import { PRIVY_APP_ID } from '@/lib/privy';
import { shortAddress, setupProgressText } from '@/lib/onboarding';
import { SIGN_REFUSED, PASSKEY_PROMPT, isPasskeyRequired, shouldOfferPasskey, userMaySign, pendingRequest, verifyStepFor, passkeyDraft, SOCIAL_NONE, SOCIAL_WRONG_ACCOUNT } from '@/lib/emailPasskey';
import EmailPasskeySetup from '@/components/EmailPasskeySetup';
import SocialPasskeySetup from '@/components/SocialPasskeySetup';
import LimitsSheet from '@/components/LimitsSheet';
import { LIMITS_BUTTON_HINT } from '@/lib/limits';
import { HINT_COLOR, HINT_SIZE } from '@/lib/contrast';
import { headerState, CONNECTING_GIVE_UP_MS } from '@/lib/connection';
import {
  ruleHint, declineLabel, declinedText, expiredText, ALREADY_SETTLED, approvalControls,
  cardView, doneOutcome, outcomeAfterError, valueSuffix,
} from '@/lib/approvalCard';
import { shouldRefreshBalances, approvalMovedFunds, refreshSoon } from '@/lib/balances';
import { verdictLabel, ruleLabel, EXAMPLES, WELCOME, showWelcome, RECEIPT_LABEL, balanceTiles, ADD_PASSKEY_HINT, PASSKEY_MEANS } from '@/lib/plainLanguage';

const ACCENT = '#C084FC';

const VERDICT_COLOR = {
  AUTO_EXECUTE: '#30D158',
  NEEDS_APPROVAL: '#FFB400',
  INFO: '#007AFF',
  BLOCKED: '#FF453A',
};

const PILL_COLOR = { good: '#30D158', calm: '#8d8a84', bad: '#FF453A' };

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

  const refreshBalances = safe.refreshBalances;
  // The "Recent activity" list: re-read whenever something that moves funds has finished.
  const [activity, setActivity] = useState(null); // null until loaded
  const loadActivity = useCallback(() => {
    if (!ledger.walletAddress || !session.ready) { setActivity(null); return; }
    getActivity().then((d) => setActivity(d.activity || [])).catch(() => {});
  }, [ledger.walletAddress, session.ready]);
  useEffect(() => { loadActivity(); }, [loadActivity]);
  const movedFunds = useCallback(() => { refreshSoon(refreshBalances); refreshSoon(loadActivity); }, [refreshBalances, loadActivity]);
  const [signingIdx, setSigningIdx] = useState(null);
  const [prices, setPrices] = useState(null);
  const [passkeyReg, setPasskeyReg] = useState(false);
  const [showPasskeys, setShowPasskeys] = useState(false);
  const [showLimits, setShowLimits] = useState(false);
  const showError = useCallback((msg) => setMessages((m) => [...m, { role: 'agent', error: msg }]), []);
  const [setupOpen, setSetupOpen] = useState(false); // an email user's first-passkey steps
  const held = useRef(pendingRequest()); // the request held back until a passkey exists
  const offered = useRef(null); // wallet we already offered the passkey to
  const emailWallet = !!session.emailWallet;
  const needsFirstPasskey = emailWallet && !session.hasPasskey;
  const verifyStep = verifyStepFor(session.verifyWith); // email code, or sign in again with the same social account
  const [returning, setReturning] = useState(false); // back from the provider's sign-in page, to be confirmed

  // Check passkey registration once signed in (the bridge answers only for the signed-in wallet):
  // a Privy sign-in passkey becomes the approval passkey during sign-in.
  const refreshPasskeyStatus = useCallback(() => {
    if (!ledger.walletAddress || !session.ready) { setPasskeyReg(false); return; }
    getPasskeyStatus(ledger.walletAddress).then((d) => setPasskeyReg(!!d.registered)).catch(() => {});
  }, [ledger.walletAddress, session.ready]);
  useEffect(() => { refreshPasskeyStatus(); }, [refreshPasskeyStatus]);

  // Live price ticker — refresh every 60s.
  useEffect(() => {
    let alive = true;
    const load = () => getPrices().then((d) => { if (alive) setPrices(d.prices); }).catch(() => {});
    load();
    const id = setInterval(load, 60000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  // One request to the agent. An email user without a passkey is told so in the chat, and the
  // request is kept: once the passkey is added it is sent again as a new request, so they
  // don't retype it (the server builds and holds a fresh approval for it; nothing is replayed).
  const ask = useCallback(async (text, history) => {
    setBusy(true);
    try {
      const data = await sendIntent(text, ledger.walletAddress, { history });
      if (isPasskeyRequired(data)) held.current.hold(text, history);
      setMessages((m) => [...m, { role: 'agent', data }]);
      if (shouldRefreshBalances(data)) movedFunds();
    } catch (err) {
      setMessages((m) => [...m, errorMessage(err)]);
    } finally {
      setBusy(false);
    }
  }, [ledger.walletAddress, movedFunds]);

  const send = useCallback(async (raw) => {
    const text = (raw ?? input).trim();
    if (!text || busy) return;
    // A connected wallet must be signed in: the server only acts for a wallet that proved ownership.
    if (ledger.walletAddress && !session.ready) {
      setMessages((m) => [...m, { role: 'user', text }, {
        role: 'agent',
        error: session.status === 'signing' ? 'Finish signing in first.' : 'Sign in first (button at the top).',
      }]);
      setInput('');
      return;
    }
    setInput('');
    const history = toHistory(messages);
    setMessages((m) => [...m, { role: 'user', text }]);
    await ask(text, history);
  }, [input, busy, messages, ledger.walletAddress, session.ready, session.status, ask]);

  // Fund your own account from your own wallet. Everything the account holds (send, swap,
  // liquidity) is approved with a passkey or on Telegram instead, never paid from this wallet.
  const execute = useCallback(async (data, idx) => {
    if (!ledger.walletAddress) {
      setMessages((m) => [...m, { role: 'agent', error: 'Sign in first.' }]);
      return;
    }
    if (!data.depositData || !userMaySign({ emailWallet, hasPasskey: session.hasPasskey }, 'deposit')) {
      setMessages((m) => [...m, { role: 'agent', error: SIGN_REFUSED }]);
      return;
    }
    setSigningIdx(idx);
    try {
      const result = await safe.deposit(data.depositData.symbol.toLowerCase(), data.depositData.amount);
      setMessages((m) => [...m, { role: 'system', txHash: result.txHash, explorerUrl: result.explorerUrl }]);
    } catch (err) {
      setMessages((m) => [...m, { role: 'agent', error: err.message }]);
    } finally {
      setSigningIdx(null);
    }
  }, [ledger.walletAddress, safe, emailWallet, session.hasPasskey]);

  // Mark a held card as settled (done or failed) so it shows the outcome and loses its buttons.
  const settleCard = useCallback((idx, outcome) => {
    setMessages((m) => m.map((x, i) => (i === idx ? { ...x, outcome } : x)));
  }, []);

  // Approve + execute with a passkey (biometric) instead of signing directly.
  const approvePasskey = useCallback(async (data, idx) => {
    if (!ledger.walletAddress) {
      setMessages((m) => [...m, { role: 'agent', error: 'Sign in first.' }]);
      return;
    }
    if (!data.approval?.id) {
      setMessages((m) => [...m, { role: 'agent', error: "I can't find this approval any more. Ask again." }]);
      return;
    }
    setSigningIdx(idx);
    try {
      const result = await approveWithPasskey(ledger.walletAddress, data.approval.id);
      settleCard(idx, doneOutcome(result));
      movedFunds();
    } catch (err) {
      // If the server already settled it (it ran and failed, or lapsed), the card says so and loses
      // its buttons; if it is still waiting (prompt cancelled, check failed) it stays open.
      const approval = await getApproval(data.approval.id).catch(() => null);
      const outcome = outcomeAfterError(err, approval, data.intentType);
      if (outcome) settleCard(idx, outcome);
      // Past the on-chain daily ceiling: say so, with the offer to sign it as the owner when there is one.
      if (err.code === 'over_daily_cap') setMessages((m) => [...m, errorMessage(err)]);
      else if (!outcome) setMessages((m) => [...m, { role: 'agent', error: err.message }]);
    } finally {
      setSigningIdx(null);
    }
  }, [ledger.walletAddress, settleCard, movedFunds]);

  // Sign a request that went past the daily ceiling, as the account's owner. The server holds the
  // exact transaction; the wallet signs its hash and the server sends it.
  const signAsOwner = useCallback(async (offer, idx) => {
    setSigningIdx(idx);
    try {
      const result = await signOwnerRequest(ledger, offer, { emailWallet, hasPasskey: session.hasPasskey });
      setMessages((m) => [...m, { role: 'system', txHash: result.txHash, explorerUrl: result.explorerUrl }]);
      movedFunds();
    } catch (err) {
      setMessages((m) => [...m, { role: 'agent', error: err.message }]);
    } finally {
      setSigningIdx(null);
    }
  }, [ledger, emailWallet, session.hasPasskey, movedFunds]);

  // Opened from the Telegram link (?ownerSign=<id>): show the held request again with its Sign button.
  // The id is removed from the address first, so a refresh doesn't ask again.
  useEffect(() => {
    if (!session.ready || !ledger.walletAddress || typeof window === 'undefined') return;
    const id = ownerSignIdFromSearch(window.location.search);
    if (!id) return;
    const url = new URL(window.location.href);
    url.searchParams.delete('ownerSign');
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    getOwnerSign(id)
      .then((offer) => setMessages((m) => [...m, errorMessage({
        code: 'over_daily_cap',
        message: 'To send this, sign it with your wallet. ' + (offer.summary || ''),
        data: { ownerSign: offer },
      })]))
      .catch(() => setMessages((m) => [...m, { role: 'agent', error: EXPIRED_OWNER_SIGN }]));
  }, [session.ready, ledger.walletAddress]);

  const registerPk = useCallback(async () => {
    if (!ledger.walletAddress) return;
    if (needsFirstPasskey) { setSetupOpen(true); return; } // email first: a code, then the passkey
    try {
      await registerPasskey(ledger.walletAddress);
      setPasskeyReg(true);
      session.refreshAccount();
    } catch (err) {
      setMessages((m) => [...m, { role: 'agent', error: `Couldn't add the passkey: ${err.message}` }]);
    }
  }, [ledger.walletAddress, needsFirstPasskey, session]);

  // The email user's first passkey is saved: carry on with what they asked for, if anything.
  const passkeyAdded = useCallback(() => {
    setSetupOpen(false);
    setReturning(false);
    passkeyDraft(window.sessionStorage).clear();
    setPasskeyReg(true);
    session.refreshAccount();
    const request = held.current.take();
    if (request) {
      setMessages((m) => [...m, { role: 'system', text: 'Passkey added. Continuing with your request…' }]);
      ask(request.text, request.history);
    } else {
      setMessages((m) => [...m, { role: 'system', text: 'Passkey added. You can now confirm transactions with it.' }]);
    }
  }, [session, ask]);

  // Back from a provider's sign-in page: put the held request back and open the passkey steps, which
  // confirm the new sign-in by themselves. A draft for another wallet means a different account was
  // used, so it is dropped (the server refuses that confirmation as well).
  useEffect(() => {
    if (!session.ready || !ledger.walletAddress || typeof window === 'undefined') return;
    const store = passkeyDraft(window.sessionStorage);
    const draft = store.peek(ledger.walletAddress);
    if (!draft) return;
    if (!draft.mine) {
      store.clear();
      showError(SOCIAL_WRONG_ACCOUNT);
      return;
    }
    if (!needsFirstPasskey) { store.clear(); return; }
    if (draft.text) held.current.hold(draft.text, draft.history);
    setReturning(true);
    setSetupOpen(true);
  }, [session.ready, ledger.walletAddress, needsFirstPasskey, showError]);

  // Right after an email user's account is ready, offer the passkey in the chat, once per sign-in.
  const accountReady = safe.safeStatus === 'deployed';
  useEffect(() => {
    const wallet = ledger.walletAddress;
    if (!wallet || offered.current === wallet) return;
    if (!shouldOfferPasskey({ emailWallet, hasPasskey: session.hasPasskey, accountReady: session.ready && accountReady })) return;
    offered.current = wallet;
    setMessages((m) => [...m, { role: 'agent', passkeyPrompt: true }]);
  }, [ledger.walletAddress, emailWallet, session.hasPasskey, session.ready, accountReady]);

  const connected = !!ledger.walletAddress;
  // Until the sign-in service says whether the user is already signed in, the header shows neither
  // "Sign in" nor the wallet buttons. If it never answers, the buttons appear after a few seconds.
  const [gaveUp, setGaveUp] = useState(false);
  const head = headerState({ connected, privyConfigured: !!PRIVY_APP_ID, privyReady: ledger.privyReady, privyAuthenticated: ledger.privyAuthenticated, gaveUp });
  useEffect(() => {
    if (head !== 'connecting') return;
    const id = setTimeout(() => setGaveUp(true), CONNECTING_GIVE_UP_MS);
    return () => clearTimeout(id);
  }, [head]);

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
        {head === 'connecting' ? (
          <span style={{ fontSize: 13, color: HINT_COLOR }}>Connecting…</span>
        ) : connected ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {!session.ready && (
              <button onClick={session.signIn} disabled={session.status === 'signing'} style={pill(true)}
                title={session.error || 'Prove this wallet is yours (free, nothing is sent)'}>
                {session.status === 'signing' ? 'Check your wallet…' : '✍️ Sign in'}
              </button>
            )}
            {session.ready && <TelegramLink ledger={ledger} session={session} onError={(msg) => setMessages((m) => [...m, { role: 'agent', error: msg }])} />}
            {session.ready && <button onClick={() => setShowLimits((v) => !v)} style={pill(showLimits)} title={LIMITS_BUTTON_HINT}>Limits</button>}
            {session.ready && (passkeyReg
              ? <button onClick={() => setShowPasskeys((v) => !v)} style={pill(showPasskeys)} title="See, add or remove your passkeys">🔑 Passkeys</button>
              : <button onClick={registerPk} style={pill(false)} title={emailWallet ? 'Add a passkey on this device' : ADD_PASSKEY_HINT}>🔑 Add passkey</button>)}
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

      {connected && session.ready && needsFirstPasskey && setupOpen && (
        verifyStep.kind === 'email'
          ? <EmailPasskeySetup wallet={ledger.walletAddress} onDone={passkeyAdded} onClose={() => setSetupOpen(false)}
              style={{ button: approveBtn(false) }} />
          : verifyStep.kind === 'social'
            ? <SocialPasskeySetup wallet={ledger.walletAddress} provider={verifyStep} returning={returning}
                getHeld={() => held.current.peek()} onDone={passkeyAdded}
                onClose={() => { setSetupOpen(false); setReturning(false); passkeyDraft(window.sessionStorage).clear(); }}
                style={{ button: approveBtn(false) }} />
            : <p style={{ fontSize: 13, color: '#B9B5AE' }}>{SOCIAL_NONE}</p>
      )}
      {connected && session.ready && showPasskeys && (
        <PasskeyPanel onAdd={registerPk} onChange={refreshPasskeyStatus} onClose={() => setShowPasskeys(false)} onError={showError} />
      )}
      {connected && session.ready && showLimits && (
        <LimitsSheet ledger={ledger} onClose={() => setShowLimits(false)} buttonStyle={approveBtn} />
      )}
      {connected && session.ready && <SafeSetup safe={safe} canFund={userMaySign({ emailWallet, hasPasskey: session.hasPasskey }, 'deposit')} ledger={ledger} onMoved={movedFunds} onError={(msg) => setMessages((m) => [...m, { role: 'agent', error: msg }])} />}

      {connected && session.ready && <RecentActivity rows={activity} />}

      {/* Messages */}
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 16, padding: '24px 0' }}>
        {showWelcome(messages) && (
          <div style={{ margin: messages.length === 0 ? 'auto' : '8px auto 0', textAlign: 'center', color: '#666' }}>
            <p style={{ fontSize: 22, color: '#E8E4DE', fontWeight: 300, marginBottom: 10 }}>
              {WELCOME.title}
            </p>
            <p style={{ fontSize: 14, color: '#888', lineHeight: 1.5, maxWidth: 460, margin: '0 auto 20px' }}>
              {WELCOME.intro}
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
          <MessageRow key={i} m={m} idx={i} onExecute={execute} onPasskey={approvePasskey} onOwnerSign={signAsOwner}
            onAddPasskeyHere={registerPk} onMoved={movedFunds}
            passkeyReg={passkeyReg} signing={signingIdx === i}
            onAddPasskey={() => setSetupOpen(true)} canAddPasskey={needsFirstPasskey} />
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
            placeholder="Tell me what you want to do…"
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
        {head === 'signed-out' && (
          <p style={{ fontSize: HINT_SIZE, color: HINT_COLOR, textAlign: 'center', margin: '8px 0 0' }}>
            Sign in to see your balance and to have your limits protect you.
          </p>
        )}
      </div>
    </div>
  );
}

function MessageRow({ m, idx, onExecute, onPasskey, onOwnerSign, onAddPasskeyHere, onMoved, passkeyReg, signing, onAddPasskey, canAddPasskey }) {
  if (m.passkeyPrompt || isPasskeyRequired(m.data)) {
    return <PasskeyPrompt text={m.passkeyPrompt ? PASSKEY_PROMPT : agentText(m.data)} onAdd={onAddPasskey} canAdd={canAddPasskey} />;
  }
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
        {m.ownerSign && (
          <div style={{ marginTop: 10 }}>
            <button onClick={() => onOwnerSign(m.ownerSign, idx)} disabled={signing} style={approveBtn(signing)}>
              {signing ? 'Check your wallet…' : '✍️ Sign with my wallet'}
            </button>
          </div>
        )}
      </div>
    );
  }
  if (m.role === 'system') {
    return (
      <div style={{ alignSelf: 'flex-start', maxWidth: '90%', color: '#30D158', fontSize: 14,
        border: '1px solid #30D15844', borderRadius: 12, padding: '10px 14px', background: '#30D15811' }}>
        {m.txHash
          ? <a href={m.explorerUrl} target="_blank" rel="noreferrer" style={{ color: '#30D158', textDecoration: 'none' }}>
              ✓ Done — {RECEIPT_LABEL}
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
      onAddPasskey={onAddPasskeyHere}
      onMoved={onMoved}
      outcome={m.outcome}
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
      {(timing.totalMs / 1000).toFixed(1)}s
    </span>
  );
}

// The agent asking an email user to add a passkey, with the one tap that starts it.
function PasskeyPrompt({ text, onAdd, canAdd }) {
  return (
    <div style={{ alignSelf: 'flex-start', maxWidth: '85%', display: 'flex', flexDirection: 'column', gap: 10,
      background: '#141418', border: '1px solid #222228', borderRadius: '14px 14px 14px 4px', padding: '10px 14px' }}>
      <span style={{ color: '#E8E4DE', fontSize: 15, lineHeight: 1.5 }}>{text}</span>
      {canAdd
        ? <button onClick={onAdd} style={{ ...approveBtn(false), alignSelf: 'flex-start' }}>🔑 Add passkey</button>
        : <span style={{ fontSize: 12, color: '#777' }}>✓ Passkey added.</span>}
    </div>
  );
}

function AgentCard({ data, onExecute, onPasskey, onAddPasskey, onMoved, passkeyReg, signing, outcome }) {
  const verdict = data.assessment?.verdict || 'UNKNOWN';
  const color = VERDICT_COLOR[verdict] || '#666';
  const triggered = data.assessment?.triggered || [];
  const needsSign = !data.autoExecuted && (data.quoteData || data.sendData || data.depositData || data.lpData || data.lpRemoveData);
  const controls = needsSign ? approvalControls({ intentType: data.intentType, approval: data.approval, passkeyReg }) : null;
  // After the user declines (or the request lapses) the card stays settled: no buttons.
  const [ended, setEnded] = useState(null); // { text }
  const [declining, setDeclining] = useState(false);
  const [settled, setSettled] = useState(false); // settled elsewhere (e.g. said no on the phone)
  const settle = useCallback(() => setSettled(true), []);

  const view = cardView({ outcome, ended, signing, declining, settledElsewhere: settled, intentType: data.intentType });

  const decline = async () => {
    setDeclining(true);
    try {
      await rejectApproval(data.approval.id);
      setEnded({ kind: 'declined', text: declinedText(data.intentType) });
    } catch (err) {
      if (err.status === 404) setEnded({ kind: 'expired', text: expiredText(data.intentType) });
      else if (err.status === 409) setEnded({ kind: 'handled', text: ALREADY_SETTLED });
      else setEnded({ text: err.message, retry: true });
    } finally {
      setDeclining(false);
    }
  };

  return (
    <div style={{ alignSelf: 'flex-start', maxWidth: '92%', display: 'flex', flexDirection: 'column', gap: 10,
      background: '#141418', border: '1px solid #222228', borderRadius: 14, padding: 16 }}>

      {/* Plan summary */}
      {data.plan?.summary && (
        <p style={{ margin: 0, fontSize: 15, color: '#E8E4DE', whiteSpace: 'pre-line', overflowWrap: 'anywhere' }}>
          {data.plan.summary}
          {valueSuffix(data.plan.summary, data.plan.totalEstimatedValueUsd) && (
            <span style={{ color: HINT_COLOR }}>{valueSuffix(data.plan.summary, data.plan.totalEstimatedValueUsd)}</span>
          )}
        </p>
      )}

      {/* Balance card */}
      {data.intentType === 'balance' && data.balances && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {balanceTiles(data.balances).map((t) => (
            <div key={t.label} style={{ flex: '1 1 80px', padding: '10px 12px', background: 'rgba(255,255,255,0.03)',
              borderRadius: 10, border: '1px solid rgba(255,255,255,0.06)' }}>
              <span style={{ fontSize: HINT_SIZE, color: HINT_COLOR }}>{t.label}{t.hint ? ` · ${t.hint}` : ''}</span>
              <p style={{ margin: '2px 0 0', fontSize: 16, color: '#E8E4DE' }}>{t.value ?? '—'}</p>
            </div>
          ))}
        </div>
      )}

      {/* Reasoning (compact) */}
      {data.agentReasoning?.gatekeeper && (
        <p style={{ margin: 0, fontSize: 13, color: HINT_COLOR, lineHeight: 1.5 }}>
          {data.agentReasoning.gatekeeper}
        </p>
      )}

      {/* Verdict + rule chips */}
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        {(() => {
          const pillColor = view.pill ? PILL_COLOR[view.pill.tone] : color;
          return (
            <span style={{ padding: '3px 10px', borderRadius: 100, fontSize: 11, fontWeight: 500,
              background: `${pillColor}22`, color: pillColor, border: `1px solid ${pillColor}44` }}>
              {view.pill ? view.pill.label : verdictLabel(verdict)}
            </span>
          );
        })()}
        {view.showChips && triggered.map((slug) => (
          <span key={slug} title={ruleHint(slug)} style={{ fontSize: 10, padding: '2px 8px', borderRadius: 100,
            background: `${color}18`, color, border: `1px solid ${color}33` }}>
            {ruleLabel(slug)}
          </span>
        ))}
      </div>

      {/* Outcome */}
      {data.autoExecuted && data.txHash && (
        <a href={data.explorerUrl} target="_blank" rel="noreferrer"
          style={{ fontSize: 13, color: '#30D158', textDecoration: 'none' }}>
          ✓ Done — {RECEIPT_LABEL}
        </a>
      )}
      {controls && view.settled && (
        <span style={{ fontSize: 13, color: outcome?.status === 'done' ? '#30D158' : HINT_COLOR, lineHeight: 1.5 }}>
          {view.line}
          {view.receiptUrl && (
            <> <a href={view.receiptUrl} target="_blank" rel="noreferrer" style={{ color: '#30D158', textDecoration: 'none' }}>{RECEIPT_LABEL}</a></>
          )}
        </span>
      )}
      {controls && !view.settled && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 2 }}>
          {controls.mode === 'telegram' && <TelegramWait approval={data.approval} onSettled={settle} onMoved={onMoved} />}
          {controls.mode === 'passkey' && (
            <button onClick={onPasskey} disabled={view.approveDisabled} style={approveBtn(signing)}>
              {signing ? 'Confirm on your device…' : '🔑 Approve with passkey'}
            </button>
          )}
          {controls.mode === 'wallet' && (
            <button onClick={onExecute} disabled={signing} style={approveBtn(signing)}>
              {signing ? 'Check your wallet…' : 'Confirm in your wallet'}
            </button>
          )}
          {(controls.mode === 'need-passkey' || controls.mode === 'not-ready') && (
            <span style={{ fontSize: 13, color: HINT_COLOR, lineHeight: 1.5 }}>{controls.text}</span>
          )}
          {controls.mode === 'need-passkey' && (
            <button onClick={onAddPasskey} style={{ ...approveBtn(false), alignSelf: 'flex-start' }}>🔑 Add passkey</button>
          )}
          {controls.canDecline && view.showDecline && (
            <button onClick={decline} disabled={view.declineDisabled} style={{ ...pill(false), alignSelf: 'flex-start', padding: '6px 12px', fontSize: 12 }}
              title="Cancel this request. You can always ask again.">
              {declining ? 'Cancelling…' : declineLabel(data.intentType)}
            </button>
          )}
          {ended?.retry && <span style={{ fontSize: 12, color: '#FF453A' }}>Couldn&apos;t cancel it: {ended.text}</span>}
        </div>
      )}
      <Timing timing={data.timing} />
    </div>
  );
}

// An approval sent to the user's phone: poll the server until it's settled there.
function TelegramWait({ approval, onSettled, onMoved }) {
  const [state, setState] = useState(approval);

  const live = ['pending', 'executing'].includes(state.status);
  useEffect(() => { if (!live) onSettled?.(); }, [live, onSettled]);
  const moved = approvalMovedFunds({ ...approval, ...state });
  const told = useRef(false); // once per card, however often the parent re-renders
  useEffect(() => {
    if (moved && !told.current) { told.current = true; onMoved?.(); }
  }, [moved, onMoved]);

  useEffect(() => {
    if (!['pending', 'executing'].includes(state.status)) return;
    const id = setTimeout(() => {
      getApproval(approval.id).then(setState).catch(() => setState((s) => ({ ...s })));
    }, 2000);
    return () => clearTimeout(id);
  }, [state, approval.id]);

  const text = {
    pending: approval.factor === 'phone-passkey'
      ? '📱 Sent to your Telegram. Tap “Review & approve” on your phone and confirm with Face ID, your fingerprint or its screen lock.'
      : '📱 Sent to your Telegram. Check the details there and say yes or no.',
    executing: '⏳ Approved on your phone. Doing it now…',
    rejected: '🚫 You said no on your phone. Nothing was done.',
    expired: '⌛ Expired. Nothing was done.',
    failed: `❌ It didn't go through: ${state.error || 'something went wrong'}`,
  }[state.status];

  if (state.status === 'executed') {
    return (
      <a href={state.explorerUrl} target="_blank" rel="noreferrer"
        style={{ fontSize: 13, color: '#30D158', textDecoration: 'none' }}>
        ✓ Approved on your phone and done. {RECEIPT_LABEL}
      </a>
    );
  }
  return <span style={{ fontSize: 13, color: state.status === 'failed' ? '#FF453A' : HINT_COLOR }}>{text}</span>;
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
      return <span style={{ fontSize: 11, color: '#30D158' }} title="Risky actions are confirmed on your phone with its passkey">📱 {who} · 🔐 phone passkey</span>;
    }
    return (
      <>
        <span style={{ fontSize: 11, color: '#30D158' }} title="Risky actions are approved in Telegram">📱 {who}</span>
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
    <button onClick={link} disabled={busy} style={pill(false)} title="Get risky actions sent to your phone for your OK">
      {busy ? 'Check your wallet…' : '📱 Link Telegram'}
    </button>
  );
}

// The account's passkeys. Adding or removing one asks for an existing passkey
// first (the server checks it); the last one can't be removed.
function PasskeyPanel({ onAdd, onChange, onClose, onError }) {
  const [passkeys, setPasskeys] = useState(null);
  const [busy, setBusy] = useState(null); // passkey id being removed, or 'add'

  const load = useCallback(() => {
    listPasskeys().then((d) => setPasskeys(d.passkeys)).catch((err) => onError(`Couldn't load your passkeys: ${err.message}`));
  }, [onError]);

  useEffect(() => { load(); }, [load]);

  const remove = async (p) => {
    if (!window.confirm(`Remove the ${passkeyName(p).toLowerCase()} on ${p.rpID}? It will no longer be able to approve anything.`)) return;
    setBusy(p.id);
    try {
      setPasskeys((await removePasskey(p.id)).passkeys);
      onChange();
    } catch (err) {
      onError(`Couldn't remove the passkey: ${err.message}`);
    } finally {
      setBusy(null);
    }
  };

  const add = async () => {
    setBusy('add');
    try {
      await onAdd();
      load();
    } finally {
      setBusy(null);
    }
  };

  const only = passkeys?.length === 1;
  return (
    <div style={{ marginTop: 12, padding: '10px 12px', border: '1px solid #1c1c22', borderRadius: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 12, color: '#999' }}>Passkeys that can approve your actions</span>
        <button onClick={onClose} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: 16 }} title="Close">×</button>
      </div>
      {!passkeys && <p style={{ fontSize: 12, color: '#555', margin: 0 }}>Loading…</p>}
      {passkeys?.map((p) => (
        <div key={`${p.rpID}:${p.id}`} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderTop: '1px solid #1c1c22' }}>
          <span style={{ fontSize: 13, color: '#E8E4DE' }}>{p.label === 'phone' ? '📱' : '🔑'} {passkeyName(p)}</span>
          <span style={{ fontSize: 11, color: '#666' }}>
            {p.rpID}{p.createdAt ? ` · added ${new Date(p.createdAt).toLocaleDateString()}` : ''}
          </span>
          <button onClick={() => remove(p)} disabled={!!busy || only} style={{ ...pill(false), marginLeft: 'auto', padding: '4px 10px', fontSize: 12, opacity: only ? 0.5 : 1 }}
            title={only ? 'Your only passkey: add another before removing it' : 'Remove (confirm with one of your passkeys)'}>
            {busy === p.id ? 'Confirm with your passkey…' : 'Remove'}
          </button>
        </div>
      ))}
      <button onClick={add} disabled={!!busy} style={{ ...pill(false), marginTop: 8, fontSize: 12, padding: '5px 12px' }}
        title="Add a passkey on this device (confirm with an existing one first)">
        {busy === 'add' ? 'Follow the passkey prompts…' : '+ Add another passkey'}
      </button>
    </div>
  );
}

function passkeyName(p) {
  if (p.source === 'privy') return 'Sign-in passkey';
  return p.label === 'phone' ? 'Phone passkey' : 'Browser passkey';
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
      if (!(await session.ensure())) throw new Error('Sign in to set up the phone passkey.');
      try {
        await setUpPhonePasskey();
      } catch (err) {
        if (err.code !== 'session_required' || !(await session.signIn())) throw err;
        await setUpPhonePasskey();
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
      title="Confirm risky actions on your phone with a passkey, after seeing exactly what will happen">
      {state === 'sending' ? 'Sending…' : '🔐 Set up phone passkey'}
    </button>
  );
}

function RecentActivity({ rows }) {
  if (!rows) return null;
  return (
    <section style={{ marginTop: 12, padding: '10px 12px', border: '1px solid #1c1c22', borderRadius: 12 }}>
      <p style={{ margin: '0 0 6px', fontSize: 13, color: '#B9B5AE' }}>Recent activity</p>
      {rows.length === 0 && <p style={{ margin: 0, fontSize: 13, color: HINT_COLOR }}>{ACTIVITY_EMPTY}</p>}
      {rows.slice(0, 20).map((rec) => {
        const r = activityRow(rec);
        return (
          <div key={r.key} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '4px 0', fontSize: 13, color: '#E8E4DE' }}>
            <span style={{ color: '#8d8a84' }}>{r.when}</span>
            <span>{r.amount}</span>
            {r.to && <span style={{ color: '#B9B5AE' }}>to {r.to}</span>}
            <span style={{ color: '#B9B5AE' }}>· {r.source}</span>
            {r.receiptUrl && <a href={r.receiptUrl} target="_blank" rel="noreferrer" style={{ color: ACCENT, textDecoration: 'none' }}>View receipt ↗</a>}
          </div>
        );
      })}
    </section>
  );
}

function SafeSetup({ safe, canFund, ledger, onMoved, onError }) {
  const [busy, setBusy] = useState(null); // 'eth' | 'usdc' | null

  const fund = async (token, amount) => {
    setBusy(token);
    try {
      await safe.deposit(token, amount);
      // Deposits aren't in the activity list (no server record), but balances refresh; keep the list in sync too.
      if (onMoved) onMoved();
      else setTimeout(() => safe.refreshBalances(), 4000);
    } catch (err) { onError(err.message); }
    finally { setBusy(null); }
  };

  if (safe.safeStatus === 'error') {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        marginTop: 12, padding: '10px 12px', border: '1px solid #2a2a30', borderRadius: 12, background: '#141418',
      }}>
        <p style={{ margin: 0, fontSize: 13, color: '#999', lineHeight: 1.4 }}>
          {safe.setupError || "We couldn't finish setting up your account. Please try again."}
        </p>
        <button onClick={safe.retry} style={pill(true)}>Try again</button>
      </div>
    );
  }

  if (safe.safeStatus !== 'deployed') {
    return (
      <p style={{ fontSize: 14, color: '#B9B5AE', margin: '10px 0 0' }}>
        {setupProgressText(safe.finishing)}
        {safe.safeAddress && (
          <span title="Your account address. You can send funds to it now." style={{ marginLeft: 8, fontSize: 13, color: '#8d8a84' }}>
            {shortAddress(safe.safeAddress)}
          </span>
        )}
      </p>
    );
  }

  const b = safe.balances || {};
  return (
    <div style={{
      display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10,
      marginTop: 12, padding: '10px 12px', border: '1px solid #1c1c22', borderRadius: 12,
    }}>
      <a href={`https://sepolia.etherscan.io/address/${safe.safeAddress}`} target="_blank" rel="noreferrer"
        style={{ fontSize: 14, color: '#E8E4DE', textDecoration: 'none' }}>
        Your account {shortAddress(safe.safeAddress)} ↗
      </a>
      <span style={{ fontSize: 13, color: '#B9B5AE' }}>
        {(b.eth || 0).toFixed(4)} ETH · {(b.usdc || 0).toFixed(2)} USDC
      </span>
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
        <button onClick={() => fund('eth', '0.01')} disabled={!!busy || !canFund} style={pill(false)}
          title={canFund ? 'Move 0.01 ETH from your wallet into your account' : `Add a passkey first (🔑 at the top): confirm with ${PASSKEY_MEANS}`}>
          {busy === 'eth' ? '…' : '+ 0.01 ETH'}
        </button>
        <button onClick={() => fund('usdc', '10')} disabled={!!busy || !canFund} style={pill(false)}
          title={canFund ? 'Move 10 USDC from your wallet into your account' : `Add a passkey first (🔑 at the top): confirm with ${PASSKEY_MEANS}`}>
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
