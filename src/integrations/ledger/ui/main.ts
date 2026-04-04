// ─── SafeSwarm × Ledger — Browser Entry Point ───
// Glues DMK, signer, and WS bridge together for the test UI.

import { initDMK, discoverDevices, stopDiscovering, connectDevice, disconnectDevice, getActiveSession } from "../dmk";
import { createSigner, requestSignature, signTypedData, getAddress } from "../signer";
import type { TypedData } from "../signer";
import type { ApprovalRequest, ApprovalResult, DeviceStatus, BridgeMessage } from "../types";

// ─── DOM elements ───
const deviceStatusEl  = document.getElementById("device-status")!;
const deviceAddressEl = document.getElementById("device-address")!;
const connectBtn      = document.getElementById("connect-btn")! as HTMLButtonElement;
const disconnectBtn   = document.getElementById("disconnect-btn")! as HTMLButtonElement;
const approvalsEl     = document.getElementById("approvals-container")!;
const logContainer    = document.getElementById("log-container")!;
const mockTradeBtn    = document.getElementById("mock-trade-btn")! as HTMLButtonElement;
const bridgeDot       = document.getElementById("bridge-dot")!;
const bridgeLabel     = document.getElementById("bridge-label")!;
const swapAmountInput = document.getElementById("swap-amount")! as HTMLInputElement;
const quoteBtn        = document.getElementById("quote-btn")! as HTMLButtonElement;
const quoteResultEl   = document.getElementById("quote-result")!;
const intentInput     = document.getElementById("intent-input")! as HTMLInputElement;
const intentBtn       = document.getElementById("intent-btn")! as HTMLButtonElement;
const intentStatusEl  = document.getElementById("intent-status")!;
const agentPanel      = document.getElementById("agent-panel")!;
const agentResultEl   = document.getElementById("agent-result")!;

// ─── State ───
let deviceStatus: DeviceStatus = "disconnected";
let ws: WebSocket | null = null;
let hasApprovals = false;
let fullWalletAddress: string | null = null;

const BRIDGE_URL = "ws://localhost:3001/ws";
const BRIDGE_HTTP = "http://localhost:3001";

// ─── Logging ───
function log(msg: string): void {
  const entry = document.createElement("div");
  entry.className = "log-entry";
  const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
  entry.innerHTML = `<span class="log-time">${time}</span> <span class="log-msg">${msg}</span>`;
  logContainer.appendChild(entry);
  logContainer.scrollTop = logContainer.scrollHeight;
}

// ─── Device status ───
function setDeviceStatus(status: DeviceStatus): void {
  deviceStatus = status;
  deviceStatusEl.textContent = status;
  deviceStatusEl.className = `status-badge status-${status}`;

  connectBtn.style.display =
    status === "disconnected" ? "block" : "none";
  disconnectBtn.style.display =
    ["connected", "ready", "signing", "approved", "rejected"].includes(status)
      ? "block"
      : "none";
}

// ─── Connect to Ledger ───
connectBtn.addEventListener("click", async () => {
  try {
    setDeviceStatus("scanning");
    log("Starting device discovery…");
    connectBtn.disabled = true;

    log("Initializing DMK…");
    initDMK();
    log("DMK initialized ✓");

    discoverDevices(
      async (device) => {
        log(`Device emitted by DMK: ${JSON.stringify(Object.keys(device))}`);
        log(`Device id: ${(device as any).id}`);
        log(`Device deviceModel: ${JSON.stringify((device as any).deviceModel)}`);
        log(`Device type: ${(device as any).type}`);
        log(`Current deviceStatus: ${deviceStatus}`);

        if (deviceStatus !== "scanning" && deviceStatus !== "disconnected") {
          log("Ignoring — already connected");
          return;
        }

        const modelName = (device as any).deviceModel?.productName
          ?? (device as any).deviceModel?.model
          ?? (device as any).name
          ?? "Ledger device";
        log(`Found device: ${modelName}`);
        setDeviceStatus("connected");

        // Stop scanning once we have a device
        stopDiscovering();
        log("Stopped discovery ✓");

        try {
          log(`Calling connectDevice with id: ${(device as any).id}…`);
          const sessionId = await connectDevice((device as any).id);
          log(`Session obtained: ${sessionId}`);

          // Get address from device
          log("Creating signer…");
          const signer = createSigner(sessionId);
          log("Requesting address from device…");
          const address = await getAddress(signer);
          fullWalletAddress = address;
          deviceAddressEl.textContent = `${address.slice(0, 8)}…${address.slice(-6)}`;
          log(`Address: ${address}`);

          setDeviceStatus("ready");
          log("Device is READY ✓");
        } catch (err: any) {
          log(`❌ Connection error: ${err.message}`);
          console.error("Connection error:", err);
          setDeviceStatus("disconnected");
          connectBtn.disabled = false;
        }
      },
      (err) => {
        log(`❌ Discovery error: ${err.message}`);
        console.error("Discovery error:", err);
        setDeviceStatus("disconnected");
        connectBtn.disabled = false;
      }
    );
  } catch (err: any) {
    log(`❌ Init error: ${err.message}`);
    console.error("Init error:", err);
    setDeviceStatus("disconnected");
    connectBtn.disabled = false;
  }
});

// ─── Disconnect ───
disconnectBtn.addEventListener("click", async () => {
  await disconnectDevice();
  setDeviceStatus("disconnected");
  deviceAddressEl.textContent = "—";
  fullWalletAddress = null;
  connectBtn.disabled = false;
  log("Device disconnected");
});

// ─── WebSocket bridge ───
function connectBridge(): void {
  ws = new WebSocket(BRIDGE_URL);

  ws.onopen = () => {
    bridgeDot.classList.add("connected");
    bridgeLabel.textContent = "bridge: connected";
    log("Bridge connected");
  };

  ws.onmessage = (event) => {
    try {
      const msg: BridgeMessage = JSON.parse(event.data);
      if (msg.type === "APPROVAL_REQUIRED") {
        log(`Approval request: ${msg.payload.summary}`);
        renderApprovalCard(msg.payload);
      }
    } catch {
      log("Bad message from bridge");
    }
  };

  ws.onclose = () => {
    bridgeDot.classList.remove("connected");
    bridgeLabel.textContent = "bridge: disconnected";
    log("Bridge disconnected — reconnecting in 3s…");
    setTimeout(connectBridge, 3000);
  };

  ws.onerror = () => {
    log("Bridge connection error");
  };
}

// ─── Render approval card ───
function renderApprovalCard(request: ApprovalRequest): void {
  // Remove empty state if present
  if (!hasApprovals) {
    approvalsEl.innerHTML = "";
    hasApprovals = true;
  }

  const card = document.createElement("div");
  card.className = "approval-card";
  card.id = `trade-${request.tradeId}`;

  const txPreview = request.unsignedTxHex.length > 40
    ? `${request.unsignedTxHex.slice(0, 20)}…${request.unsignedTxHex.slice(-20)}`
    : request.unsignedTxHex;

  card.innerHTML = `
    <div class="approval-header">
      <span class="risk-badge risk-${request.riskLevel}">${request.riskLevel.replace("_", " ")}</span>
      <span class="trade-time">${new Date(request.timestamp).toLocaleTimeString("en-GB", { hour12: false })}</span>
    </div>
    <p class="trade-summary">${request.summary}</p>
    <p class="trade-tx">${txPreview}</p>
    <div class="approval-actions">
      <button class="btn btn-sign" data-trade-id="${request.tradeId}">Sign on Device</button>
    </div>
    <div class="approval-status" id="status-${request.tradeId}"></div>
  `;

  card.querySelector(".btn-sign")!.addEventListener("click", () => {
    log("Sign button clicked!");
    handleSign(request, card);
  });

  approvalsEl.prepend(card);
}

// ─── Handle signing on device ───
async function handleSign(request: ApprovalRequest, card: HTMLElement): Promise<void> {
  log(`handleSign called — deviceStatus = ${deviceStatus}`);
  if (deviceStatus !== "ready") {
    log("⚠ Device not ready — connect first");
    return;
  }

  const statusEl = card.querySelector(".approval-status")!;
  const signBtn = card.querySelector(".btn-sign") as HTMLButtonElement;

  try {
    setDeviceStatus("signing");
    signBtn.disabled = true;
    statusEl.textContent = "Check your Ledger device…";
    statusEl.className = "approval-status status-pending";
    log(`Signing ${request.tradeId.slice(0, 8)}… — check device`);

    const sessionId = getActiveSession();
    if (!sessionId) throw new Error("No active session");

    const signer = createSigner(sessionId);
    const signature = await requestSignature(
      signer,
      request.unsignedTxHex,
      (status) => {
        log(`  ↳ ${status}`);
        statusEl.textContent = status;
      }
    );

    // Approved
    setDeviceStatus("ready");
    statusEl.textContent = "✓ Approved";
    statusEl.className = "approval-status status-approved";
    card.className = "approval-card card-approved";
    log(`✓ Trade ${request.tradeId.slice(0, 8)}… approved — r=${signature.r.slice(0, 14)}…`);

    sendResult({ tradeId: request.tradeId, approved: true, signature });
  } catch (err: any) {
    setDeviceStatus("ready");
    statusEl.textContent = `✗ ${err.message}`;
    statusEl.className = "approval-status status-rejected";
    card.className = "approval-card card-rejected";
    signBtn.disabled = false;
    log(`✗ Trade ${request.tradeId.slice(0, 8)}… rejected: ${err.message}`);

    sendResult({ tradeId: request.tradeId, approved: false, error: err.message });
  }
}

// ─── Send result back to bridge ───
function sendResult(result: ApprovalResult): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "APPROVAL_RESULT", payload: result }));
  }
}

// ─── Mock trade trigger ───
mockTradeBtn.addEventListener("click", async () => {
  log("Triggering mock trade…");
  try {
    const res = await fetch(`${BRIDGE_HTTP}/mock-trade`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: "Swap 0.5 ETH → ~1,247 USDC via Uniswap V3",
        riskLevel: "requires_approval",
      }),
    });
    const data = await res.json();
    log(`Mock trade queued: ${data.tradeId.slice(0, 12)}…`);
  } catch (err: any) {
    log(`Failed to trigger mock trade: ${err.message}`);
  }
});

// ─── Intent flow (AI agents) ───
intentBtn.addEventListener("click", async () => {
  const message = intentInput.value.trim();
  if (!message) return;

  if (!fullWalletAddress) {
    log("⚠ Connect Ledger first");
    return;
  }

  intentBtn.disabled = true;
  intentStatusEl.textContent = "Running agent pipeline…";
  intentStatusEl.style.color = "var(--text-dim)";
  agentPanel.style.display = "none";
  log(`Intent: "${message}"`);
  log("Running Planner → Gatekeeper pipeline…");

  try {
    const res = await fetch(`${BRIDGE_HTTP}/intent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, walletAddress: fullWalletAddress }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    const data = await res.json();

    if (data.status === "no_action") {
      log(`Agents found no action needed: ${data.reasoning}`);
      intentStatusEl.textContent = "No action needed.";
      return;
    }

    // Show agent reasoning panel
    const verdictBadge = `<span class="badge badge-verdict-${data.assessment.verdict}">${data.assessment.verdict.replace("_", " ")}</span>`;
    agentResultEl.innerHTML = `
      <div class="agent-step">
        <div class="agent-step-label">Planner</div>
        <div class="agent-step-text">${data.agentReasoning.planner}</div>
      </div>
      <div class="agent-step">
        <div class="agent-step-label">Plan</div>
        <div class="agent-step-text">${data.plan.summary} — $${data.plan.totalEstimatedValueUsd}</div>
      </div>
      <div class="agent-step">
        <div class="agent-step-label">Gatekeeper</div>
        <div class="agent-step-text">${data.agentReasoning.gatekeeper}</div>
      </div>
      <div class="agent-step">
        <div class="agent-step-label">Verdict</div>
        <div class="agent-step-text">
          ${verdictBadge}
          risk score: ${data.assessment.riskScore}/100
          ${data.assessment.requiresLedger ? "— Ledger approval required" : ""}
        </div>
      </div>
    `;
    agentPanel.style.display = "block";

    log(`Plan: ${data.plan.summary}`);
    log(`Verdict: ${data.assessment.verdict} (risk: ${data.assessment.riskScore})`);

    // If we have a quote and it needs approval, show the Sign & Swap flow
    if (data.quoteData) {
      lastQuoteData = data.quoteData;

      const routingBadge = data.quoteData.isMevProtected
        ? `<span class="badge badge-mev">MEV Protected</span>`
        : `<span class="badge badge-classic">AMM</span>`;

      quoteResultEl.innerHTML = `
        Routing: ${routingBadge}<br>
        Risk: ${verdictBadge}<br>
        ${data.quoteData.approvalNeeded ? "⚠ Permit2 approval needed<br>" : "✓ Permit2 approved<br>"}
        <button id="sign-swap-btn" class="btn btn-sign" style="margin-top:8px;width:100%">Sign & Swap on Ledger</button>
        <div id="swap-status" style="margin-top:6px;font-size:11px;"></div>
      `;
      quoteResultEl.style.display = "block";

      document.getElementById("sign-swap-btn")!.addEventListener("click", () =>
        handleSignAndSwap(data.quoteData, message)
      );

      intentStatusEl.textContent = "Quote ready — sign on Ledger to execute.";
      intentStatusEl.style.color = "var(--green)";
      log("Quote fetched — ready to sign on Ledger");
    } else if (data.assessment.verdict === "AUTO_EXECUTE") {
      intentStatusEl.textContent = "✓ Auto-executed (low risk)";
      intentStatusEl.style.color = "var(--green)";
      log("Auto-executed — no Ledger approval needed");
    } else {
      intentStatusEl.textContent = "Plan created — no swap quote needed.";
    }
  } catch (err: any) {
    log(`❌ Intent error: ${err.message}`);
    intentStatusEl.textContent = `Error: ${err.message}`;
    intentStatusEl.style.color = "var(--red)";
  } finally {
    intentBtn.disabled = false;
  }
});

// Allow Enter key to submit intent
intentInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") intentBtn.click();
});

// ─── Quote flow ───
let lastQuoteData: any = null;

quoteBtn.addEventListener("click", async () => {
  const amountEth = swapAmountInput.value.trim();
  if (!amountEth || isNaN(Number(amountEth))) {
    log("Invalid amount");
    return;
  }

  // Get wallet address from connected device
  if (!fullWalletAddress) {
    log("⚠ Connect Ledger first to get wallet address");
    return;
  }
  const address = fullWalletAddress;

  // Convert ETH to wei using ethers for precision
  const { ethers } = await import("ethers");
  const amountWei = ethers.parseEther(amountEth).toString();

  log(`Requesting quote: ${amountEth} WETH → USDC…`);
  quoteBtn.disabled = true;
  quoteResultEl.style.display = "none";

  try {
    const res = await fetch(`${BRIDGE_HTTP}/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        walletAddress: address,
        amount: amountWei,
      }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    const data = await res.json();
    lastQuoteData = data;

    const routingBadge = data.isMevProtected
      ? `<span class="badge badge-mev">MEV Protected</span>`
      : `<span class="badge badge-classic">AMM</span>`;

    const riskBadge = `<span class="badge badge-risk-${data.riskLevel}">${data.riskLevel.replace("_", " ")}</span>`;

    quoteResultEl.innerHTML = `
      Routing: ${routingBadge}<br>
      ${data.isGasless ? "Gasless (UniswapX)<br>" : ""}
      Risk: ${riskBadge}<br>
      ${data.approvalNeeded ? "⚠ Permit2 approval needed<br>" : "✓ Permit2 approved<br>"}
      Trade ID: ${data.tradeId.slice(0, 12)}…<br>
      <button id="sign-swap-btn" class="btn btn-sign" style="margin-top:8px;width:100%">Sign & Swap on Ledger</button>
      <div id="swap-status" style="margin-top:6px;font-size:11px;"></div>
    `;
    quoteResultEl.style.display = "block";

    log(`Quote received — ${data.routing}${data.isMevProtected ? " (MEV Protected)" : ""}, risk: ${data.riskLevel}`);

    // Wire up the Sign & Swap button
    document.getElementById("sign-swap-btn")!.addEventListener("click", () => handleSignAndSwap(data, amountEth));
  } catch (err: any) {
    log(`❌ Quote error: ${err.message}`);
    quoteResultEl.innerHTML = `Error: ${err.message}`;
    quoteResultEl.style.display = "block";
  } finally {
    quoteBtn.disabled = false;
  }
});

// ─── Sign & Swap flow ───
async function handleSignAndSwap(quoteData: any, amountEth: string): Promise<void> {
  const swapStatusEl = document.getElementById("swap-status")!;
  const signSwapBtn = document.getElementById("sign-swap-btn") as HTMLButtonElement;

  if (deviceStatus !== "ready") {
    log("⚠ Device not ready — connect Ledger first");
    return;
  }

  const sessionId = getActiveSession();
  if (!sessionId) {
    log("⚠ No active Ledger session");
    return;
  }

  signSwapBtn.disabled = true;
  swapStatusEl.textContent = "";
  swapStatusEl.style.color = "";
  const { ethers } = await import("ethers");

  const totalSteps = (quoteData.approvalNeeded ? 1 : 0) + (quoteData.permitData ? 1 : 0) + 2; // +2 = sign swap tx + broadcast
  let step = 0;
  const status = (msg: string) => {
    step++;
    swapStatusEl.textContent = `[${step}/${totalSteps}] ${msg}`;
    log(msg);
  };

  try {
    const signer = createSigner(sessionId);

    // Fetch current nonce + gas from the server (which has the RPC provider)
    const nonceRes = await fetch(`${BRIDGE_HTTP}/nonce/${fullWalletAddress}`);
    const { nonce, maxFeePerGas, maxPriorityFeePerGas } = await nonceRes.json();
    let currentNonce = nonce;
    log(`Wallet nonce: ${nonce}, gas: ${(BigInt(maxFeePerGas) / 1000000000n).toString()} gwei`);

    // ── Step: Permit2 token approval (if needed) ──
    if (quoteData.approvalNeeded && quoteData.approvalTx) {
      status("Sign Permit2 approval on Ledger…");
      setDeviceStatus("signing");

      const approvalTx = ethers.Transaction.from({
        to: quoteData.approvalTx.to,
        data: quoteData.approvalTx.data,
        value: quoteData.approvalTx.value || "0x0",
        chainId: 11155111,
        gasLimit: quoteData.approvalTx.gasLimit || 100000,
        type: 2,
        maxFeePerGas,
        maxPriorityFeePerGas,
        nonce: currentNonce,
      });

      const approvalSig = await requestSignature(signer, approvalTx.unsignedSerialized, (s) => log(`  ↳ ${s}`));
      log(`✓ Approval signed — r=${approvalSig.r.slice(0, 14)}…`);

      // Assemble signed tx and broadcast
      const signedApproval = approvalTx.clone();
      signedApproval.signature = ethers.Signature.from(approvalSig);

      status("Broadcasting Permit2 approval…");
      const broadcastRes = await fetch(`${BRIDGE_HTTP}/broadcast`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signedTx: signedApproval.serialized }),
      });
      const broadcastResult = await broadcastRes.json();
      if (!broadcastRes.ok) throw new Error(broadcastResult.error);
      log(`✓ Approval broadcast: ${broadcastResult.txHash}`);

      currentNonce++;

      // Wait a bit for the approval to propagate
      log("Waiting for approval to confirm…");
      await new Promise((r) => setTimeout(r, 5000));
    }

    // ── Step: Sign Permit2 typed data (EIP-712) if present ──
    let permit2Signature: string | undefined;

    if (quoteData.permitData) {
      status("Sign Permit2 message on Ledger…");
      setDeviceStatus("signing");

      const typedData: TypedData = {
        domain: quoteData.permitData.domain,
        types: quoteData.permitData.types,
        primaryType: quoteData.permitData.primaryType || Object.keys(quoteData.permitData.types).find((k: string) => k !== "EIP712Domain") || "PermitSingle",
        message: quoteData.permitData.values,
      };

      const sig = await signTypedData(signer, typedData, (s) => log(`  ↳ ${s}`));

      permit2Signature = ethers.Signature.from({
        v: sig.v,
        r: sig.r,
        s: sig.s,
      }).serialized;

      log(`✓ Permit2 message signed`);
    }

    // ── Step: Get unsigned swap tx from Uniswap API ──
    log("Fetching swap calldata from Uniswap…");
    const swapRes = await fetch(`${BRIDGE_HTTP}/swap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quote: quoteData.quote,
        permitData: quoteData.permitData,
        signature: permit2Signature,
        routing: quoteData.routing,
      }),
    });

    if (!swapRes.ok) {
      const err = await swapRes.json();
      throw new Error(err.error || `HTTP ${swapRes.status}`);
    }

    const swapResult = await swapRes.json();

    // UniswapX: already submitted, no on-chain tx needed
    if (swapResult.type === "uniswapx") {
      log(`✓ UniswapX order submitted — orderId: ${swapResult.orderId}`);
      swapStatusEl.innerHTML = `✓ Order: ${swapResult.orderId.slice(0, 16)}…`;
      swapStatusEl.style.color = "var(--green)";
      setDeviceStatus("ready");
      return;
    }

    // Classic: we have an unsigned tx — sign it on Ledger
    const unsignedTx = swapResult.unsignedTx;

    // ── Detailed tx logging ──
    log(`── Unsigned Swap Tx from Uniswap ──`);
    log(`  to:       ${unsignedTx.to}`);
    log(`  value:    ${unsignedTx.value}`);
    log(`  gasLimit: ${unsignedTx.gasLimit || unsignedTx.gas || "not set"}`);
    log(`  data:     ${(unsignedTx.data || "").slice(0, 40)}…`);
    log(`  nonce:    ${currentNonce}`);
    log(`  maxFee:   ${maxFeePerGas} (${(BigInt(maxFeePerGas) / 1000000000n).toString()} gwei)`);
    log(`  maxPrio:  ${maxPriorityFeePerGas}`);

    // Use Uniswap API's gas estimate with a 20% buffer for safety
    const rawGasLimit = Number(unsignedTx.gasLimit || unsignedTx.gas || 350000);
    const gasLimit = Math.ceil(rawGasLimit * 1.2);
    log(`  gasLimit: ${rawGasLimit} (buffered to ${gasLimit})`);

    status("Sign swap transaction on Ledger…");
    setDeviceStatus("signing");

    const swapTx = ethers.Transaction.from({
      to: unsignedTx.to,
      data: unsignedTx.data || "0x",
      value: unsignedTx.value || "0x0",
      chainId: 11155111,
      gasLimit,
      type: 2,
      maxFeePerGas,
      maxPriorityFeePerGas,
      nonce: currentNonce,
    });

    log(`Assembled tx hash (unsigned): ${swapTx.unsignedHash}`);

    const swapSig = await requestSignature(signer, swapTx.unsignedSerialized, (s) => log(`  ↳ ${s}`));
    log(`✓ Swap tx signed`);

    // Assemble the fully signed transaction
    const signedSwap = swapTx.clone();
    signedSwap.signature = ethers.Signature.from(swapSig);
    log(`Signed tx length: ${signedSwap.serialized.length} chars`);

    // ── Step: Broadcast to Sepolia ──
    status("Broadcasting swap to Sepolia…");
    setDeviceStatus("ready");

    const broadcastRes = await fetch(`${BRIDGE_HTTP}/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signedTx: signedSwap.serialized }),
    });

    const broadcastResult = await broadcastRes.json();
    if (!broadcastRes.ok) throw new Error(broadcastResult.error);

    log(`✓ Swap broadcast! ${broadcastResult.txHash}`);
    log(`  Explorer: ${broadcastResult.explorerUrl}`);
    swapStatusEl.innerHTML = `✓ <a href="${broadcastResult.explorerUrl}" target="_blank" style="color:var(--green)">${broadcastResult.txHash.slice(0, 18)}…</a>`;
    swapStatusEl.style.color = "var(--green)";
  } catch (err: any) {
    log(`❌ Swap error: ${err.message}`);
    swapStatusEl.textContent = `✗ ${err.message}`;
    swapStatusEl.style.color = "var(--red)";
    setDeviceStatus("ready");
  } finally {
    signSwapBtn.disabled = false;
  }
}

// ─── Init ───
log("SafeSwarm × Ledger — Test Console initialized");
connectBridge();
