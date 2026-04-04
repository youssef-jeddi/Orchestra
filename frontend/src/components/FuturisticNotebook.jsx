'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import { X, Send, Feather, Bot, ShieldCheck, Zap, ExternalLink } from 'lucide-react';
import { useOrchestra } from '@/context/OrchestraContext';
import { sendIntent, broadcast, submitSwap, getNonce } from '@/lib/bridge';

const DEFAULT_MESSAGES = [
  {
    id: 1,
    role: 'scholar',
    text: "Welcome to Orchestra. I can swap tokens, send funds, check your balance, or add liquidity. What would you like to do?",
  },
];

const HISTORY_ENTRIES = [
  { id: 'h1', label: 'Yield strategies', preview: 'Lido stETH 3.8%, Uni V3...' },
  { id: 'h2', label: 'Risk analysis', preview: 'AAVE HF 1.42, collateral...' },
  { id: 'h3', label: 'Gas optimization', preview: '18 gwei window, bridge USDC...' },
  { id: 'h4', label: 'Whale movements', preview: '$LINK accumulation detected...' },
  { id: 'h5', label: 'LP performance', preview: '24h vol $2,840, fees $6.20' },
];

function TypewriterText({ text, onComplete }) {
  const [displayed, setDisplayed] = useState('');
  const idxRef = useRef(0);

  useEffect(() => {
    idxRef.current = 0;
    setDisplayed('');
    const iv = setInterval(() => {
      idxRef.current++;
      if (idxRef.current <= text.length) {
        setDisplayed(text.slice(0, idxRef.current));
      } else {
        clearInterval(iv);
        onComplete?.();
      }
    }, 20);
    return () => clearInterval(iv);
  }, [text, onComplete]);

  return (
    <span>
      {displayed}
      {displayed.length < text.length && (
        <motion.span
          animate={{ opacity: [1, 0] }}
          transition={{ duration: 0.5, repeat: Infinity }}
          style={{ color: '#666' }}
        >
          |
        </motion.span>
      )}
    </span>
  );
}

// ── Agent reasoning block (rendered inside chat) ──
function AgentReasoning({ data }) {
  const verdict = data.assessment?.verdict || 'UNKNOWN';
  const verdictColor = verdict === 'AUTO_EXECUTE' ? '#30D158'
    : verdict === 'NEEDS_APPROVAL' ? '#FFB400'
    : verdict === 'INFO' ? '#007AFF'
    : verdict === 'BLOCKED' ? '#FF453A' : '#666';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
      {/* Planner */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
        <Bot size={12} style={{ color: '#C084FC', flexShrink: 0, marginTop: 3 }} />
        <div>
          <span style={{ fontSize: 10, color: '#C084FC', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Planner</span>
          <p style={{ margin: 0, fontSize: 13, color: '#bbb', lineHeight: 1.5 }}>{data.agentReasoning?.planner}</p>
        </div>
      </div>

      {/* Plan */}
      <div style={{ padding: '8px 12px', background: 'rgba(255,255,255,0.03)', borderRadius: 8, border: '1px solid rgba(255,255,255,0.06)' }}>
        <p style={{ margin: 0, fontSize: 13, color: '#E8E4DE' }}>
          {data.plan?.summary} {data.plan?.totalEstimatedValueUsd > 0 && <span style={{ color: '#999' }}> — ${data.plan.totalEstimatedValueUsd}</span>}
        </p>
      </div>

      {/* Gatekeeper */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
        <ShieldCheck size={12} style={{ color: verdictColor, flexShrink: 0, marginTop: 3 }} />
        <div>
          <span style={{ fontSize: 10, color: verdictColor, textTransform: 'uppercase', letterSpacing: '0.1em' }}>Gatekeeper</span>
          <p style={{ margin: 0, fontSize: 13, color: '#bbb', lineHeight: 1.5 }}>{data.agentReasoning?.gatekeeper}</p>
        </div>
      </div>

      {/* Verdict badge */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{
          display: 'inline-block', padding: '3px 10px', borderRadius: 100,
          fontSize: 11, fontWeight: 500, letterSpacing: '0.05em',
          background: `${verdictColor}22`, color: verdictColor, border: `1px solid ${verdictColor}44`,
        }}>
          {verdict.replace('_', ' ')}
        </span>
        <span style={{ fontSize: 11, color: '#666' }}>risk: {data.assessment?.riskScore}/100</span>
      </div>
    </div>
  );
}

// ── Inline action buttons ──
function SwapAction({ data, onSign, signing }) {
  if (data.autoExecuted && data.txHash) {
    return (
      <div style={{ marginTop: 8, padding: '10px 14px', background: 'rgba(48,209,88,0.08)', borderRadius: 10, border: '1px solid rgba(48,209,88,0.2)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#30D158', fontSize: 13, fontWeight: 500 }}>
          <Zap size={14} /> Auto-executed via Safe
        </div>
        <a href={data.explorerUrl} target="_blank" rel="noopener" style={{ fontSize: 12, color: '#C084FC', display: 'flex', alignItems: 'center', gap: 4, marginTop: 6 }}>
          <ExternalLink size={11} /> {data.txHash.slice(0, 16)}...
        </a>
      </div>
    );
  }

  if (data.quoteData) {
    return (
      <div style={{ marginTop: 8 }}>
        <button
          onClick={onSign}
          disabled={signing}
          style={{
            width: '100%', padding: '10px 16px', borderRadius: 10,
            background: signing ? 'rgba(192,132,252,0.1)' : 'rgba(192,132,252,0.15)',
            border: '1px solid rgba(192,132,252,0.3)', color: '#C084FC',
            fontSize: 13, fontWeight: 500, cursor: 'none',
            fontFamily: 'var(--font-inter)',
            opacity: signing ? 0.6 : 1,
          }}
        >
          {signing ? 'Check your Ledger...' : 'Sign & Swap on Ledger'}
        </button>
      </div>
    );
  }

  return null;
}

// ── Balance display ──
function BalanceDisplay({ balances }) {
  if (!balances) return null;
  const items = [
    { label: 'ETH', value: balances.eth?.toFixed(4), color: '#627EEA' },
    { label: 'WETH', value: balances.weth?.toFixed(4), color: '#627EEA' },
    { label: 'USDC', value: balances.usdc?.toFixed(2), color: '#2775CA' },
  ];
  return (
    <div style={{ display: 'flex', gap: 12, marginTop: 6 }}>
      {items.map((t) => (
        <div key={t.label} style={{ padding: '6px 12px', background: 'rgba(255,255,255,0.03)', borderRadius: 8, border: '1px solid rgba(255,255,255,0.06)' }}>
          <span style={{ fontSize: 11, color: '#666' }}>{t.label}</span>
          <p style={{ margin: 0, fontSize: 14, color: '#E8E4DE', fontWeight: 400 }}>{t.value}</p>
        </div>
      ))}
    </div>
  );
}

export default function FuturisticNotebook({ onClose, initialMessage = '' }) {
  const { ledger } = useOrchestra();
  const [messages, setMessages] = useState(DEFAULT_MESSAGES);
  const [inputValue, setInputValue] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [activeHistory, setActiveHistory] = useState('h1');
  const [signingId, setSigningId] = useState(null);
  const messagesEndRef = useRef(null);
  const queryHandled = useRef(false);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isTyping]);

  // Pre-fill from search bar query
  useEffect(() => {
    if (initialMessage && !queryHandled.current) {
      queryHandled.current = true;
      processIntent(initialMessage);
    }
  }, [initialMessage]);

  const processIntent = async (text) => {
    // Add user message
    const userMsgId = Date.now();
    setMessages((prev) => [...prev, { id: userMsgId, role: 'user', text }]);
    setIsTyping(true);

    try {
      const data = await sendIntent(text, ledger.walletAddress);

      setIsTyping(false);

      if (data.status === 'no_action') {
        setMessages((prev) => [...prev, {
          id: Date.now(), role: 'scholar', text: data.reasoning || "I couldn't determine an action for that request.", isNew: true,
        }]);
        return;
      }

      // Add agent reasoning as a rich message
      setMessages((prev) => [...prev, {
        id: Date.now(), role: 'agent', data, isNew: true,
      }]);
    } catch (err) {
      setIsTyping(false);
      setMessages((prev) => [...prev, {
        id: Date.now(), role: 'scholar', text: `Error: ${err.message}`, isNew: true,
      }]);
    }
  };

  const handleSignAndSwap = async (data) => {
    const msgId = Date.now();
    setSigningId(msgId);

    try {
      const quoteData = data.quoteData;
      const { ethers } = await import('ethers');
      const nonceData = await getNonce(ledger.walletAddress);
      let currentNonce = nonceData.nonce;
      const maxFeePerGas = BigInt(nonceData.maxFeePerGas);
      const maxPriorityFeePerGas = BigInt(nonceData.maxPriorityFeePerGas);

      // Step 1: Permit2 approval if needed
      if (quoteData.approvalNeeded && quoteData.approvalTx) {
        const approvalTx = ethers.Transaction.from({
          to: quoteData.approvalTx.to, data: quoteData.approvalTx.data,
          value: quoteData.approvalTx.value || '0x0',
          chainId: 11155111, gasLimit: quoteData.approvalTx.gasLimit || 100000,
          type: 2, maxFeePerGas, maxPriorityFeePerGas, nonce: currentNonce,
        });

        const approvalSig = await ledger.sign(approvalTx.unsignedSerialized);
        const signedApproval = approvalTx.clone();
        signedApproval.signature = ethers.Signature.from(approvalSig);
        await broadcast(signedApproval.serialized);
        currentNonce++;
        await new Promise((r) => setTimeout(r, 5000));
      }

      // Step 2: Permit2 typed data
      let permit2Signature;
      if (quoteData.permitData) {
        const typedData = {
          domain: quoteData.permitData.domain,
          types: quoteData.permitData.types,
          primaryType: quoteData.permitData.primaryType || Object.keys(quoteData.permitData.types).find((k) => k !== 'EIP712Domain') || 'PermitSingle',
          message: quoteData.permitData.values,
        };
        const sig = await ledger.signTyped(typedData);
        permit2Signature = ethers.Signature.from({ v: sig.v, r: sig.r, s: sig.s }).serialized;
      }

      // Step 3: Get swap calldata
      const swapResult = await submitSwap(quoteData.quote, quoteData.permitData, permit2Signature, quoteData.routing);

      if (swapResult.type === 'uniswapx') {
        setMessages((prev) => [...prev, {
          id: Date.now(), role: 'scholar', text: `UniswapX order submitted: ${swapResult.orderId.slice(0, 16)}...`, isNew: true,
        }]);
        return;
      }

      // Step 4: Sign swap tx
      const unsignedTx = swapResult.unsignedTx;
      const gasLimit = Math.ceil(Number(unsignedTx.gasLimit || unsignedTx.gas || 350000) * 1.2);
      const swapTx = ethers.Transaction.from({
        to: unsignedTx.to, data: unsignedTx.data || '0x', value: unsignedTx.value || '0x0',
        chainId: 11155111, gasLimit, type: 2,
        maxFeePerGas, maxPriorityFeePerGas, nonce: currentNonce,
      });

      const swapSig = await ledger.sign(swapTx.unsignedSerialized);
      const signedSwap = swapTx.clone();
      signedSwap.signature = ethers.Signature.from(swapSig);

      // Step 5: Broadcast
      const result = await broadcast(signedSwap.serialized);

      setMessages((prev) => [...prev, {
        id: Date.now(), role: 'scholar',
        text: `Swap executed successfully!`,
        txHash: result.txHash,
        explorerUrl: result.explorerUrl,
        isNew: true,
      }]);
    } catch (err) {
      setMessages((prev) => [...prev, {
        id: Date.now(), role: 'scholar', text: `Swap failed: ${err.message}`, isNew: true,
      }]);
    } finally {
      setSigningId(null);
    }
  };

  const handleSend = () => {
    const text = inputValue.trim();
    if (!text || isTyping) return;
    setInputValue('');
    processIntent(text);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const canSend = inputValue.trim() && !isTyping;

  return (
    <motion.div
      initial={{ scale: 0.95, opacity: 0, filter: 'blur(8px)' }}
      animate={{ scale: 1, opacity: 1, filter: 'blur(0px)' }}
      exit={{ scale: 0.95, opacity: 0, filter: 'blur(8px)' }}
      transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        cursor: 'none', background: '#1A1510',
      }}
    >
      <style>{`
        .nb-grimoire {
          display: flex; width: 100%; max-width: 1100px; height: 100vh; position: relative;
        }
        .nb-sidebar {
          width: 280px; flex-shrink: 0; border-right: 1px solid #1A1A1A;
          display: flex; flex-direction: column;
        }
        .nb-main {
          flex: 1; min-width: 0; display: flex; flex-direction: column;
        }
        @media (max-width: 768px) {
          .nb-sidebar { display: none; }
          .nb-grimoire { max-width: 700px; }
        }
        .nb-hist {
          transition: background 0.2s, transform 0.25s cubic-bezier(0.16,1,0.3,1);
        }
        .nb-hist:hover {
          background: rgba(255,255,255,0.03); transform: scale(1.02);
        }
      `}</style>

      {/* Background */}
      <img
        src="/images/notebook-bg.png" alt=""
        style={{
          position: 'absolute', inset: 0, width: '100%', height: '100%',
          objectFit: 'cover', opacity: 0.45, filter: 'brightness(1.3)', pointerEvents: 'none',
        }}
      />

      <div className="nb-grimoire" style={{ zIndex: 2 }}>
        {/* Close */}
        <motion.button
          onClick={onClose} aria-label="Close notebook"
          whileHover={{ color: '#E8E4DE' }}
          style={{
            position: 'absolute', top: 24, right: 16, zIndex: 10,
            background: 'none', border: 'none', cursor: 'none', color: '#FFFFFF', padding: 8,
          }}
        >
          <X size={28} />
        </motion.button>

        {/* Left: History */}
        <div className="nb-sidebar">
          <div style={{ position: 'absolute', left: 32, top: 0, bottom: 0, width: 1, background: '#1A1A1A', pointerEvents: 'none' }} />
          <div style={{ padding: '48px 24px 16px 48px' }}>
            <p style={{ fontFamily: 'var(--font-playfair)', fontSize: 16, fontWeight: 400, color: '#FFFFFF', margin: 0, marginBottom: 4 }}>
              Research Log
            </p>
            <div style={{ width: 60, height: 1, background: '#222', marginBottom: 20 }} />
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '0 24px 16px 48px', scrollbarWidth: 'none', display: 'flex', flexDirection: 'column', gap: 2 }}>
            {HISTORY_ENTRIES.map((entry) => (
              <button
                key={entry.id} className="nb-hist"
                onClick={() => setActiveHistory(entry.id)}
                style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  background: activeHistory === entry.id ? 'rgba(192,132,252,0.06)' : 'transparent',
                  border: 'none',
                  borderLeft: activeHistory === entry.id ? '2px solid #C084FC' : '2px solid transparent',
                  borderRadius: 6, padding: '10px 12px', cursor: 'none',
                }}
              >
                <p style={{ margin: 0, fontFamily: 'var(--font-inter)', fontSize: 13, fontWeight: activeHistory === entry.id ? 400 : 300, color: '#FFFFFF', lineHeight: 1.3 }}>
                  {entry.label}
                </p>
                <p style={{ margin: '4px 0 0', fontFamily: 'var(--font-inter)', fontSize: 11, fontWeight: 300, color: '#FFFFFF', opacity: 0.5, lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {entry.preview}
                </p>
              </button>
            ))}
          </div>
        </div>

        {/* Right: Conversation */}
        <div className="nb-main">
          <div style={{ position: 'absolute', right: 32, top: 0, bottom: 0, width: 1, background: '#1A1A1A', zIndex: 1, pointerEvents: 'none' }} />

          {/* Header */}
          <div style={{ padding: '48px 48px 20px', textAlign: 'center', flexShrink: 0 }}>
            <div style={{ width: '100%', height: 1, background: '#1A1A1A', marginBottom: 20 }} />
            <h1 style={{ fontFamily: 'var(--font-playfair)', fontSize: 22, fontWeight: 400, color: '#FFFFFF', margin: 0, lineHeight: 1.4 }}>
              The Scholar&apos;s Notebook
            </h1>
            <div style={{ width: 160, height: 1, background: '#444', margin: '12px auto 0' }} />
            {/* Connection status */}
            {ledger.walletAddress && (
              <p style={{ fontSize: 11, color: '#0f8', fontFamily: 'var(--font-inter)', marginTop: 8, opacity: 0.7 }}>
                {ledger.walletAddress.slice(0, 6)}...{ledger.walletAddress.slice(-4)}
              </p>
            )}
            {!ledger.walletAddress && (
              <p style={{ fontSize: 11, color: '#FFB400', fontFamily: 'var(--font-inter)', marginTop: 8, opacity: 0.7 }}>
                Connect Ledger for full functionality
              </p>
            )}
          </div>

          {/* Messages */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '8px 48px 16px', display: 'flex', flexDirection: 'column', gap: 20, scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
            {messages.map((msg) => (
              <div key={msg.id}>
                {msg.role === 'agent' ? (
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                    <Feather size={14} style={{ color: '#444', flexShrink: 0, marginTop: 4 }} />
                    <div style={{ flex: 1 }}>
                      <AgentReasoning data={msg.data} />
                      {msg.data.intentType === 'balance' && <BalanceDisplay balances={msg.data.balances} />}
                      <SwapAction
                        data={msg.data}
                        signing={signingId !== null}
                        onSign={() => handleSignAndSwap(msg.data)}
                      />
                    </div>
                  </div>
                ) : msg.role === 'scholar' ? (
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                    <Feather size={14} style={{ color: '#444', flexShrink: 0, marginTop: 4 }} />
                    <div>
                      <p style={{ margin: 0, fontFamily: 'var(--font-inter)', fontSize: 15, fontWeight: 300, color: '#FFFFFF', lineHeight: 1.75 }}>
                        {msg.isNew ? <TypewriterText text={msg.text} /> : msg.text}
                      </p>
                      {msg.explorerUrl && (
                        <a href={msg.explorerUrl} target="_blank" rel="noopener" style={{ fontSize: 12, color: '#C084FC', display: 'flex', alignItems: 'center', gap: 4, marginTop: 6 }}>
                          <ExternalLink size={11} /> View on Etherscan
                        </a>
                      )}
                    </div>
                  </div>
                ) : (
                  <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <div style={{ maxWidth: '75%', padding: '12px 18px', background: 'rgba(192,132,252,0.08)', border: '1px solid rgba(192,132,252,0.15)', borderRadius: 12, fontFamily: 'var(--font-inter)', fontSize: 15, fontWeight: 300, color: '#FFFFFF', lineHeight: 1.65 }}>
                      {msg.text}
                    </div>
                  </div>
                )}
              </div>
            ))}

            {isTyping && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Feather size={14} style={{ color: '#444', flexShrink: 0 }} />
                <div style={{ display: 'flex', gap: 5, padding: '4px 0' }}>
                  {[0, 1, 2].map((i) => (
                    <motion.div key={i} style={{ width: 5, height: 5, borderRadius: '50%', background: '#444' }} animate={{ opacity: [0.3, 1, 0.3] }} transition={{ duration: 0.8, repeat: Infinity, delay: i * 0.2 }} />
                  ))}
                </div>
              </motion.div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div style={{ padding: '16px 48px 32px', flexShrink: 0 }}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', background: '#111114', border: '1px solid #222', borderRadius: 16, padding: '4px 6px 4px 18px' }}>
              <input
                type="text"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Swap 0.01 ETH for USDC..."
                style={{ flex: 1, background: 'transparent', border: 'none', fontSize: 14, fontFamily: 'var(--font-inter)', fontWeight: 300, color: '#E8E4DE', outline: 'none', cursor: 'none', padding: '10px 0' }}
              />
              <motion.button
                onClick={handleSend} aria-label="Send"
                whileHover={canSend ? { scale: 1.1 } : {}}
                whileTap={canSend ? { scale: 0.9 } : {}}
                disabled={!canSend}
                style={{ width: 38, height: 38, borderRadius: 12, background: 'transparent', border: 'none', cursor: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
              >
                <Send size={16} color={canSend ? '#C084FC' : '#333'} />
              </motion.button>
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
